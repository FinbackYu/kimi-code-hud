import fs from 'node:fs';
import path from 'node:path';
import { HUD_DIR } from './quota.mjs';
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
 * is pinned per sessionId under ~/.kimi-code-hud/thinking-<sessionId>.json.
 */
function snapshotPath(snapshotDir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(snapshotDir, `thinking-${safe}.json`);
}

function readSnapshot(snapshotDir, sessionId) {
  try {
    const snap = JSON.parse(fs.readFileSync(snapshotPath(snapshotDir, sessionId), 'utf8'));
    if (snap && typeof snap.level === 'string' && snap.level.length > 0) return snap;
  } catch { /* no snapshot yet */ }
  return null;
}

function writeSnapshot(snapshotDir, sessionId, level, model) {
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(snapshotPath(snapshotDir, sessionId), JSON.stringify({ level, model }));
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
function resolveFromConfig(model, configPath) {
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return 'on'; // host default: thinking enabled
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
 * Returns:
 *  - 'off'        thinking disabled (render no suffix)
 *  - 'on'         boolean thinking enabled (render " thinking")
 *  - '<effort>'   concrete effort like "high" (render " thinking:<effort>")
 *
 * @param {object} opts
 * @param {string|null} opts.sessionLevel thinkingLevel from the session log
 * @param {string} opts.model payload model display string
 * @param {string} [opts.configPath]
 * @param {string|null} [opts.sessionId] enables the per-session snapshot
 * @param {string} [opts.snapshotDir]
 * @returns {string}
 */
export function resolveThinkingLevel({
  sessionLevel,
  model,
  configPath = CONFIG_TOML_PATH,
  sessionId = null,
  snapshotDir = HUD_DIR,
}) {
  if (typeof sessionLevel === 'string' && sessionLevel.length > 0) {
    if (sessionId) writeSnapshot(snapshotDir, sessionId, sessionLevel, model);
    return sessionLevel;
  }
  if (sessionId) {
    const snap = readSnapshot(snapshotDir, sessionId);
    if (snap && snap.model === model) return snap.level;
  }
  const level = resolveFromConfig(model, configPath);
  if (sessionId) writeSnapshot(snapshotDir, sessionId, level, model);
  return level;
}
