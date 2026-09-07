import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from './fs-store.mjs';
import { migrateParsedState } from './metrics-state.mjs';

export const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SESSION_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
export const HOUSEKEEPING_MAX_UNLINKS = 200;
export const SCRUB_MAX_FILES = 200;
// Exported so callers (and tests) can locate the scrub cursor without
// hard-coding the name; see scrubLegacySessionCaches for the semantics.
export const SCRUB_CURSOR_NAME = '.legacy-scrub-cursor.json';

const STAMP_NAME = '.housekeeping-stamp';
// Resumable-scan cursor for the legacy-cache scrub: per-directory anchors into
// the sorted session-file names, so caches already handled never consume a
// later pass's budget again. Bare file names only — no paths, no content.
const SCRUB_CURSOR_VERSION = 1;
// Session file names carry sanitized ids, so these anchored prefixes can
// never match another HUD file (config, quota, git-status cache). The tmp
// pattern covers atomicWriteFile temporaries plus both lock-acquisition
// temporaries (quota refresh, git status), none of which survive a clean
// write — an old one is always an orphan from a killed process.
const SESSION_FILE_RE = /^(?:metrics|thinking)-[A-Za-z0-9_-]+\.json$/;
const TEMPORARY_RE = /\.tmp-/;
// Fields the pre-v9 writer used to persist raw wire bytes under.
const LEGACY_CONTENT_RE = /"(?:pendingBase64|tailMarker)"/;

function isBareFileName(name) {
  return (
    typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
  );
}

/**
 * Read the scrub cursor written by a previous pass. Anything unexpected —
 * absent, corrupt, truncated by a crash, or written by a newer version —
 * yields no anchors, which is always safe: re-running the idempotent
 * migration from the start of a directory can only redo skipped work.
 */
function readScrubCursor(cursorPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    if (!raw || raw.v !== SCRUB_CURSOR_VERSION) return null;
    if (!raw.anchors || typeof raw.anchors !== 'object') return null;
    return raw.anchors;
  } catch {
    return null;
  }
}

function scrubDirectoryLegacyCaches(dir, { stopAt, anchor, counts }) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { exhausted: false, last: null }; // missing or unreadable: nothing to scrub
  }
  let start = 0;
  if (anchor) {
    // Resume after the last file the previous pass inspected. Sorted order
    // keeps that position stable across directory churn; a vanished anchor
    // falls back to a full re-scan, which is always safe.
    const at = names.indexOf(anchor);
    start = at === -1 ? 0 : at + 1;
  }
  let i = start;
  for (; i < names.length; i++) {
    if (counts.scanned >= stopAt) break;
    const filePath = path.join(dir, names[i]);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue; // raced away or unreadable: retried on a later pass
    }
    counts.scanned += 1;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      // Unparseable files cannot be migrated in place.
      if (LEGACY_CONTENT_RE.test(text)) {
        try {
          fs.unlinkSync(filePath);
          counts.removed += 1;
        } catch { /* raced away */ }
      }
      continue;
    }
    try {
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
  return { exhausted: i < names.length, last: i > start ? names[i - 1] : null };
}

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
 * markers — anything else waits for the retention sweep.
 *
 * The per-run budget (maxFiles inspected caches) is split fairly between the
 * two directories, so a packed hudDir root can never starve `sessions/`.
 * Inspected positions persist in a cursor file (`SCRUB_CURSOR_NAME` under
 * hudDir, bare sorted file names only, written atomically): caches already
 * migrated to the current shape sit behind the cursor and are not re-inspected
 * — re-counted as workload — by later passes, so repeated runs always advance
 * and eventually clear out. The cursor is dropped once a pass walks both
 * directories to completion; if it is lost, corrupt, or its anchor file has
 * vanished (crash, sweep, churn), the affected directory simply re-scans from
 * the start, which is safe because the migration is idempotent.
 *
 * Silent and fail-open throughout; returns the pass counts.
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
    const dirs = [
      ['hud', hudDir],
      ['sessions', sessionStateDir],
    ];
    const cursorPath = path.join(hudDir, SCRUB_CURSOR_NAME);
    const saved = readScrubCursor(cursorPath);
    const anchors = {};
    for (const [key] of dirs) {
      if (saved && isBareFileName(saved[key])) anchors[key] = saved[key];
    }
    for (let i = 0; i < dirs.length; i++) {
      // Fair share of the remaining budget, so later directories always keep
      // at least an equal split of what is left: the root volume cannot
      // consume the whole cap. stopAt caps the shared scanned counter for
      // this directory's turn.
      const share = Math.ceil((maxFiles - counts.scanned) / (dirs.length - i));
      const result = scrubDirectoryLegacyCaches(dirs[i][1], {
        stopAt: counts.scanned + share,
        anchor: anchors[dirs[i][0]] || null,
        counts,
      });
      if (result.exhausted && result.last) anchors[dirs[i][0]] = result.last;
      else delete anchors[dirs[i][0]];
    }
    if (Object.keys(anchors).length > 0) {
      atomicWriteFile(cursorPath, JSON.stringify({ v: SCRUB_CURSOR_VERSION, anchors }));
    } else {
      try { fs.unlinkSync(cursorPath); } catch { /* already absent */ }
    }
  } catch {
    // fail-open, like the rest of housekeeping
  }
  return counts;
}
