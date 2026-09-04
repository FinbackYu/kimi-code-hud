import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from './fs-store.mjs';

/**
 * Sanitized per-session state file name: a `metrics-`/`thinking-` prefix plus
 * the session id with every character outside [A-Za-z0-9_-] flattened to `_`.
 */
export function sessionFileName(prefix, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${prefix}-${safe}.json`;
}

/**
 * Resolve a per-session state file under the HUD state directory, adopting a
 * legacy root-level copy on first touch.
 *
 * Session state moved from the HUD root into `sessions/`; files written by
 * earlier versions stay at the root until their session is touched again:
 * the resolution renames the legacy copy next to the new location (same
 * volume, so atomic) and a resumed session keeps its cursors, samples and
 * snapshots. The work is bounded — one stat once migrated, one failed read
 * while no legacy copy exists — so the render hot path never scans a
 * directory here.
 */
export function resolveSessionFilePath(dir, legacyDir, prefix, sessionId) {
  const name = sessionFileName(prefix, sessionId);
  const target = path.join(dir, name);
  if (legacyDir == null || legacyDir === dir) return target;
  try {
    fs.statSync(target);
    return target;
  } catch { /* not migrated yet: adopt the legacy copy if one exists */ }
  const legacy = path.join(legacyDir, name);
  let content;
  try {
    content = fs.readFileSync(legacy);
  } catch {
    return target; // no legacy copy — the common case
  }
  try {
    fs.renameSync(legacy, target);
    return target;
  } catch { /* rare rename failure: copy instead, the legacy file stays */ }
  try {
    atomicWriteFile(target, content);
    return target;
  } catch {
    return legacy; // keep serving the session from the legacy location
  }
}
