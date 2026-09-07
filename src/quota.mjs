import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './fs-store.mjs';
import {
  MANAGED_KIMI_PROVIDER,
  decodedStringValue,
  findProviderTable,
} from './model-config.mjs';
import {
  HUD_DIR,
  KIMI_HOME,
  CONFIG_TOML_PATH,
  CREDENTIALS_PATH,
  QUOTA_CACHE_PATH,
  QUOTA_REFRESH_STATE_PATH,
  REFRESH_LOCK_PATH,
  resolveRuntimePaths,
} from './paths.mjs';
import {
  MAX_RESPONSE_BYTES,
  REQUEST_CATEGORY,
  clearRefreshState,
  isRefreshBlocked,
  recordRefreshFailure,
  requestJsonWithLimits,
  shortDigest,
} from './request-guard.mjs';

export { HUD_DIR, CREDENTIALS_PATH, QUOTA_CACHE_PATH, QUOTA_REFRESH_STATE_PATH, REFRESH_LOCK_PATH };
export const USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
export const GLOBAL_USAGES_URL = 'https://api.kimi.ai/coding/v1/usages';
export const QUOTA_TTL_MS = 60_000;
export const LOCK_STALE_MS = 30_000;

/**
 * On-disk quota cache schema. Version 2 adds the non-reversible context tag
 * (`contextKey`, derived from the credential slot + endpoint) that lets the
 * render data plane tell whether the figures still belong to the account and
 * region the config currently points at. Version-1 caches (no version, no
 * contextKey) are deliberately not readable as current quota: they cannot be
 * attributed to a context, so they render nothing until the next successful
 * refresh rewrites a tagged cache.
 */
export const QUOTA_CACHE_VERSION = 2;

/**
 * Freshness contract shared by the scheduler and the renderer.
 *
 *  - fresh   (age <= QUOTA_TTL_MS): rendered as the current figure;
 *  - stale   (TTL < age <= QUOTA_STALE_MAX_MS): still usable — shown dimmed
 *    with an explicit `[stale]` marker so a monochrome terminal can tell it
 *    apart from fresh data while a background refresh is throttled/offline;
 *  - expired (age > QUOTA_STALE_MAX_MS, or a fetchedAt so far in the future
 *    that the clock must have moved): hidden entirely — the figure is never
 *    presented as current once it can no longer be trusted.
 *
 * QUOTA_STALE_MAX_MS is one week, the longest horizon any returned window
 * (the weekly summary) can legitimately describe before its own reset, so a
 * cache older than that is always superseded rather than merely unrefreshed.
 * The future-skew allowance lets a small clock step forward (NTP correction)
 * not hide a just-written cache, while a large rollback turns the cache into
 * "needs refresh" instead of pinning it fresh forever.
 */
export const QUOTA_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const QUOTA_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Shape of every context tag: 16 lowercase hex chars (sha-256 prefix). */
export const QUOTA_CONTEXT_KEY_RE = /^[0-9a-f]{16}$/;

export const QUOTA_AGE = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  EXPIRED: 'expired',
});

export const QUOTA_RESULT = Object.freeze({
  SUCCESS: 'success',
  UNAUTHORIZED: 'unauthorized',
  TRANSIENT: 'transient',
  INVALID: 'invalid',
});

/**
 * Derive a short label from a rate-limit window descriptor.
 * 300 minutes -> "5h", TIME_UNIT_HOUR -> "<n>h", TIME_UNIT_DAY -> "<n>d".
 * @param {object} window
 * @returns {string|null}
 */
