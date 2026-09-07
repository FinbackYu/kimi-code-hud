import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from './fs-store.mjs';
import { migrateParsedState } from './metrics-state.mjs';

export const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SESSION_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
export const HOUSEKEEPING_MAX_UNLINKS = 200;
export const SCRUB_MAX_FILES = 200;

const STAMP_NAME = '.housekeeping-stamp';
// Session file names carry sanitized ids, so these anchored prefixes can
// never match another HUD file (config, quota, git-status cache). The tmp
// pattern covers atomicWriteFile temporaries plus both lock-acquisition
// temporaries (quota refresh, git status), none of which survive a clean
// write — an old one is always an orphan from a killed process.
const SESSION_FILE_RE = /^(?:metrics|thinking)-[A-Za-z0-9_-]+\.json$/;
const TEMPORARY_RE = /\.tmp-/;
// Fields the pre-v9 writer used to persist raw wire bytes under.
const LEGACY_CONTENT_RE = /"(?:pendingBase64|tailMarker)"/;

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

/**
 * One bounded, on-demand pass that rewrites every recognized session cache in
 * the two HUD state directories to the current content-free shape — whatever
 * the file's age, and without waiting for its session to reopen or for the
 * retention window. This is the explicit cleanup entry for legacy caches that
 * still carry wire content (pre-v9 pendingBase64 tails, raw tailMarker bytes):
 * the same migration the runtime performs on read, applied to caches whose
 * sessions no longer exist. Only HUD-owned session cache names are touched,
 * only inside the HUD state directories, through atomic same-directory
 * writes; host wire files are never read. An unrecognized shape (a newer
 * HUD's file, or a `thinking-*` snapshot) is left untouched, and an
 * unparseable file is removed only when it still carries legacy content
 * markers — anything else waits for the retention sweep. Silent and fail-open
 * throughout; returns the pass counts.
 *
 * @returns {{scanned: number, cleaned: number, removed: number}}
 */
export function scrubLegacySessionCaches({
  hudDir,
  sessionStateDir,
  maxFiles = SCRUB_MAX_FILES,
} = {}) {
  const counts = { scanned: 0, cleaned: 0, removed: 0 };
  try {
    for (const dir of [hudDir, sessionStateDir]) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // missing or unreadable directory: nothing to scrub
      }
      for (const entry of entries) {
        if (counts.scanned >= maxFiles) return counts;
        if (!entry.isFile() || !SESSION_FILE_RE.test(entry.name)) continue;
        counts.scanned += 1;
        const filePath = path.join(dir, entry.name);
        try {
          const text = fs.readFileSync(filePath, 'utf8');
          let raw;
          try {
            raw = JSON.parse(text);
          } catch {
            // Unparseable files cannot be migrated in place.
            if (LEGACY_CONTENT_RE.test(text)) {
              fs.unlinkSync(filePath);
              counts.removed += 1;
            }
            continue;
          }
          const state = migrateParsedState(raw);
          if (!state) continue; // not a format this HUD version owns
          const next = JSON.stringify(state);
          if (next === text) continue; // already content-free and current
          atomicWriteFile(filePath, next);
          counts.cleaned += 1;
        } catch {
          // Best effort: a file racing a live writer is left for the next run.
        }
      }
    }
  } catch {
    // fail-open, like the rest of housekeeping
  }
  return counts;
}
