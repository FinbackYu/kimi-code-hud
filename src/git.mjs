import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { atomicWriteFile } from './fs-store.mjs';

// cmd.exe / CreateProcess search the current directory before PATH, so a bare
// command name can execute a binary planted in the workspace. Resolve PATH
// ourselves and refuse workspace-local hits before running the pre-trust Git
// probe. This mirrors the Kimi Code 0.35+ host boundary.
const DEFAULT_WIN32_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];
const DEFAULT_GIT_STATUS_TTL_MS = 15_000;
const DEFAULT_GIT_STATUS_CACHE_MAX_ENTRIES = 64;
const GIT_STATUS_CACHE_VERSION = 1;
const GIT_STATUS_CACHE_MAX_BYTES = 256 * 1024;
const GIT_STATUS_LOCK_WAIT_MS = 20;
const GIT_STATUS_LOCK_POLL_MS = 2;
const GIT_STATUS_LOCK_STALE_MS = 5_000;
const EMPTY_GIT_STATUS = Object.freeze({ branch: null, dirty: false });
const LOCK_SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

function envValue(env, name) {
  const match = Object.entries(env).find(([key]) => key.toUpperCase() === name);
  return typeof match?.[1] === 'string' ? match[1] : '';
}

function pathExtensions(platform, env) {
  if (platform !== 'win32') return [''];
  const raw = envValue(env, 'PATHEXT');
  if (raw.trim().length === 0) return DEFAULT_WIN32_PATHEXT;
  return raw
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
}

function candidateNames(command, extensions) {
  if (extensions.length === 1 && extensions[0] === '') return [command];
  const lower = command.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension.toLowerCase()))) {
    return [command, ...extensions.map((extension) => command + extension)];
  }
  return extensions.map((extension) => command + extension);
}

function executablePath(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return null;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function isInsideCwd(candidate, cwd, platform) {
  let resolvedCandidate = candidate;
  let resolvedCwd;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    resolvedCwd = resolve(cwd);
  }
  if (platform === 'win32') {
    resolvedCandidate = resolvedCandidate.toLowerCase();
    resolvedCwd = resolvedCwd.toLowerCase();
  }
  const rel = relative(resolvedCwd, resolvedCandidate);
  return rel === '' || (
    rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

/**
 * Resolve a bare command to an absolute executable from PATH. A hit inside
 * cwd fails closed instead of falling through to a later PATH entry.
 * @param {string} command
 * @param {string} [cwd]
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv|object} [opts.env]
 * @param {NodeJS.Platform|string} [opts.platform]
 * @returns {string|undefined}
 */
export function resolveCommandPath(
  command,
  cwd = process.cwd(),
  { env = process.env, platform = process.platform } = {},
) {
  if (typeof command !== 'string' || command === '' || /[\\/]/.test(command)) return undefined;
  const names = candidateNames(command, pathExtensions(platform, env));
  const separator = platform === 'win32' ? ';' : ':';
  for (const rawDir of envValue(env, 'PATH').split(separator)) {
    if (rawDir === '') continue;
    const dir = rawDir.startsWith('"') && rawDir.endsWith('"')
      ? rawDir.slice(1, -1)
      : rawDir;
    for (const name of names) {
      const candidate = executablePath(join(dir, name), platform);
      if (!candidate) continue;
      if (isInsideCwd(candidate, cwd, platform)) return undefined;
      return candidate;
    }
  }
  return undefined;
}

function gitEnvironment(env) {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== 'GIT_OPTIONAL_LOCKS'),
  );
  childEnv.GIT_OPTIONAL_LOCKS = '0';
  return childEnv;
}

