import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './fs-store.mjs';
import {
  HUD_DIR,
  CREDENTIALS_PATH,
  QUOTA_CACHE_PATH,
  REFRESH_LOCK_PATH,
} from './paths.mjs';

export { HUD_DIR, CREDENTIALS_PATH, QUOTA_CACHE_PATH, REFRESH_LOCK_PATH };
export const USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
export const QUOTA_TTL_MS = 60_000;
export const LOCK_STALE_MS = 30_000;

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

function quotaValues(detail) {
  const limit = toNum(detail.limit);
  let used = toNum(detail.used);
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
 * @param {string} [cachePath]
 * @returns {{fetchedAt: number, weekly: object|null, windows: object[]}|null}
 */
export function readQuotaCache(cachePath = QUOTA_CACHE_PATH) {
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || typeof data.fetchedAt !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {object|null} cache
 * @param {number} [now]
 * @returns {boolean} true when missing or older than TTL
 */
export function isQuotaStale(cache, now = Date.now()) {
  if (!cache) return true;
  return now - cache.fetchedAt > QUOTA_TTL_MS;
}

/**
 * Atomically write the quota cache (tmp file + rename). Never throws.
 * @param {object} parsed result of parseQuotaPayload
 * @param {string} [cachePath]
 */
export function writeQuotaCache(parsed, cachePath = QUOTA_CACHE_PATH) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const body = JSON.stringify({ fetchedAt: Date.now(), ...parsed });
    atomicWriteFile(cachePath, body);
  } catch {
    // stay silent
  }
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
 * If the cache is stale, spawn a detached background refresh and return
 * immediately. A lock file (pid + timestamp) prevents concurrent refreshes;
 * locks older than LOCK_STALE_MS are treated as stale and overwritten.
 * Never throws, never blocks on the network.
 * @param {object} [opts]
 * @returns {boolean} true when a refresh was spawned
 */
export function ensureFreshQuota({
  cachePath = QUOTA_CACHE_PATH,
  lockPath = REFRESH_LOCK_PATH,
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

function officialUsagesUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'api.kimi.com'
      && parsed.pathname === '/coding/v1/usages'
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * Fetch and classify one quota response without mutating the cache.
 * @returns {Promise<{status: string, parsed?: object}>}
 */
export async function requestQuota({
  token,
  url = USAGES_URL,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof token !== 'string' || !token || !officialUsagesUrl(url)) {
    return { status: QUOTA_RESULT.INVALID };
  }
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error('quota request timed out'));
    }, timeoutMs);
  });
  let res;
  try {
    res = await Promise.race([
      fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: ctrl.signal,
      }),
      timeout,
    ]);
  } catch {
    return { status: QUOTA_RESULT.TRANSIENT };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    return { status: QUOTA_RESULT.UNAUTHORIZED };
  }
  if (res.status === 429 || res.status >= 500) {
    return { status: QUOTA_RESULT.TRANSIENT };
  }
  if (!res.ok) return { status: QUOTA_RESULT.INVALID };
  try {
    const parsed = parseQuotaPayload(await res.json());
    return parsed
      ? { status: QUOTA_RESULT.SUCCESS, parsed }
      : { status: QUOTA_RESULT.INVALID };
  } catch {
    return { status: QUOTA_RESULT.INVALID };
  }
}

/**
 * --refresh-quota entry point: read credentials, call /usages, write cache.
 * Completely silent on success and on failure; never writes to stdout/stderr.
 * When the credentials are gone or carry no token (/logout, corrupt file),
 * the stale cache is deleted along the way so the HUD stops rendering quota
 * for a logged-out account. A 401/403 with a refresh_token still present is
 * only an expired access_token — the cache survives until the CLI's lazy
 * refresh lets the next attempt succeed.
 * @param {object} [opts]
 * @returns {Promise<boolean>} true when the cache was updated
 */
export async function refreshQuota({
  credentialsPath = CREDENTIALS_PATH,
  cachePath = QUOTA_CACHE_PATH,
  lockPath = REFRESH_LOCK_PATH,
  url = USAGES_URL,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
  lockToken = null,
} = {}) {
  try {
    let cred = null;
    try {
      cred = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    } catch {
      // missing or unreadable credentials file
    }
    const token = cred && typeof cred.access_token === 'string' ? cred.access_token : null;
    if (!token) {
      try { fs.unlinkSync(cachePath); } catch { /* no cache to drop */ }
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
      if (!canRefresh) {
        try { fs.unlinkSync(cachePath); } catch { /* no cache to drop */ }
      }
      return false;
    }
    if (result.status !== QUOTA_RESULT.SUCCESS) return false;
    writeQuotaCache(result.parsed, cachePath);
    return true;
  } catch {
    return false;
  } finally {
    releaseQuotaLock(lockPath, lockToken);
  }
}
