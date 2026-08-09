import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from './fs-store.mjs';
import { resolveProviderConfig } from './model-config.mjs';
import { CONFIG_TOML_PATH, PROVIDER_USAGE_DIR } from './paths.mjs';

export const DEEPSEEK_PROVIDER = 'deepseek';
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const PROVIDER_USAGE_TTL_MS = 60_000;
export const PROVIDER_USAGE_LOCK_STALE_MS = 30_000;

const CACHE_VERSION = 1;

export const PROVIDER_USAGE_RESULT = Object.freeze({
  SUCCESS: 'success',
  UNAUTHORIZED: 'unauthorized',
  TRANSIENT: 'transient',
  INVALID: 'invalid',
});

function finiteAmount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizeBalanceInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const currency = typeof info.currency === 'string' ? info.currency.toUpperCase() : '';
  const total = finiteAmount(info.total ?? info.total_balance);
  if (!/^[A-Z]{3}$/.test(currency) || total === null) return null;
  const granted = finiteAmount(info.granted ?? info.granted_balance);
  const toppedUp = finiteAmount(info.toppedUp ?? info.topped_up_balance);
  return { currency, total, granted, toppedUp };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || usage.kind !== 'balance') return null;
  if (
    typeof usage.label !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,31}$/.test(usage.label)
  ) {
    return null;
  }
  if (typeof usage.available !== 'boolean' || !Array.isArray(usage.balances)) return null;
  const balances = usage.balances.map(normalizeBalanceInfo).filter(Boolean);
  if (balances.length === 0) return null;
  return {
    kind: 'balance',
    label: usage.label,
    available: usage.available,
    balances,
  };
}

/** Parse DeepSeek's official /user/balance response into provider-neutral data. */
export function parseDeepSeekBalance(json) {
  if (!json || typeof json !== 'object' || typeof json.is_available !== 'boolean') return null;
  return normalizeUsage({
    kind: 'balance',
    label: 'DeepSeek',
    available: json.is_available,
    balances: json.balance_infos,
  });
}

function officialDeepSeekBaseUrl(value) {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.protocol === 'https:'
      && parsed.hostname === 'api.deepseek.com'
      && (parsed.port === '' || parsed.port === '443')
      && (pathname === '' || pathname === '/v1')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function officialDeepSeekBalanceUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'api.deepseek.com'
      && (parsed.port === '' || parsed.port === '443')
      && parsed.pathname === '/user/balance'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function credentialFingerprint(provider, apiKey) {
  return createHash('sha256')
    .update(provider)
    .update('\0')
    .update(apiKey)
    .digest('hex')
    .slice(0, 16);
}

/** Resolve deterministic, secret-free cache paths for one provider account. */
export function providerUsagePaths({
  provider,
  credentialFingerprint: fingerprint,
  providerUsageDir = PROVIDER_USAGE_DIR,
} = {}) {
  if (
    typeof provider !== 'string'
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)
    || !/^[a-f0-9]{16}$/.test(fingerprint || '')
  ) {
    return null;
  }
  const stem = `${provider}-${fingerprint}`;
  return {
    cachePath: path.join(providerUsageDir, `${stem}.json`),
    lockPath: path.join(providerUsageDir, `${stem}.lock`),
  };
}

function providerUsageAdapter(provider) {
  if (provider === DEEPSEEK_PROVIDER) {
    return {
      id: DEEPSEEK_PROVIDER,
      accepts: (config) => officialDeepSeekBaseUrl(config.baseUrl),
      request: requestDeepSeekUsage,
    };
  }
  return null;
}

function resolveProviderUsageContext({
  provider,
  configText,
  providerUsageDir = PROVIDER_USAGE_DIR,
} = {}) {
  const adapter = providerUsageAdapter(provider);
  if (!adapter) return null;
  const config = resolveProviderConfig({ provider, configText });
  if (
    !config
    || typeof config.apiKey !== 'string'
    || config.apiKey.length === 0
    || !adapter.accepts(config)
  ) {
    return null;
  }
  const fingerprint = credentialFingerprint(provider, config.apiKey);
  const paths = providerUsagePaths({ provider, credentialFingerprint: fingerprint, providerUsageDir });
  if (!paths) return null;
  return {
    adapter,
    apiKey: config.apiKey,
    target: {
      provider,
      adapter: adapter.id,
      credentialFingerprint: fingerprint,
      ...paths,
    },
  };
}

