import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from './fs-store.mjs';

export const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SESSION_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
export const HOUSEKEEPING_MAX_UNLINKS = 200;

const STAMP_NAME = '.housekeeping-stamp';
// Session file names carry sanitized ids, so these anchored prefixes can
// never match another HUD file (config, quota, git-status cache). The tmp
// pattern covers atomicWriteFile temporaries plus both lock-acquisition
// temporaries (quota refresh, git status), none of which survive a clean
// write — an old one is always an orphan from a killed process.
const SESSION_FILE_RE = /^(?:metrics|thinking)-[A-Za-z0-9_-]+\.json$/;
const TEMPORARY_RE = /\.tmp-/;

function sweepDirectory(dir, { now, maxAgeMs, budget, matches }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable directory: nothing to sweep
  }
  for (const entry of entries) {
    if (budget.count <= 0) break;
    if (!entry.isFile() || !matches.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(filePath).mtimeMs < maxAgeMs) continue;
      fs.unlinkSync(filePath);
      budget.count -= 1;
    } catch { /* best effort: a file that raced back to life is left alone */ }
  }
}

/**
 * Daily opportunistic cleanup of the HUD state directory: orphaned atomic-
 * write and lock temporaries, plus session state files whose session has not
 * been touched within the retention window (including legacy root copies the
 * per-session migration has not reached). Runs from the SessionStart hook —
 * never from the render hot path — and is throttled by the mtime of a stamp
 * file under `sessions/`, so consecutive session starts cost one stat.
 * Silent and fail-open throughout.
 *
 * @returns {boolean} true when a sweep actually ran
 */
export function runHousekeeping({
  hudDir,
  sessionStateDir,
  now = Date.now(),
  intervalMs = HOUSEKEEPING_INTERVAL_MS,
  sessionTtlMs = SESSION_FILE_TTL_MS,
  tmpMaxAgeMs = TMP_FILE_MAX_AGE_MS,
  maxUnlinks = HOUSEKEEPING_MAX_UNLINKS,
} = {}) {
  try {
    const stampPath = path.join(sessionStateDir, STAMP_NAME);
    try {
      if (now - fs.statSync(stampPath).mtimeMs < intervalMs) return false;
    } catch { /* first run (or the stamp itself was swept): clean now */ }
    const budget = { count: maxUnlinks };
    sweepDirectory(hudDir, { now, maxAgeMs: tmpMaxAgeMs, budget, matches: TEMPORARY_RE });
    sweepDirectory(sessionStateDir, { now, maxAgeMs: tmpMaxAgeMs, budget, matches: TEMPORARY_RE });
    sweepDirectory(hudDir, { now, maxAgeMs: sessionTtlMs, budget, matches: SESSION_FILE_RE });
    sweepDirectory(sessionStateDir, { now, maxAgeMs: sessionTtlMs, budget, matches: SESSION_FILE_RE });
    atomicWriteFile(stampPath, JSON.stringify({ at: now }));
    return true;
  } catch {
    return false; // housekeeping must never break its caller
  }
}
