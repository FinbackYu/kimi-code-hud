import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { atomicWriteFile } from './fs-store.mjs';
import { HUD_DIR } from './paths.mjs';
import { resolveSessionFilePath } from './session-files.mjs';
import {
  CONFIG_TOML_PATH,
  tableText,
  boolValue,
  stringValue,
  stringArrayValue,
  findModelTable,
} from './model-config.mjs';

export { CONFIG_TOML_PATH };

/**
 * Per-session snapshot. `/effort` rewrites the global config.toml, but a
 * session's runtime effort is frozen at session start — without a snapshot,
 * a session that never switched effort in-session would follow whatever
 * other sessions later wrote into config.toml. So the first resolved level
 * is pinned per sessionId under ~/.kimi-code-hud/sessions/thinking-<sessionId>.json,
 * with two provenance fields:
 *  - `confirmed` records whether the level is wire-verified (the journal, or
 *    a snapshot pinned from it); everything resolved from config.toml is
 *    provisional and renders muted until a wire row confirms it. Even an
 *    explicit `[thinking]` key stays provisional: the host does not persist
 *    the top effort tier, so config can silently lag the current choice and
 *    the HUD cannot tell a fresh config from a stale one.
 *  - `configBasis` is a digest of exactly the config.toml tables a level was
 *    resolved from ([thinking] plus the matched model table); it is `null`
 *    on wire-pinned snapshots. A config-derived snapshot is only as
 *    authoritative as the config it came from, so a basis change re-resolves
 *    instead of shadowing the edit — including same-model effort edits.
 *    Wire-pinned snapshots are this session's own ground truth and are never
 *    re-resolved by config edits; that immunity is the reason the snapshot
 *    exists. The accepted trade-off: a session still in its lazy-start
 *    window (config-derived only) follows live config.toml, so another
 *    session's `/effort` rewrite moves its badge too — the only signal
 *    available before the first wire row pins the real runtime effort.
 * Snapshots written before the flag existed carry no `confirmed` key and
 * are treated as confirmed, preserving their pre-existing rendering.
 */
function readSnapshot(snapshotFile) {
  try {
    const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    if (snap && typeof snap.level === 'string' && snap.level.length > 0) return snap;
  } catch { /* no snapshot yet */ }
  return null;
}

function writeSnapshot(snapshotFile, level, model, confirmed, configBasis) {
  try {
    atomicWriteFile(
      snapshotFile,
      JSON.stringify({ level, model, confirmed, configBasis }),
    );
  } catch { /* best effort */ }
}

/**
 * Digest of the config tables a resolution read. Not a secret — a staleness
 * tag like the quota cache's context key — so the whole snapshot stays small
 * and free of config text. A null `thinking`/`modelTable` (absent table)
 * hashes as the empty string, and the separator keeps distinct table pairs
 * from colliding; a missing config file never reaches here (empty basis).
 */
const BASIS_SEPARATOR = '\n@@hud-config-basis@@\n';
function configBasis(thinking, modelTable) {
  return createHash('sha256')
    .update(`${thinking ?? ''}${BASIS_SEPARATOR}${modelTable ?? ''}`)
    .digest('hex');
}

/**
 * Resolve the thinking level from config.toml: [thinking] config > model
 * default_effort > boolean "on", mirroring the host's own resolution
 * (defaultThinkingEffortFor / resolveThinkingEffort): a model whose table
 * explicitly declares capabilities without thinking resolves to 'off', and
 * an always_thinking model can never resolve to 'off'.
 *
 * Returns `{ level, basis }`. Every level resolved here is provisional by
 * definition — including an explicit `[thinking].effort`, because the host
 * does not persist the top effort tier and a merge can leave a stale value
 * behind, so config.toml is never proof of the current choice. `basis`
 * digests the config tables behind the answer for snapshot staleness
 * checks.
 * @param {string} model payload model display string
 * @param {string} configPath
 * @returns {{ level: string, basis: string }}
 */