/**
 * Resolve an active provider into a supported, secret-free usage target.
 * A provider name alone is insufficient: DeepSeek also requires its official
 * base URL so an API key is never forwarded to a compatible third-party proxy.
 */
export function resolveProviderUsageTarget(options = {}) {
  return resolveProviderUsageContext(options)?.target || null;
}

/** Read and validate the exact cache belonging to a provider credential. */
export function readProviderUsageCache(target) {
  if (!target || typeof target.cachePath !== 'string') return null;
  try {
    const data = JSON.parse(fs.readFileSync(target.cachePath, 'utf8'));
    if (
      !data
      || data.version !== CACHE_VERSION
      || data.provider !== target.provider
      || data.credentialFingerprint !== target.credentialFingerprint
      || typeof data.fetchedAt !== 'number'
      || !Number.isFinite(data.fetchedAt)
    ) {
      return null;
    }
    const usage = normalizeUsage(data);
    return usage ? {
      version: CACHE_VERSION,
      provider: data.provider,
      credentialFingerprint: data.credentialFingerprint,
      fetchedAt: data.fetchedAt,
      ...usage,
    } : null;
  } catch {
    return null;
  }
}

export function isProviderUsageStale(cache, now = Date.now()) {
  return !cache
    || typeof cache.fetchedAt !== 'number'
    || !Number.isFinite(cache.fetchedAt)
    || now - cache.fetchedAt > PROVIDER_USAGE_TTL_MS;
}

/** Atomically persist normalized, non-secret provider usage. */
export function writeProviderUsageCache(usage, target, {
  now = Date.now(),
} = {}) {
  const normalized = normalizeUsage(usage);
  const expectedPaths = target && providerUsagePaths({
    provider: target.provider,
    credentialFingerprint: target.credentialFingerprint,
    providerUsageDir: path.dirname(target.cachePath),
  });
  if (
    !normalized
    || !expectedPaths
    || typeof now !== 'number'
    || !Number.isFinite(now)
    || expectedPaths.cachePath !== target.cachePath
    || expectedPaths.lockPath !== target.lockPath
  ) {
    return false;
  }
  try {
    atomicWriteFile(target.cachePath, JSON.stringify({
      version: CACHE_VERSION,
      provider: target.provider,
      credentialFingerprint: target.credentialFingerprint,
      fetchedAt: now,
      ...normalized,
    }));
    return true;
  } catch {
    return false;
  }
}

function readProviderUsageLock(lockPath) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return lock && typeof lock === 'object' ? lock : null;
  } catch {
    return null;
  }
}

