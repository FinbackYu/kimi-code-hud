// Shared readers for the host's config.toml model tables. Both the quota
// gating (which provider serves the active model) and the thinking-level
// fallback (capabilities/support_efforts of that model) parse the same
// [models."<alias>"] tables, so the parsing lives here exactly once.

import fs from 'node:fs';
import { CONFIG_TOML_PATH } from './paths.mjs';

export { CONFIG_TOML_PATH };

/**
 * The managed Kimi Code subscription provider. It is the only provider the
 * /usages quota API describes; models served by any other provider must not
 * show the subscription quota bars.
 */
export const MANAGED_KIMI_PROVIDER = 'managed:kimi-code';

/**
 * Minimal TOML section extractor: returns the raw text of a `[name]` table,
 * or null when absent. Only used for flat key = value tables ([thinking],
 * [models."<alias>"]); sufficient for the host's own config style.
 * @param {string} text
 * @param {string} table literal table header without brackets, e.g. 'thinking'
 * @returns {string|null}
 */
export function tableText(text, table) {
  const re = new RegExp(`\\[${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`);
  const m = text.match(re);
  return m ? m[1] : null;
}

/**
 * @param {string} section raw table text
 * @param {string} key
 * @returns {boolean|null}
 */
export function boolValue(section, key) {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, 'm'));
  return m ? m[1] === 'true' : null;
}

/**
 * @param {string} section raw table text
 * @param {string} key
 * @returns {string|null}
 */
export function stringValue(section, key) {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

/**
 * Parse an inline string-array value: `capabilities = [ "thinking", ... ]`.
 * Returns null when the key is absent (never declared).
 * @param {string} section raw table text
 * @param {string} key
 * @returns {string[]|null}
 */
export function stringArrayValue(section, key) {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/**
 * Find the [models."<alias>"] table whose alias, display_name, or model id
 * matches the given string. Returns the raw table text or null.
 * @param {string} text config.toml content
 * @param {string} name alias ("kimi-code/k3"), display name ("K3"), or model id ("k3")
 * @returns {string|null}
 */
export function findModelTable(text, name) {
  if (!name) return null;
  const re = /\[models\."([^"]+)"\]\s*\n([\s\S]*?)(?=\n\[|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, alias, body] = m;
    if (alias === name) return body;
    if (stringValue(body, 'display_name') === name) return body;
    if (stringValue(body, 'model') === name) return body;
  }
  return null;
}

/**
 * Resolve which provider serves the session's active model. The wire's
 * modelAlias is exact and preferred; the payload's model display string is
 * the fallback. Returns the provider name (e.g. "managed:kimi-code",
 * "anthropic") or null when it cannot be determined (missing config,
 * unknown model, or a model table without a provider key).
 * @param {object} opts
 * @param {string|null} [opts.modelAlias] alias from the wire's config.update
 * @param {string|null} [opts.modelDisplay] model display string from the payload
 * @param {string} [opts.configPath]
 * @returns {string|null}
 */
export function resolveModelProvider({
  modelAlias = null,
  modelDisplay = null,
  configPath = CONFIG_TOML_PATH,
  configText = undefined,
} = {}) {
  let text;
  if (typeof configText === 'string') {
    text = configText;
  } else {
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch {
      return null;
    }
  }
  for (const name of [modelAlias, modelDisplay]) {
    if (!name) continue;
    const table = findModelTable(text, name);
    if (table !== null) return stringValue(table, 'provider');
  }
  return null;
}
