import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

function sessionCandidates(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return [];
  let bare = sessionId;
  for (const prefix of ['ses_', 'session_']) {
    if (bare.startsWith(prefix)) {
      bare = bare.slice(prefix.length);
      break;
    }
  }
  return [`ses_${bare}`, `session_${bare}`, bare];
}

/** Locate a session directory across legacy and current host spellings. */
export function findSessionDir(sessionId, sessionsRoot, {
  deadline = Infinity,
  clock = () => performance.now(),
} = {}) {
  const candidates = sessionCandidates(sessionId);
  if (!candidates.length) return null;
  let wdDirs;
  try {
    wdDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const wd of wdDirs) {
    if (Number.isFinite(deadline) && clock() >= deadline) return null;
    if (!wd.isDirectory()) continue;
    for (const name of candidates) {
      if (Number.isFinite(deadline) && clock() >= deadline) return null;
      const candidate = path.join(sessionsRoot, wd.name, name);
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function cachedSessionDirValid(sessionDir, sessionId, sessionsRoot) {
  if (!sessionDir || typeof sessionDir !== 'string') return false;
  const root = path.resolve(sessionsRoot);
  const candidate = path.resolve(sessionDir);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  if (!sessionCandidates(sessionId).includes(path.basename(candidate))) return false;
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

/** Use a persisted directory when it is still valid, falling back to a scan. */
export function resolveSessionDir(sessionId, sessionsRoot, cached = null, options = {}) {
  return cachedSessionDirValid(cached, sessionId, sessionsRoot)
    ? cached
    : findSessionDir(sessionId, sessionsRoot, options);
}

/** Locate the main agent wire for compatibility with existing callers/tests. */
export function findWirePath(sessionId, sessionsRoot) {
  const dir = findSessionDir(sessionId, sessionsRoot);
  if (!dir) return null;
  const wirePath = path.join(dir, 'agents', 'main', 'wire.jsonl');
  try { return fs.statSync(wirePath).isFile() ? wirePath : null; } catch { return null; }
}