export function deriveWindowLabel(window) {
  if (!window || typeof window !== 'object') return null;
  const duration = Number(window.duration);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  switch (window.timeUnit) {
    case 'TIME_UNIT_MINUTE':
      if (duration % 1440 === 0) return `${duration / 1440}d`;
      if (duration % 60 === 0) return `${duration / 60}h`;
      return `${duration}m`;
    case 'TIME_UNIT_HOUR':
      if (duration % 24 === 0) return `${duration / 24}d`;
      return `${duration}h`;
    case 'TIME_UNIT_DAY':
      return `${duration}d`;
    default:
      return null;
  }
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Values treated as "the field was not reported" instead of a numeric zero.
 * JSON null and empty/whitespace strings are how an unset counter can arrive
 * in a tolerant payload; coercing them through Number() would silently turn a
 * missing `used` into a fabricated zero. Upstream (packages/oauth managed-usage
 * toUsageRow) documents `used` as an always-present decimal string, so this
 * branch only ever sees hypothetical/hand-built shapes.
 */
function isAbsentLike(v) {
  return v === null
    || v === undefined
    || typeof v === 'boolean'
    || (typeof v === 'string' && v.trim() === '');
}

function quotaValues(detail) {
  const limit = toNum(detail.limit);
  let used = null;
  if (!isAbsentLike(detail.used)) used = toNum(detail.used);
  if (used === null) {
    const remaining = toNum(detail.remaining);
    // Bonus/overflow quota can report remaining > limit; clamp to zero usage
    // instead of rejecting, but fail closed on negative (suspicious) data.
    if (limit !== null && remaining !== null && remaining >= 0) {
      used = Math.min(Math.max(limit - remaining, 0), limit);
    }
  }
  return { used, limit };
}

/**
 * Parse the /usages API response into the cache shape.
 * Lenient: numeric fields may be strings, omitted zero usage is derived from
 * limit - remaining, and detail may live on the item top level.
 * Returns null when nothing usable is present.
 * @param {object} json
 * @returns {{weekly: object, windows: object[]}|null}
 */
export function parseQuotaPayload(json) {
  if (!json || typeof json !== 'object') return null;
  let weekly = null;
  const u = json.usage;
  if (u && typeof u === 'object') {
    const { used, limit } = quotaValues(u);
    if (used !== null && limit !== null && limit > 0) {
      weekly = { used, limit, resetAt: typeof u.resetTime === 'string' ? u.resetTime : null };
    }
  }
  const windows = [];
  if (Array.isArray(json.limits)) {
    for (const item of json.limits) {
      if (!item || typeof item !== 'object') continue;
      const detail = (item.detail && typeof item.detail === 'object') ? item.detail : item;
      const { used, limit } = quotaValues(detail);
      const label = deriveWindowLabel(item.window);
      if (used === null || limit === null || limit <= 0 || !label) continue;
      windows.push({
        label,
        used,
        limit,
        resetAt: typeof detail.resetTime === 'string' ? detail.resetTime : null,
      });
    }
  }
  if (!weekly && windows.length === 0) return null;
  return { weekly, windows };
}

/**
 * Read the quota cache file. Never throws.
 *
 * Only schema-version 2 caches — those carrying a `contextKey` tag — are
 * returned. Anything else (legacy version-1 files, hand-written shapes) is
 * treated as absent: it cannot be attributed to the current credential slot
 * and endpoint, so it must never surface as current quota. The first
 * successful refresh rewrites a tagged cache in place.
 * @param {string} [cachePath]
 * @returns {{fetchedAt: number, contextKey: string, weekly: object|null,
 *   windows: object[]}|null}
 */
export function readQuotaCache(cachePath = QUOTA_CACHE_PATH) {
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (data.version !== QUOTA_CACHE_VERSION) return null;
    if (typeof data.contextKey !== 'string' || !QUOTA_CONTEXT_KEY_RE.test(data.contextKey)) {
      return null;
    }
    if (typeof data.fetchedAt !== 'number' || !Number.isFinite(data.fetchedAt)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Classify a cache's age into the fresh / stale / expired contract shared by
 * the renderer and the refresh scheduler. A missing cache or a non-finite
 * fetchedAt is expired (nothing trustworthy to show); a fetchedAt far in the
 * future means the clock moved backwards, which is likewise untrusted.
 * @param {object|null} cache
 * @param {number} [now]
 * @returns {{state: string, ageMs: number|null}}
 */
export function quotaAge(cache, now = Date.now()) {
  if (!cache || typeof cache.fetchedAt !== 'number' || !Number.isFinite(cache.fetchedAt)) {
    return { state: QUOTA_AGE.EXPIRED, ageMs: null };
  }
  const ageMs = now - cache.fetchedAt;
  if (ageMs < -QUOTA_CLOCK_SKEW_MS) return { state: QUOTA_AGE.EXPIRED, ageMs };
  const age = ageMs < 0 ? 0 : ageMs;
  if (age <= QUOTA_TTL_MS) return { state: QUOTA_AGE.FRESH, ageMs };
  if (age <= QUOTA_STALE_MAX_MS) return { state: QUOTA_AGE.STALE, ageMs };
  return { state: QUOTA_AGE.EXPIRED, ageMs };
}

/**
 * True when the cache needs a background refresh: missing, older than the
 * fresh window, or stamped so far in the future that the clock must have
 * moved backwards. A cache inside the stale-but-usable window is still
 * refresh-worthy — the scheduler keeps trying while the renderer may keep
 * showing the dimmed figure until the retry backoff lets it through.
 * @param {object|null} cache
 * @param {number} [now]
 * @returns {boolean}
 */
export function isQuotaStale(cache, now = Date.now()) {
  if (!cache) return true;
  return quotaAge(cache, now).state !== QUOTA_AGE.FRESH;
}

/**
 * Atomically write a schema-version-2, context-tagged quota cache (tmp file +
 * rename). Refuses to persist an unattributed cache: every on-disk quota file
 * must be able to answer "which credential slot and endpoint does this belong
 * to?". Never throws.
 * @param {object} parsed result of parseQuotaPayload
 * @param {string} [cachePath]
 * @param {object} [opts]
 * @param {number} [opts.now] fetchedAt stamp; defaults to the real clock
 * @param {string} [opts.contextKey] 16-hex digest of the credential slot +
 *   endpoint this payload was fetched from
 * @returns {boolean} true when the cache was written
 */
export function writeQuotaCache(parsed, cachePath = QUOTA_CACHE_PATH, {
  now = Date.now(),
  contextKey = null,
} = {}) {
  if (typeof contextKey !== 'string' || !QUOTA_CONTEXT_KEY_RE.test(contextKey)) return false;
  if (!parsed || typeof parsed !== 'object') return false;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const body = JSON.stringify({
      version: QUOTA_CACHE_VERSION,
      contextKey,
      fetchedAt: now,
      ...parsed,
    });
    atomicWriteFile(cachePath, body);
    return true;
  } catch {
    return false;
  }
}

/**
 * The non-reversible context tag for one credential slot + endpoint pair.
 * The same digest that keys refresh backoff state (request-guard.mjs) tags
 * the cache, so backoff isolation and cache attribution always agree.
 * @param {string} credentialsPath
 * @param {string} url
 * @returns {string}
 */
export function quotaContextKeyFor(credentialsPath, url) {
  return shortDigest(credentialsPath, url);
}

/**
 * The context tag the current config/env expects, derived without any file
 * I/O when `configText` is supplied (the render hot path passes the config
 * text it already read this frame). Uses the same fail-closed resolution as
 * the detached refresh, so both sides agree on what "the current context" is.
 * Never throws; returns the 16-hex digest of the resolved credential slot and
 * endpoint.
 * @param {object} [opts]
 * @param {object} [opts.env] same env override source as resolveQuotaEndpoints
 * @param {string} [opts.configPath] config.toml path read when configText is
 *   absent (detached refresh only — never called on the hot path)
 * @param {string} [opts.configText] pre-read config.toml text (hot path)
 * @param {string} [opts.kimiHome] Kimi home dir holding credentials/
 * @returns {string}
 */
export function resolveQuotaContextKey({
  env = {},
  configPath = CONFIG_TOML_PATH,
  configText = undefined,
  kimiHome = KIMI_HOME,
} = {}) {
  const endpoints = resolveQuotaEndpoints({ env, configPath, configText, kimiHome });
  return quotaContextKeyFor(endpoints.credentialsPath, endpoints.url);
}

/**
 * True when the cache is a schema-version-2 cache tagged for the given
 * context. The render data plane calls this before presenting quota figures:
 * a cache from another credential slot or region is never shown as the
 * current account's numbers.
 * @param {object|null} cache
 * @param {string|null} contextKey
 * @returns {boolean}
 */
export function quotaCacheMatchesContext(cache, contextKey) {
  return !!cache
    && cache.version === QUOTA_CACHE_VERSION
    && typeof cache.contextKey === 'string'
    && cache.contextKey === contextKey;
}

function readRefreshLock(lockPath) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return lock && typeof lock === 'object' ? lock : null;
  } catch {
    return null;
  }
}

