// Provider usage facade: account-scoped cache, refresh lock, failure backoff,
// and adapter selection. The provider-specific request/parse code lives in
// src/provider-usage/, one module per provider surface:
//
//   provider-usage/common.mjs       shared normalizer, result vocabulary, URL discipline
//   provider-usage/deepseek.mjs     api.deepseek.com balance
//   provider-usage/opencode-go.mjs  opencode.ai subscription windows
//   provider-usage/zhipu.mjs        GLM Coding Plan windows + CN balance fallback
//   provider-usage/moonshot.mjs     Moonshot Open Platform balance (intl + CN)
//   provider-usage/minimax.mjs      MiniMax token-plan windows / balance by key prefix
//   provider-usage/synthetic.mjs    synthetic.new subscription windows
//   provider-usage/chutes.mjs       Chutes subscription windows
//   provider-usage/openrouter.mjs   OpenRouter spending-cap windows
//   provider-usage/deepinfra.mjs    DeepInfra prepaid balance
//   provider-usage/venice.mjs       Venice billing balance (admin key)
//   provider-usage/ollama.mjs       Ollama Cloud windows / balance
//   provider-usage/command-code.mjs Command Code credit windows + balance
//   provider-usage/clinepass.mjs    ClinePass plan windows
//   provider-usage/kilo.mjs         Kilo Gateway prepaid balance
//   provider-usage/vercel-ai-gateway.mjs  Vercel AI Gateway credits
//
// Every adapter module exports one frozen `ADAPTER`; the contract is spelled
// out at the top of common.mjs. An adapter is selected by the configured
// provider's `base_url` host — never by the provider's name — so a new adapter
// is a new file plus one line in ADAPTERS. Adding an adapter must not require
// touching any other adapter.
//
// This module stays the public facade: the parsers, request helpers and
// provider constants that existed here before the split are re-exported
// unchanged, so consumers and tests keep importing from this path.

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from './fs-store.mjs';
import { resolveProviderConfig } from './model-config.mjs';
import {
  clearRefreshState,
  isRefreshBlocked,
  recordRefreshFailure,
} from './request-guard.mjs';
import { CONFIG_TOML_PATH, PROVIDER_USAGE_DIR } from './paths.mjs';
import { ADAPTER as deepSeekAdapter } from './provider-usage/deepseek.mjs';
import { ADAPTER as openCodeGoAdapter } from './provider-usage/opencode-go.mjs';
import { ADAPTER as zhipuAdapter } from './provider-usage/zhipu.mjs';
import { ADAPTER as moonshotAdapter } from './provider-usage/moonshot.mjs';
import { ADAPTER as miniMaxAdapter } from './provider-usage/minimax.mjs';
import { ADAPTER as syntheticAdapter } from './provider-usage/synthetic.mjs';
import { ADAPTER as chutesAdapter } from './provider-usage/chutes.mjs';
import { ADAPTER as openRouterAdapter } from './provider-usage/openrouter.mjs';
import { ADAPTER as deepInfraAdapter } from './provider-usage/deepinfra.mjs';
import { ADAPTER as veniceAdapter } from './provider-usage/venice.mjs';
import { ADAPTER as ollamaAdapter } from './provider-usage/ollama.mjs';
import { ADAPTER as commandCodeAdapter } from './provider-usage/command-code.mjs';
import { ADAPTER as clinePassAdapter } from './provider-usage/clinepass.mjs';
import { ADAPTER as kiloAdapter } from './provider-usage/kilo.mjs';
import { ADAPTER as vercelAiGatewayAdapter } from './provider-usage/vercel-ai-gateway.mjs';
import { PROVIDER_USAGE_RESULT, normalizeUsage } from './provider-usage/common.mjs';

export {
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_USAGE_URL,
  parseOpenCodeGoUsage,
  requestOpenCodeGoUsage,
} from './provider-usage/opencode-go.mjs';
export {
  DEEPSEEK_BALANCE_URL,
  DEEPSEEK_PROVIDER,
  parseDeepSeekBalance,
  requestDeepSeekUsage,
} from './provider-usage/deepseek.mjs';
export {
  ZHIPU_CN_BALANCE_URL,
  ZHIPU_CN_USAGE_URL,
  ZHIPU_INTL_USAGE_URL,
  ZHIPU_PROVIDER,
  ZHIPU_PROVIDER_ALIASES,
  parseZhipuBalance,
  parseZhipuQuota,
  requestZhipuUsage,
} from './provider-usage/zhipu.mjs';
export { PROVIDER_USAGE_RESULT } from './provider-usage/common.mjs';

export const PROVIDER_USAGE_TTL_MS = 60_000;
export const PROVIDER_USAGE_LOCK_STALE_MS = 30_000;

const CACHE_VERSION = 1;

/**
 * Every registered usage adapter, in probe order. Selection walks this list and
 * stops at the first adapter whose `accepts(config)` returns endpoints, so one
 * host may be claimed by one adapter only; a second claim would make the winner
 * depend on registry order. Exported so the registry invariants (unique ids,
 * pairwise-disjoint `hosts`, contract shape) are testable against the shipped
 * list rather than a copy of it.
 */
export const ADAPTERS = Object.freeze([
  deepSeekAdapter,
  openCodeGoAdapter,
  zhipuAdapter,
  moonshotAdapter,
  miniMaxAdapter,
  syntheticAdapter,
  chutesAdapter,
  openRouterAdapter,
  deepInfraAdapter,
  veniceAdapter,
  ollamaAdapter,
  commandCodeAdapter,
  clinePassAdapter,
  kiloAdapter,
  vercelAiGatewayAdapter,
]);

