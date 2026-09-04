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
 * with `confirmed` recording the provenance: true when the level came from
 * the wire journal, false while it is only inferred from config.toml.
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

function writeSnapshot(snapshotFile, level, model, confirmed) {
  try {
    atomicWriteFile(
      snapshotFile,
      JSON.stringify({ level, model, confirmed }),
    );
  } catch { /* best effort */ }
}

/**
 * Resolve the thinking level from config.toml: [thinking] config > model
 * default_effort > boolean "on", mirroring the host's own resolution
 * (defaultThinkingEffortFor / resolveThinkingEffort): a model whose table
 * explicitly declares capabilities without thinking resolves to 'off', and
 * an always_thinking model can never resolve to 'off'.
 * @param {string} model payload model display string
 * @param {string} configPath
 * @returns {string}
 */
function resolveFromConfig(model, configPath, configText = undefined) {
  let text = '';
  if (typeof configText === 'string') {
    text = configText;
  } else {
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch {
      return 'on'; // host default: thinking enabled
    }
  }

  const thinking = tableText(text, 'thinking');
  const modelTable = findModelTable(text, model);
  const caps = modelTable !== null ? stringArrayValue(modelTable, 'capabilities') : null;
  const alwaysThinking = caps !== null && caps.includes('always_thinking');
  const thinkingCapable = alwaysThinking
    || (caps !== null && caps.includes('thinking'))
    || (modelTable !== null && boolValue(modelTable, 'adaptive_thinking') === true);

  // Host: [thinking] enabled=false forces off — except on always_thinking
  // models, where an off state would be a lie (upstream keeps reasoning).
  if (thinking !== null && boolValue(thinking, 'enabled') === false && !alwaysThinking) return 'off';

  const globalEffort = thinking !== null ? stringValue(thinking, 'effort') : null;
  const hasEfforts = modelTable !== null && /^\s*support_efforts\s*=/m.test(modelTable);
  if (!hasEfforts) {
    // Explicit capabilities without thinking resolve to 'off' upstream; a
    // configured global effort still shows on compatible (non-kimi)
    // protocols, which pass the value through to the backend.
    if (caps !== null && !thinkingCapable) return globalEffort ? 'on' : 'off';
    return 'on'; // boolean model (or no declared capabilities) -> plain " thinking"
  }

  const modelDefault = modelTable !== null ? stringValue(modelTable, 'default_effort') : null;
  if (alwaysThinking) {
    // Skip 'off' values and fall back to the model's own default.
    return (globalEffort && globalEffort !== 'off' ? globalEffort : null) ?? modelDefault ?? 'on';
  }
  return globalEffort ?? modelDefault ?? 'on';
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
      writeSnapshot(snapshotFile, sessionLevel, model, true);
    }
    return { level: sessionLevel, confirmed: true };
  }
  if (snapshotFile && canUseSnapshot()) {
    const snap = readSnapshot(snapshotFile);
    // Snapshots predate the confirmed flag: treat a missing flag as
    // confirmed so long-running sessions keep their previous rendering.
    if (snap && snap.model === model) {
      return { level: snap.level, confirmed: snap.confirmed !== false };
    }
  }
  const level = resolveFromConfig(model, configPath, configText);
  if (snapshotFile && canUseSnapshot()) writeSnapshot(snapshotFile, level, model, false);
  return { level, confirmed: false };
}