function parseBranch(summary) {
  if (summary.startsWith('No commits yet on ')) {
    return summary.slice('No commits yet on '.length) || null;
  }
  if (summary.startsWith('Initial commit on ')) {
    return summary.slice('Initial commit on '.length) || null;
  }
  if (summary === 'HEAD' || summary.startsWith('HEAD ')) return null;
  const upstream = summary.indexOf('...');
  const tracking = summary.indexOf(' [');
  const end = Math.min(
    upstream === -1 ? summary.length : upstream,
    tracking === -1 ? summary.length : tracking,
  );
  return summary.slice(0, end) || null;
}

function parseGitStatus(output) {
  const lines = output.toString().split(/\r?\n/);
  let branch = null;
  let dirty = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch = parseBranch(line.slice(3));
    } else if (line.length > 0) {
      dirty = true;
    }
  }
  return Object.freeze({ branch, dirty });
}

function normalizedCwd(cwd, platform) {
  let normalized;
  try {
    normalized = realpathSync(cwd);
  } catch {
    normalized = resolve(cwd);
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function cacheKey(cwd, platform) {
  return createHash('sha256').update(normalizedCwd(cwd, platform)).digest('hex');
}

function validCacheEntry(entry) {
  return entry
    && typeof entry === 'object'
    && Object.keys(entry).sort().join(',') === 'branch,checkedAt,dirty'
    && Number.isFinite(entry.checkedAt)
    && entry.checkedAt >= 0
    && (entry.branch === null || (
      typeof entry.branch === 'string'
      && entry.branch.length <= 1024
    ))
    && typeof entry.dirty === 'boolean';
}

function readGitStatusCache(cachePath, maxEntries) {
  const entries = Object.create(null);
  if (!cachePath || typeof cachePath !== 'string') return entries;
  try {
    const stat = lstatSync(cachePath);
    if (!stat.isFile() || stat.size > GIT_STATUS_CACHE_MAX_BYTES) return entries;
    const raw = readFileSync(cachePath, 'utf8');
    if (Buffer.byteLength(raw) > GIT_STATUS_CACHE_MAX_BYTES) return entries;
    const parsed = JSON.parse(raw);
    if (
      parsed?.version !== GIT_STATUS_CACHE_VERSION
      || !parsed.entries
      || typeof parsed.entries !== 'object'
      || Array.isArray(parsed.entries)
    ) return entries;
    const cachedEntries = Object.entries(parsed.entries);
    if (cachedEntries.length > maxEntries) return entries;
    for (const [key, entry] of cachedEntries) {
      if (!/^[a-f0-9]{64}$/.test(key) || !validCacheEntry(entry)) {
        return Object.create(null);
      }
      entries[key] = {
        checkedAt: entry.checkedAt,
        branch: entry.branch,
        dirty: entry.dirty,
      };
    }
  } catch {
    return Object.create(null);
  }
  return entries;
}

function boundCacheEntries(entries, currentKey, maxEntries) {
  const keys = Object.keys(entries).sort((left, right) => {
    const ageOrder = entries[left].checkedAt - entries[right].checkedAt;
    if (ageOrder !== 0) return ageOrder;
    if (left === currentKey) return 1;
    if (right === currentKey) return -1;
    return left.localeCompare(right);
  });
  while (keys.length > maxEntries) {
    delete entries[keys.shift()];
  }
}

function readGitStatusLock(lockPath) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (
      !lock
      || typeof lock !== 'object'
      || typeof lock.token !== 'string'
      || !Number.isFinite(lock.at)
    ) return null;
    return lock;
  } catch {
    return null;
  }
}

function tryAcquireGitStatusLock(lockPath, { at, token, staleMs, attempt }) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const current = readGitStatusLock(lockPath);
  if (current && at - current.at < staleMs) return null;
  if (current || existsSync(lockPath)) {
    const stalePath = `${lockPath}.stale-${token}-${attempt}`;
    try {
      renameSync(lockPath, stalePath);
      try { unlinkSync(stalePath); } catch { /* best effort */ }
    } catch {
      // Another process removed or replaced it; exclusive create decides next.
    }
  }

  const tmpPath = `${lockPath}.tmp-${token}-${attempt}`;
  try {
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, at, token }), { mode: 0o600 });
    linkSync(tmpPath, lockPath);
    return token;
  } catch (err) {
    if (err?.code === 'EEXIST') return null;
    throw err;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* no temporary lock to clean */ }
  }
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(LOCK_SLEEP_VIEW, 0, 0, ms);
}