/** Acquire an account-scoped detached-refresh lock atomically. */
export function acquireProviderUsageLock({
  lockPath,
  now = Date.now(),
  token = `${process.pid}-${now}-${randomUUID()}`,
} = {}) {
  if (typeof lockPath !== 'string' || !lockPath) return null;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const current = readProviderUsageLock(lockPath);
  if (
    current
    && typeof current.at === 'number'
    && now - current.at < PROVIDER_USAGE_LOCK_STALE_MS
  ) {
    return null;
  }
  if (current || fs.existsSync(lockPath)) {
    const stalePath = `${lockPath}.stale-${token}`;
    try {
      fs.renameSync(lockPath, stalePath);
      try { fs.unlinkSync(stalePath); } catch { /* best effort */ }
    } catch {
      // The exclusive hard link below decides which contender owns refresh.
    }
  }

  const tmpPath = `${lockPath}.tmp-${token}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, at: now, token }), { mode: 0o600 });
    fs.linkSync(tmpPath, lockPath);
    return token;
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* no temp to clean */ }
  }
}

/** Remove a provider refresh lock only when the caller still owns it. */
export function releaseProviderUsageLock(lockPath, token = null) {
  try {
    const current = readProviderUsageLock(lockPath);
    if (token !== null) {
      if (!current || current.token !== token) return false;
    } else if (current && typeof current.token === 'string') {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** Spawn a detached provider refresh when its account-scoped cache is stale. */
export function ensureFreshProviderUsage({
  scriptPath,
  target,
  cachedUsage = undefined,
  now = Date.now(),
  spawnImpl = spawn,
  tokenFactory = randomUUID,
} = {}) {
  let lockToken = null;
  try {
    if (!target) return false;
    const cache = cachedUsage === undefined ? readProviderUsageCache(target) : cachedUsage;
    if (!isProviderUsageStale(cache, now)) return false;
    lockToken = acquireProviderUsageLock({
      lockPath: target.lockPath,
      now,
      token: `${process.pid}-${now}-${tokenFactory()}`,
    });
    if (!lockToken) return false;
    const child = spawnImpl(process.execPath, [
      scriptPath,
      '--refresh-provider-usage',
      target.provider,
      target.credentialFingerprint,
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, KIMI_HUD_PROVIDER_USAGE_LOCK_TOKEN: lockToken },
    });
    if (typeof child.once === 'function') {
      child.once('error', () => releaseProviderUsageLock(target.lockPath, lockToken));
    }
    child.unref();
    return true;
  } catch {
    if (target && lockToken) releaseProviderUsageLock(target.lockPath, lockToken);
    return false;
  }
}

/** Fetch one DeepSeek balance response without mutating any local state. */
export async function requestDeepSeekUsage({
  apiKey,
  url = DEEPSEEK_BALANCE_URL,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialDeepSeekBalanceUrl(url)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID };
  }
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error('provider usage request timed out'));
    }, timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([
      fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: ctrl.signal,
      }),
      timeout,
    ]);
  } catch {
    return { status: PROVIDER_USAGE_RESULT.TRANSIENT };
  } finally {
    clearTimeout(timer);
  }
  if (!response || typeof response.status !== 'number' || typeof response.ok !== 'boolean') {
    return { status: PROVIDER_USAGE_RESULT.INVALID };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: PROVIDER_USAGE_RESULT.UNAUTHORIZED };
  }
  if (response.status === 429 || response.status >= 500) {
    return { status: PROVIDER_USAGE_RESULT.TRANSIENT };
  }
  if (!response.ok) return { status: PROVIDER_USAGE_RESULT.INVALID };
  try {
    const parsed = parseDeepSeekBalance(await response.json());
    return parsed
      ? { status: PROVIDER_USAGE_RESULT.SUCCESS, parsed }
      : { status: PROVIDER_USAGE_RESULT.INVALID };
  } catch {
    return { status: PROVIDER_USAGE_RESULT.INVALID };
  }
}

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* absent or unreadable */ }
}

/**
 * Refresh a supported provider cache. The current config is re-resolved in
 * the child, and the expected fingerprint prevents a key switch from writing
 * old-account data into the new account's cache.
 */
export async function refreshProviderUsage({
  provider,
  expectedFingerprint = null,
  configPath = CONFIG_TOML_PATH,
  providerUsageDir = PROVIDER_USAGE_DIR,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
  lockToken = null,
} = {}) {
  const expectedPaths = providerUsagePaths({
    provider,
    credentialFingerprint: expectedFingerprint,
    providerUsageDir,
  });
  let lockPath = expectedPaths?.lockPath || null;
  try {
    let configText = '';
    try { configText = fs.readFileSync(configPath, 'utf8'); } catch { /* missing config */ }
    const context = resolveProviderUsageContext({ provider, configText, providerUsageDir });
    if (!context || (expectedFingerprint && context.target.credentialFingerprint !== expectedFingerprint)) {
      if (expectedPaths) removeFile(expectedPaths.cachePath);
      return false;
    }
    lockPath = context.target.lockPath;
    const result = await context.adapter.request({
      apiKey: context.apiKey,
      timeoutMs,
      fetchImpl,
    });
    if (result.status === PROVIDER_USAGE_RESULT.SUCCESS) {
      return writeProviderUsageCache(result.parsed, context.target);
    }
    if (result.status !== PROVIDER_USAGE_RESULT.TRANSIENT) {
      removeFile(context.target.cachePath);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (lockPath) releaseProviderUsageLock(lockPath, lockToken);
  }
}