/**
 * Atomically acquire the detached-refresh lock. A stale lock is first renamed
 * out of the way, so competing render processes still race on an atomic
 * create rather than overwriting one another. The lock body is written to a
 * same-directory temp file and hard-linked into place (EEXIST when another
 * contender won), so the lock never appears with partial content.
 * @returns {string|null} ownership token, or null when another refresh owns it
 */
export function acquireQuotaLock({
  lockPath = REFRESH_LOCK_PATH,
  now = Date.now(),
  token = `${process.pid}-${now}-${randomUUID()}`,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const current = readRefreshLock(lockPath);
  if (current && typeof current.at === 'number' && now - current.at < LOCK_STALE_MS) {
    return null;
  }
  if (current || fs.existsSync(lockPath)) {
    const stalePath = `${lockPath}.stale-${token}`;
    try {
      fs.renameSync(lockPath, stalePath);
      try { fs.unlinkSync(stalePath); } catch { /* best effort */ }
    } catch {
      // Another process either removed or replaced it. The exclusive create
      // below decides which contender owns the new refresh.
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

/** Remove a lock only when it is still owned by the supplied refresh. */
export function releaseQuotaLock(lockPath = REFRESH_LOCK_PATH, token = null) {
  try {
    const current = readRefreshLock(lockPath);
    if (token !== null) {
      if (!current || current.token !== token) return false;
    } else if (current && typeof current.token === 'string') {
      // A legacy/direct caller must not remove a newer token-owned lock.
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * If the cache is stale and no persisted failure backoff forbids it, spawn a
 * detached background refresh and return immediately. A lock file (pid +
 * timestamp) prevents concurrent refreshes; locks older than LOCK_STALE_MS
 * are treated as stale and overwritten. The backoff state file records the
 * last failure's next-attempt time, so every render process in the same HUD
 * home shares one retry schedule — per context: when `contextKey` is
 * supplied, a window recorded by a different credential slot or region never
 * blocks the spawn. Pass no statePath to disable the backoff gate. Never
 * throws, never blocks on the network.
 * @param {object} [opts]
 * @param {string|null} [opts.contextKey] digest of the credential slot +
 *   endpoint the current config resolves to; omit for the legacy
 *   shared-window gate
 * @returns {boolean} true when a refresh was spawned
 */
export function ensureFreshQuota({
  cachePath = QUOTA_CACHE_PATH,
  lockPath = REFRESH_LOCK_PATH,
  statePath = null,
  contextKey = null,
  scriptPath,
  now = Date.now(),
  spawnImpl = spawn,
  tokenFactory = randomUUID,
  cachedQuota = undefined,
} = {}) {
  let lockToken = null;
  try {
    const cache = cachedQuota === undefined ? readQuotaCache(cachePath) : cachedQuota;
    if (!isQuotaStale(cache, now)) return false;
    if (isRefreshBlocked(statePath, now, contextKey)) return false;
    lockToken = acquireQuotaLock({
      lockPath,
      now,
      token: `${process.pid}-${now}-${tokenFactory()}`,
    });
    if (!lockToken) return false;
    const child = spawnImpl(process.execPath, [scriptPath, '--refresh-quota'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, KIMI_HUD_QUOTA_LOCK_TOKEN: lockToken },
    });
    if (typeof child.once === 'function') {
      child.once('error', () => releaseQuotaLock(lockPath, lockToken));
    }
    child.unref();
    return true;
  } catch {
    if (lockToken) releaseQuotaLock(lockPath, lockToken);
    return false;
  }
}

// The token only ever leaves the process toward these two hosts.
const OFFICIAL_USAGES_HOSTS = new Set(['api.kimi.com', 'api.kimi.ai']);

// Dual-region model (Kimi Code 0.38.0; upstream packages/oauth/src/region.ts
// and managed-kimi-code.ts @ 0999454b): 'mainland-cn' (default) and 'global'.
// A global login persists base_url = https://api.kimi.ai/coding/v1 and an
// oauth ref { storage, key: 'oauth/kimi-code-env-<sha256(JSON({oauthHost,
// baseUrl})) first 16 hex>', oauth_host: 'https://auth.kimi.ai' } under
// [providers."managed:kimi-code"] in config.toml; a mainland login persists
// no oauth_host and keeps the default 'oauth/kimi-code' slot. The
// install-channel <home>/region marker is deliberately not consulted:
// upstream only honors it before the first login, and a read-only HUD cannot
// observe that state.
const REGION_PROFILES = [
  { oauthHost: 'https://auth.kimi.com', baseUrl: 'https://api.kimi.com/coding/v1' },
  { oauthHost: 'https://auth.kimi.ai', baseUrl: 'https://api.kimi.ai/coding/v1' },
];

function normalizeEndpoint(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\/+$/, '');
  return normalized || null;
}

/**
 * Raw text of the [providers."managed:kimi-code".oauth] sub-table, or null.
 * Same canonical-format assumption as findProviderTable: the host's TOML
 * writer quotes the provider name and writes one key per line.
 * @param {string} text config.toml content
 * @returns {string|null}
 */
function managedOAuthTable(text) {
  const re = /\[providers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\.oauth\]\s*\n([\s\S]*?)(?=\n\[|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if ((m[1] || m[2]) === MANAGED_KIMI_PROVIDER) return m[3];
  }
  return null;
}

/**
 * Map an oauth ref key to its credential file: strip the 'oauth/' prefix and
 * append '.json' inside the credentials directory. Only the two upstream key
 * shapes are honored ('oauth/kimi-code' and 'oauth/kimi-code-env-<16 hex>');
 * a missing or abnormal key falls back to the default slot. The whitelist
 * regex doubles as path sanitization — no separator or dot can reach the
 * filename.
 * @param {string|null} key
 * @param {string} credentialsDir
 * @returns {string}
 */
function credentialsPathForKey(key, credentialsDir) {
  const m = typeof key === 'string'
    ? key.match(/^oauth\/(kimi-code(?:-env-[0-9a-f]{16})?)$/)
    : null;
  return path.join(credentialsDir, `${m ? m[1] : 'kimi-code'}.json`);
}

/**
 * Resolve the quota refresh endpoints — which credential file to read and
 * which official /usages URL to call — from env and config.toml. Only the
 * detached --refresh-quota path may call this; the render hot path reads the
 * cache only and must not parse config.toml.
 *
 * Fail closed by contract: the URL only ever leaves here as one of the two
 * official region endpoints. Any custom/unknown oauth host or base_url
 * (internal proxies, mirrors, typos) and any host/base pair pinned to
 * different regions falls back to the mainland default; requestQuota
 * re-checks the same whitelist before any token is sent. Never throws,
 * never prints.
 *
 * @param {object} [opts]
 * @param {object} [opts.env] overrides: KIMI_CODE_OAUTH_HOST / KIMI_OAUTH_HOST
 *   pin the region, KIMI_CODE_BASE_URL the base URL (all before config.toml)
 * @param {string} [opts.configPath] config.toml read when configText is absent
 * @param {string} [opts.configText] pre-read config.toml text
 * @param {string} [opts.kimiHome] Kimi home dir holding credentials/
 * @returns {{credentialsPath: string, url: string}}
 */
export function resolveQuotaEndpoints({
  env = {},
  configPath = CONFIG_TOML_PATH,
  configText = undefined,
  kimiHome = KIMI_HOME,
} = {}) {
  const credentialsDir = path.join(kimiHome, 'credentials');
  const fallback = {
    credentialsPath: path.join(credentialsDir, 'kimi-code.json'),
    url: USAGES_URL,
  };
  try {
    let text = typeof configText === 'string' ? configText : null;
    if (text === null) {
      try {
        text = fs.readFileSync(configPath, 'utf8');
      } catch {
        text = null;
      }
    }
    const providerTable = text === null ? null : findProviderTable(text, MANAGED_KIMI_PROVIDER);
    const oauthTable = text === null ? null : managedOAuthTable(text);
    const configuredBaseUrl = providerTable === null
      ? null
      : normalizeEndpoint(decodedStringValue(providerTable, 'base_url'));
    const configuredOAuthHost = oauthTable === null
      ? null
      : normalizeEndpoint(decodedStringValue(oauthTable, 'oauth_host'));
    const configuredKey = oauthTable === null ? null : decodedStringValue(oauthTable, 'key');

    // Region resolution follows upstream's observable order: env host first,
    // then the persisted login's oauth_host. An explicit host must match a
    // region profile exactly; a custom one fails closed to the default.
    const host = normalizeEndpoint(env.KIMI_CODE_OAUTH_HOST)
      || normalizeEndpoint(env.KIMI_OAUTH_HOST)
      || configuredOAuthHost;
    const profile = host === null
      ? null
      : REGION_PROFILES.find((p) => p.oauthHost === host) || null;
    if (host !== null && profile === null) return fallback;
    const baseUrl = normalizeEndpoint(env.KIMI_CODE_BASE_URL)
      || configuredBaseUrl
      || (profile || REGION_PROFILES[0]).baseUrl;
    const endpointProfile = REGION_PROFILES.find((p) => p.baseUrl === baseUrl) || null;
    if (endpointProfile === null) return fallback;
    if (profile !== null && profile !== endpointProfile) return fallback;
    return {
      credentialsPath: credentialsPathForKey(configuredKey, credentialsDir),
      url: `${baseUrl}/usages`,
    };
  } catch {
    return fallback;
  }
}

function officialUsagesUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && OFFICIAL_USAGES_HOSTS.has(parsed.hostname)
      && parsed.port === ''
      && parsed.pathname === '/coding/v1/usages'
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * Fetch and classify one quota response without mutating the cache.
 * The whole request — headers, body and JSON parse — shares one deadline, and
 * response bodies are size-capped and always released.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestQuota({
  token,
  url = USAGES_URL,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof token !== 'string' || !token || !officialUsagesUrl(url)) {
    return { status: QUOTA_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseQuotaPayload,
  });
}

/**
 * --refresh-quota entry point: read credentials, call /usages, write cache.
 * Completely silent on success and on failure; never writes to stdout/stderr.
 * When the credentials are gone or carry no token (/logout, corrupt file),
 * the stale cache is deleted along the way so the HUD stops rendering quota
 * for a logged-out account. A 401/403 with a refresh_token still present is
 * only an expired access_token — the cache survives until the CLI's lazy
 * refresh lets the next attempt succeed.
 *
 * Every failed attempt (timeout, network error, 429, 5xx, auth, unusable
 * payload) persists a failure record with the error category and the next
 * allowed attempt time; success clears it. The next-attempt time is stamped
 * from a clock read after the request settles, so a request that burns its
 * whole deadline still backs off from the moment it actually failed (the
 * honored Retry-After window included) instead of from an already-stale
 * request start. The record is keyed by a non-reversible digest of the
 * credential path and endpoint, so switching context restarts the failure
 * count instead of inheriting the previous account's lockout, and the
 * scheduler-side gate compares that digest against its own context before
 * honouring a window. A failure is only recorded while the live config still
 * resolves to the credential slot and endpoint this request used: a refresh
 * that outlived a context switch leaves the new context's backoff state (or
 * lack of one) untouched. Pass no statePath to skip persistence.
 *
 * Before this request may mutate the shared cache (write after success, drop
 * after /logout or missing token) the live config is re-resolved and compared
 * with the context this request actually used. A refresh that started before
 * an account, region, or credential-slot switch therefore never overwrites or
 * deletes the new context's cache with figures belonging to the old one — the
 * stale result is dropped and the next frame spawns a refresh for the current
 * context. The successful cache write carries the same context tag
 * (version 2), which the render data plane compares against the config's
 * current context before displaying anything; legacy untagged caches are not
 * treated as current quota until a refresh re-tags them.
 *
 * Same-slot account switches remain undetectable by design: upstream keeps one
 * credential slot per region/env and persists no account identity beside the
 * tokens, so a fresh login overwrites the same file and the HUD cannot tell a
 * new account from a rotated token before the next successful refresh. Those
 * refreshes are rate-limited to one per TTL/failure window; between a switch
 * and the next success the previous figures may render at most within that
 * stale window and are always dimmed/hidden past the age contract.
 * @param {object} [opts]
 * @returns {Promise<boolean>} true when the cache was updated
 */
export async function refreshQuota({
  credentialsPath = CREDENTIALS_PATH,
  cachePath = QUOTA_CACHE_PATH,
  lockPath = REFRESH_LOCK_PATH,
  statePath = null,
  url = USAGES_URL,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
  lockToken = null,
  now = Date.now(),
  clock = Date.now,
  jitter = Math.random,
  env = process.env,
  configPath = undefined,
  configText = undefined,
  kimiHome = undefined,
} = {}) {
  const contextKey = quotaContextKeyFor(credentialsPath, url);
  const runtimePaths = resolveRuntimePaths();
  const currentConfigPath = configPath ?? runtimePaths.configTomlPath;
  const currentKimiHome = kimiHome ?? runtimePaths.kimiHome;
  // Re-resolve the live config and test whether it still points at the
  // credential slot + endpoint this request used. Memoized per refresh: the
  // guard runs at most once per cache mutation.
  let checkedSameContext = false;
  let sameContext = true;
  const isStillCurrentContext = () => {
    if (!checkedSameContext) {
      const current = resolveQuotaEndpoints({
        env,
        configPath: currentConfigPath,
        configText,
        kimiHome: currentKimiHome,
      });
      sameContext = quotaContextKeyFor(current.credentialsPath, current.url) === contextKey;
      checkedSameContext = true;
    }
    return sameContext;
  };
  try {
    let cred = null;
    try {
      cred = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    } catch {
      // missing or unreadable credentials file
    }
    const token = cred && typeof cred.access_token === 'string' ? cred.access_token : null;
    if (!token) {
      if (isStillCurrentContext()) {
        try { fs.unlinkSync(cachePath); } catch { /* no cache to drop */ }
      }
      return false;
    }
    const result = await requestQuota({ token, url, timeoutMs, fetchImpl });
    if (result.status === QUOTA_RESULT.UNAUTHORIZED) {
      // 401/403 only means /logout when the refresh_token is gone too (the
      // CLI persists both as empty strings then). An expired access_token
      // earns the same 401, but the CLI refreshes lazily — no background
      // loop — so an idle session's on-disk token is often stale while the
      // account is still logged in; keep the last good cache for that case.
      const canRefresh =
        cred && typeof cred.refresh_token === 'string' && cred.refresh_token.length > 0;
      if (isStillCurrentContext()) {
        if (!canRefresh) {
          try { fs.unlinkSync(cachePath); } catch { /* no cache to drop */ }
        }
        recordRefreshFailure({
          statePath,
          category: REQUEST_CATEGORY.AUTH,
          now: clock(),
          jitter,
          contextKey,
        });
      }
      return false;
    }
    if (result.status === QUOTA_RESULT.SUCCESS) {
      // A request that outlived a context switch must not overwrite the new
      // context's cache (or clear its backoff) with old-context figures.
      if (!isStillCurrentContext()) return false;
      writeQuotaCache(result.parsed, cachePath, { now, contextKey });
      clearRefreshState(statePath);
      return true;
    }
    // The write path validates ownership: a request that outlived its
    // context must neither stamp a lockout for the live context nor reset
    // the backoff the live context may already have accumulated.
    if (isStillCurrentContext()) {
      recordRefreshFailure({
        statePath,
        category: result.category,
        retryAfterSeen: result.retryAfterSeen === true,
        retryAfterMs: result.retryAfterMs ?? null,
        now: clock(),
        jitter,
        contextKey,
      });
    }
    return false;
  } catch {
    return false;
  } finally {
    releaseQuotaLock(lockPath, lockToken);
  }
}