function acquireGitStatusLock(lockPath, {
  waitMs,
  staleMs,
  wallClock,
  monotonicClock,
  sleep,
}) {
  if (!lockPath || typeof lockPath !== 'string') return null;
  let token;
  let deadline;
  try {
    deadline = monotonicClock() + waitMs;
    token = `${process.pid}-${wallClock()}-${randomUUID()}`;
  } catch {
    return null;
  }
  // One monotonic deadline accounts for both filesystem attempts and polling;
  // maxAttempts is only a backstop for a broken or non-advancing test clock.
  const maxAttempts = Math.max(1, Math.ceil(waitMs / GIT_STATUS_LOCK_POLL_MS) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const currentTime = monotonicClock();
      if (attempt === 0 ? currentTime > deadline : currentTime >= deadline) return null;
    } catch {
      return null;
    }
    let acquired = null;
    try {
      acquired = tryAcquireGitStatusLock(lockPath, {
        at: wallClock(), token, staleMs, attempt,
      });
    } catch {
      return null;
    }
    let remaining;
    try {
      remaining = deadline - monotonicClock();
    } catch {
      if (acquired) releaseGitStatusLock(lockPath, acquired);
      return null;
    }
    if (acquired) {
      if (remaining >= 0) return acquired;
      releaseGitStatusLock(lockPath, acquired);
      return null;
    }
    if (remaining <= 0) return null;
    if (attempt + 1 < maxAttempts) {
      try {
        sleep(Math.min(GIT_STATUS_LOCK_POLL_MS, remaining));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function releaseGitStatusLock(lockPath, token) {
  try {
    const current = readGitStatusLock(lockPath);
    if (!current || current.token !== token) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function writeGitStatusCache(cachePath, entries, atomicWriteFileImpl) {
  if (!cachePath || typeof cachePath !== 'string') return;
  try {
    atomicWriteFileImpl(cachePath, JSON.stringify({
      version: GIT_STATUS_CACHE_VERSION,
      entries,
    }), { mode: 0o600, preserveMode: false });
  } catch {
    // Cache persistence is best effort; the current probe result is still valid.
  }
}

/**
 * Create a bounded, synchronous Git status reader backed by a shared cache
 * file. The clock and I/O are injectable so expiry and failures need no sleep.
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxEntries]
 * @param {typeof execFileSync} [options.execFileSyncImpl]
 * @param {typeof atomicWriteFile} [options.atomicWriteFileImpl]
 * @param {() => number} [options.wallClock]
 * @param {() => number} [options.monotonicClock]
 * @param {(ms: number) => void} [options.sleep]
 * @param {number} [options.lockWaitMs]
 * @param {number} [options.lockStaleMs]
 * @returns {(cwd: string, opts?: object) => {branch: string|null, dirty: boolean}}
 */
export function createGitStatusReader({
  now = Date.now,
  ttlMs = DEFAULT_GIT_STATUS_TTL_MS,
  maxEntries = DEFAULT_GIT_STATUS_CACHE_MAX_ENTRIES,
  execFileSyncImpl = execFileSync,
  atomicWriteFileImpl = atomicWriteFile,
  wallClock = Date.now,
  monotonicClock = () => performance.now(),
  sleep = sleepSync,
  lockWaitMs = GIT_STATUS_LOCK_WAIT_MS,
  lockStaleMs = GIT_STATUS_LOCK_STALE_MS,
} = {}) {
  const boundedTtlMs = Number.isFinite(ttlMs)
    ? Math.max(0, Math.floor(ttlMs))
    : DEFAULT_GIT_STATUS_TTL_MS;
  const boundedMaxEntries = Number.isFinite(maxEntries)
    ? Math.min(
      DEFAULT_GIT_STATUS_CACHE_MAX_ENTRIES,
      Math.max(1, Math.floor(maxEntries)),
    )
    : DEFAULT_GIT_STATUS_CACHE_MAX_ENTRIES;
  const boundedLockWaitMs = Number.isFinite(lockWaitMs)
    ? Math.max(0, Math.min(GIT_STATUS_LOCK_WAIT_MS, Math.floor(lockWaitMs)))
    : GIT_STATUS_LOCK_WAIT_MS;
  const boundedLockStaleMs = Number.isFinite(lockStaleMs)
    ? Math.max(GIT_STATUS_LOCK_WAIT_MS, Math.floor(lockStaleMs))
    : GIT_STATUS_LOCK_STALE_MS;

  return function readGitStatus(
    cwd,
    {
      timeoutMs = 150,
      env = process.env,
      platform = process.platform,
      cachePath,
    } = {},
  ) {
    if (!cwd || typeof cwd !== 'string') return EMPTY_GIT_STATUS;

    const key = cacheKey(cwd, platform);
    const checkedAt = now();
    const entries = readGitStatusCache(cachePath, boundedMaxEntries);
    const cached = entries[key];
    const age = cached ? checkedAt - cached.checkedAt : -1;
    if (cached && age >= 0 && age < boundedTtlMs) {
      return Object.freeze({ branch: cached.branch, dirty: cached.dirty });
    }

    let status = EMPTY_GIT_STATUS;
    try {
      const git = resolveCommandPath('git', cwd, { env, platform });
      if (git) {
        const out = execFileSyncImpl(git, ['status', '--porcelain=v1', '--branch'], {
          cwd,
          env: gitEnvironment(env),
          timeout: Math.max(1, Math.min(150, Math.floor(timeoutMs))),
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        status = parseGitStatus(out);
      }
    } catch {
      status = EMPTY_GIT_STATUS;
    }

    if (cachePath && typeof cachePath === 'string') {
      const lockPath = `${cachePath}.lock`;
      const lockToken = acquireGitStatusLock(lockPath, {
        waitMs: boundedLockWaitMs,
        staleMs: boundedLockStaleMs,
        wallClock,
        monotonicClock,
        sleep,
      });
      if (lockToken) {
        try {
          const mergedEntries = readGitStatusCache(cachePath, boundedMaxEntries);
          if (!mergedEntries[key] || mergedEntries[key].checkedAt <= checkedAt) {
            mergedEntries[key] = {
              checkedAt,
              branch: status.branch,
              dirty: status.dirty,
            };
          }
          boundCacheEntries(mergedEntries, key, boundedMaxEntries);
          writeGitStatusCache(cachePath, mergedEntries, atomicWriteFileImpl);
        } finally {
          releaseGitStatusLock(lockPath, lockToken);
        }
      }
    }
    return status;
  };
}

const readCachedGitStatus = createGitStatusReader();

/**
 * Read the cached branch and dirty state for a Git working tree.
 * Any failure (not a repo, git missing, timeout) returns the clean fallback.
 * @param {string} cwd
 * @param {object} [opts]
 * @returns {{branch: string|null, dirty: boolean}}
 */
export function readGitStatus(cwd, opts) {
  return readCachedGitStatus(cwd, opts);
}

/**
 * Check whether the git working tree at cwd has uncommitted changes.
 * Any failure (not a repo, git missing, timeout) returns false.
 * @param {string} cwd
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {NodeJS.ProcessEnv|object} [opts.env]
 * @param {NodeJS.Platform|string} [opts.platform]
 * @param {string} [opts.cachePath]
 * @returns {boolean}
 */
export function isGitDirty(
  cwd,
  opts,
) {
  return readGitStatus(cwd, opts).dirty;
}