/**
 * Pick the adapter that serves a provider config by its official base_url
 * host. Returns null when no adapter accepts the URL (a proxy, a non-https
 * URL, or a provider that has no usage endpoint at all).
 * @param {{baseUrl: string|null}|null} config result of resolveProviderConfig
 * @returns {{adapter: object, endpoints: object}|null}
 */
export function selectProviderUsageAdapter(config) {
  if (!config) return null;
  for (const adapter of ADAPTERS) {
    const endpoints = adapter.accepts(config);
    if (endpoints) return { adapter, endpoints };
  }
  return null;
}

function credentialFingerprint(provider, apiKey) {
  return createHash('sha256')
    .update(provider)
    .update('\0')
    .update(apiKey)
    .digest('hex')
    .slice(0, 16);
}

/** Resolve deterministic, secret-free cache, lock and backoff-state paths for one provider account. */
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
    statePath: path.join(providerUsageDir, `${stem}.state.json`),
  };
}

/**
 * Resolve the request credential the way the host does since Kimi Code
 * 2.0.1: a provider declares either a literal `api_key` or an `api_key_env`
 * variable name — the two are mutually exclusive — and the variable is read
 * fresh per request. An unset or empty variable fails closed without
 * falling back to any other credential, mirroring the host's `config.invalid`.
 * @param {{apiKey: string|null, apiKeyEnv: string|null}} config
 * @param {NodeJS.ProcessEnv|object} env
 * @returns {string|null}
 */
function resolveCredential(config, env) {
  const declared = [config.apiKey, config.apiKeyEnv].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  if (declared.length !== 1) return null;
  if (declared[0] === config.apiKey) return declared[0];
  const value = env?.[declared[0]];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveProviderUsageContext({
  provider,
  configText,
  env = process.env,
  providerUsageDir = PROVIDER_USAGE_DIR,
} = {}) {
  const config = resolveProviderConfig({ provider, configText });
  if (!config) return null;
  const selection = selectProviderUsageAdapter(config);
  const apiKey = resolveCredential(config, env);
  if (!selection || !apiKey) return null;
  const fingerprint = credentialFingerprint(provider, apiKey);
  const paths = providerUsagePaths({ provider, credentialFingerprint: fingerprint, providerUsageDir });
  if (!paths) return null;
  return {
    adapter: selection.adapter,
    apiKey,
    endpoints: selection.endpoints,
    target: {
      provider,
      // The account label shown to diagnostics. It has always been the
      // configured provider name (adapters no longer contribute a name), and
      // the cache/lock buckets below stay keyed by that name.
      adapter: provider,
      // The adapter module that accepted this provider's base_url host. This
      // is what host-based selection resolves to and is independent of the
      // provider's name.
      adapterId: selection.adapter.id,
      credentialFingerprint: fingerprint,
      ...paths,
    },
  };
}

/**
 * Resolve a configured provider into a supported, secret-free usage target.
 * A provider name alone is insufficient: the provider table must exist and
 * one registered adapter must accept its official base URL (see `hosts` on
 * each adapter in src/provider-usage/) so an API key is never forwarded to a
 * compatible third-party proxy.
 * The credential may be a literal `api_key` or an `api_key_env` variable read
 * from `env` (default `process.env`) at resolution time.
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
    || expectedPaths.statePath !== target.statePath
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

/** Spawn a detached provider refresh when its account-scoped cache is stale
 * and no persisted failure backoff forbids it. Backoff state lives next to
 * the cache under the same account fingerprint, so concurrent processes share
 * one retry schedule per credential; the fingerprint is also compared against
 * the state's context tag, so a window recorded by another account never
 * blocks this one even if a state file were to change hands.
 */
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
    if (isRefreshBlocked(target.statePath, now, target.credentialFingerprint)) return false;
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

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* absent or unreadable */ }
}

/**
 * Refresh a supported provider cache. The current config is re-resolved in
 * the child, and the expected fingerprint prevents a key switch from writing
 * old-account data into the new account's cache. Failed attempts persist a
 * failure record (category + next attempt time) beside the cache; success
 * clears it. The next-attempt time is stamped from a clock read after the
 * request settles, so a request that burns its whole deadline still backs off
 * from the moment it actually failed (the honored Retry-After window
 * included) instead of from an already-stale request start. Each record is
 * tagged with the owning credential fingerprint and kept in a per-fingerprint
 * state file, so one key's failures never throttle another key's refresh.
 */
export async function refreshProviderUsage({
  provider,
  expectedFingerprint = null,
  configPath = CONFIG_TOML_PATH,
  env = process.env,
  providerUsageDir = PROVIDER_USAGE_DIR,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
  lockToken = null,
  now = Date.now(),
  clock = Date.now,
  jitter = Math.random,
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
    const context = resolveProviderUsageContext({ provider, configText, env, providerUsageDir });
    if (!context || (expectedFingerprint && context.target.credentialFingerprint !== expectedFingerprint)) {
      if (expectedPaths) {
        removeFile(expectedPaths.cachePath);
        removeFile(expectedPaths.statePath);
      }
      return false;
    }
    lockPath = context.target.lockPath;
    const result = await context.adapter.request({
      apiKey: context.apiKey,
      endpoints: context.endpoints,
      timeoutMs,
      fetchImpl,
    });
    if (result.status === PROVIDER_USAGE_RESULT.SUCCESS) {
      const written = writeProviderUsageCache(result.parsed, context.target, { now });
      if (written) clearRefreshState(context.target.statePath);
      return written;
    }
    recordRefreshFailure({
      statePath: context.target.statePath,
      category: result.category,
      retryAfterSeen: result.retryAfterSeen === true,
      retryAfterMs: result.retryAfterMs ?? null,
      now: clock(),
      jitter,
      contextKey: context.target.credentialFingerprint,
    });
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
