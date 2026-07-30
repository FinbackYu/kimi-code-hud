import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_TOML_PATH = path.join(os.homedir(), '.kimi-code', 'config.toml');

/**
 * Minimal TOML section extractor: returns the raw text of a `[name]` table,
 * or null when absent. Only used for flat key = value tables ([thinking],
 * [models."<alias>"]); sufficient for the host's own config style.
 * @param {string} text
 * @param {string} table literal table header without brackets, e.g. 'thinking'
 * @returns {string|null}
 */
function tableText(text, table) {
  const re = new RegExp(`\\[${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`);
  const m = text.match(re);
  return m ? m[1] : null;
}

function boolValue(section, key) {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, 'm'));
  return m ? m[1] === 'true' : null;
}

function stringValue(section, key) {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

/**
 * Find the [models."<alias>"] table whose display_name or model id matches
 * the payload's model display string. Returns the raw table text or null.
 * @param {string} text config.toml content
 * @param {string} modelDisplay e.g. "K3" or "kimi-for-coding"
 * @returns {string|null}
 */
function findModelTable(text, modelDisplay) {
  if (!modelDisplay) return null;
  const re = /\[models\."([^"]+)"\]\s*\n([\s\S]*?)(?=\n\[|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, alias, body] = m;
    if (alias === modelDisplay) return body;
    if (stringValue(body, 'display_name') === modelDisplay) return body;
    if (stringValue(body, 'model') === modelDisplay) return body;
  }
  return null;
}

/**
 * Resolve the thinking level to display, mirroring the host's fallback
 * chain: in-session change (wire config.update) > [thinking] config >
 * model default_effort > boolean "on".
 *
 * Returns:
 *  - 'off'        thinking disabled (render no suffix)
 *  - 'on'         boolean thinking enabled (render " thinking")
 *  - '<effort>'   concrete effort like "high" (render " thinking: <effort>")
 *
 * @param {object} opts
 * @param {string|null} opts.sessionLevel thinkingLevel from the session log
 * @param {string} opts.model payload model display string
 * @param {string} [opts.configPath]
 * @returns {string}
 */
export function resolveThinkingLevel({ sessionLevel, model, configPath = CONFIG_TOML_PATH }) {
  if (typeof sessionLevel === 'string' && sessionLevel.length > 0) return sessionLevel;

  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return 'on'; // host default: thinking enabled
  }

  const thinking = tableText(text, 'thinking');
  if (thinking !== null && boolValue(thinking, 'enabled') === false) return 'off';

  const globalEffort = thinking !== null ? stringValue(thinking, 'effort') : null;
  const modelTable = findModelTable(text, model);
  const hasEfforts = modelTable !== null && /^\s*support_efforts\s*=/m.test(modelTable);
  if (!hasEfforts) return 'on'; // boolean model -> plain " thinking"

  const modelDefault = modelTable !== null ? stringValue(modelTable, 'default_effort') : null;
  return globalEffort ?? modelDefault ?? 'on';
}
