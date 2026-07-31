import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const HUD_DIR = path.join(os.homedir(), '.kimi-code-hud');
export const QUOTA_CACHE_PATH = path.join(HUD_DIR, 'quota.json');
export const REFRESH_LOCK_PATH = path.join(HUD_DIR, 'refresh.lock');
export const CREDENTIALS_PATH = path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
export const USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
export const QUOTA_TTL_MS = 60_000;
export const LOCK_STALE_MS = 30_000;

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
 * Parse the /usages API response into the cache shape.
 * Lenient: used/limit may be strings, detail may live on the item top level.
 * Returns null when nothing usable is present.
 * @param {object} json
 * @returns {{weekly: object, windows: object[]}|null}
 */
export function parseQuotaPayload(json) {
  if (!json || typeof json !== 'object') return null;
  let weekly = null;
  const u = json.usage;
  if (u && typeof u === 'object') {
    const used = toNum(u.used);
    const limit = toNum(u.limit);
    if (used !== null && limit !== null && limit > 0) {
      weekly = { used, limit, resetAt: typeof u.resetTime === 'string' ? u.resetTime : null };
    }
  }
  const windows = [];
  if (Array.isArray(json.limits)) {
    for (const item of json.limits) {
      if (!item || typeof item !== 'object') continue;
      const detail = (item.detail && typeof item.detail === 'object') ? item.detail : item;
      const used = toNum(detail.used);
      const limit = toNum(detail.limit);
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
    const tmp = `${cachePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, cachePath);
  } catch {
    // stay silent
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
} = {}) {
  try {
    const cache = readQuotaCache(cachePath);
    if (!isQuotaStale(cache, now)) return false;
    // Concurrency guard
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lock && typeof lock.at === 'number' && now - lock.at < LOCK_STALE_MS) return false;
    } catch {
      // no lock or unreadable lock -> proceed
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: now }));
    const child = spawn(process.execPath, [scriptPath, '--refresh-quota'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * --refresh-quota entry point: read credentials, call /usages, write cache.
 * Completely silent on success and on failure; never writes to stdout/stderr.
 * When the credentials are gone or carry no token (/logout, corrupt file),
 * the stale cache is deleted along the way so the HUD stops rendering quota
 * for a logged-out account.
 * @param {object} [opts]
 * @returns {Promise<boolean>} true when the cache was updated
 */
export async function refreshQuota({
  credentialsPath = CREDENTIALS_PATH,
  cachePath = QUOTA_CACHE_PATH,
  lockPath = REFRESH_LOCK_PATH,
  url = USAGES_URL,
  timeoutMs = 8000,
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return false;
    const json = await res.json();
    const parsed = parseQuotaPayload(json);
    if (!parsed) return false;
    writeQuotaCache(parsed, cachePath);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