function resolveFromConfig(model, configPath, configText = undefined) {
  let text = '';
  if (typeof configText === 'string') {
    text = configText;
  } else {
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch {
      return { level: 'on', basis: '' }; // host default: thinking enabled
    }
  }

  const thinking = tableText(text, 'thinking');
  const modelTable = findModelTable(text, model);
  const basis = configBasis(thinking, modelTable);
  const caps = modelTable !== null ? stringArrayValue(modelTable, 'capabilities') : null;
  const alwaysThinking = caps !== null && caps.includes('always_thinking');
  const thinkingCapable = alwaysThinking
    || (caps !== null && caps.includes('thinking'))
    || (modelTable !== null && boolValue(modelTable, 'adaptive_thinking') === true);

  // Host: [thinking] enabled=false forces off — except on always_thinking
  // models, where an off state would be a lie (upstream keeps reasoning).
  if (thinking !== null && boolValue(thinking, 'enabled') === false && !alwaysThinking) {
    return { level: 'off', basis };
  }

  const globalEffort = thinking !== null ? stringValue(thinking, 'effort') : null;
  const hasEfforts = modelTable !== null && /^\s*support_efforts\s*=/m.test(modelTable);
  if (!hasEfforts) {
    // Explicit capabilities without thinking resolve to 'off' upstream; a
    // configured global effort still shows on compatible (non-kimi)
    // protocols, which pass the value through to the backend.
    if (caps !== null && !thinkingCapable) return { level: globalEffort ? 'on' : 'off', basis };
    return { level: 'on', basis }; // boolean model (or no declared capabilities) -> plain " thinking"
  }

  const modelDefault = modelTable !== null ? stringValue(modelTable, 'default_effort') : null;
  if (alwaysThinking) {
    // Skip 'off' values and fall back to the model's own default.
    return {
      level: (globalEffort && globalEffort !== 'off' ? globalEffort : null) ?? modelDefault ?? 'on',
      basis,
    };
  }
  return { level: globalEffort ?? modelDefault ?? 'on', basis };
}

/**
 * Resolve the thinking level to display, mirroring the host's fallback
 * chain: in-session change (wire config.update) > per-session snapshot >
 * [thinking] config > model default_effort > boolean "on".
 *
 * Returns `{ level, confirmed }`:
 *  - level 'off'        thinking disabled (render no suffix)
 *  - level 'on'         boolean thinking enabled (render " thinking")
 *  - level '<effort>'   concrete effort like "high" (render " <effort>")
 *  - confirmed          true when the level came from the wire journal (or
 *    a snapshot pinned from it); false while it is only inferred from
 *    config.toml — kimi-code lazy-starts, so before the first turn's wire
 *    rows arrive the suffix is provisional and renders muted.
 *
 * @param {object} opts
 * @param {string|null} opts.sessionLevel thinkingLevel from the session log
 * @param {string} opts.model payload model display string
 * @param {string} [opts.configPath]
 * @param {string|null} [opts.sessionId] enables the per-session snapshot
 * @param {string} [opts.snapshotDir]
 * @param {string|null} [opts.legacySnapshotDir] pre-`sessions/` HUD root; a
 *   legacy snapshot there is adopted on first touch
 * @returns {{ level: string, confirmed: boolean }}
 */
export function resolveThinkingLevel({
  sessionLevel,
  model,
  configPath = CONFIG_TOML_PATH,
  sessionId = null,
  snapshotDir = HUD_DIR,
  legacySnapshotDir = null,
  configText = undefined,
  deadline = Infinity,
  clock = Date.now,
}) {
  const canUseSnapshot = () => !Number.isFinite(deadline) || clock() < deadline;
  // Resolving the location may adopt a pre-`sessions/` snapshot on first
  // touch; bounded to one stat once migrated (session-files.mjs).
  const snapshotFile = sessionId && canUseSnapshot()
    ? resolveSessionFilePath(snapshotDir, legacySnapshotDir, 'thinking', sessionId)
    : null;
  if (typeof sessionLevel === 'string' && sessionLevel.length > 0) {
    if (snapshotFile && canUseSnapshot()) {
      writeSnapshot(snapshotFile, sessionLevel, model, true, null);
    }
    return { level: sessionLevel, confirmed: true };
  }
  const snap = snapshotFile && canUseSnapshot() ? readSnapshot(snapshotFile) : null;
  // Snapshots predate the confirmed flag: treat a missing flag as confirmed
  // so long-running sessions keep their previous rendering. Wire-pinned
  // snapshots (no configBasis) are this session's ground truth and stay
  // pinned no matter what other sessions write into config.toml — that
  // immunity is the reason the snapshot exists.
  if (
    snap && snap.model === model
    && typeof snap.configBasis !== 'string'
    && snap.confirmed !== false
  ) {
    return { level: snap.level, confirmed: true };
  }
  const resolved = resolveFromConfig(model, configPath, configText);
  // A config-derived snapshot is only as good as the config it was resolved
  // from: with the same model and an unchanged config basis, the pinned
  // level is deterministically what a re-resolution would produce, so it is
  // reused without rewriting the file; any basis change — a same-model
  // effort edit included — re-resolves and rewrites instead of shadowing
  // the edit. Config-provenance snapshots are always provisional, and
  // pre-basis snapshots pinned with confirmed:false fail this check once
  // (undefined never equals the digest) and upgrade themselves.
  if (snap && snap.model === model && snap.configBasis === resolved.basis) {
    return { level: snap.level, confirmed: false };
  }
  if (snapshotFile && canUseSnapshot()) {
    writeSnapshot(snapshotFile, resolved.level, model, false, resolved.basis);
  }
  return { level: resolved.level, confirmed: false };
}
