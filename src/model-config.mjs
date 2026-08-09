// Shared readers for the host's config.toml model and provider tables. Quota
// gating, provider-usage adapters, and thinking-level fallback all consume
// this same host-owned config snapshot, so the parsing lives here once.

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
 * Read a TOML basic string written by Kimi Code's JSON-based catalog writer.
 * Unlike stringValue, this decodes escaped quotes and backslashes, which
 * matters for provider credentials. Returns null for malformed values.
 * @param {string} section raw table text
 * @param {string} key
 * @returns {string|null}
 */
export function decodedStringValue(section, key) {
  if (typeof section !== 'string') return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = section.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`, 'm'));
  if (!m) return null;
  try {
    const value = JSON.parse(m[1]);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
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
 * Resolve one model alias into the provider and upstream model id used for
 * billing. The complete config snapshot is required so no model or credential
 * data is persisted by this helper.
 * @param {object} opts
 * @param {string} opts.name alias, display name, or upstream model id
 * @param {string} opts.configText complete config.toml text
 * @returns {{alias: string, provider: string|null, model: string|null, displayName: string|null}|null}
 */
export function resolveModelConfig({ name, configText } = {}) {
  if (typeof name !== 'string' || !name || typeof configText !== 'string') return null;
  const re = /\[models\."([^"]+)"\]\s*\n([\s\S]*?)(?=\n\[|$)/g;
  let m;
  while ((m = re.exec(configText)) !== null) {
    const [, alias, body] = m;
    const model = decodedStringValue(body, 'model');
    const displayName = decodedStringValue(body, 'display_name');
    if (alias !== name && model !== name && displayName !== name) continue;
    return {
      alias,
      provider: decodedStringValue(body, 'provider'),
      model,
      displayName,
    };
  }
  return null;
}

/**
 * Find a flat [providers.<name>] or [providers."<name>"] table.
 * Provider names are matched exactly; no model or transport-type inference is
 * performed here because those names select credential-bearing adapters.
 * @param {string} text
 * @param {string} name
 * @returns {string|null}
 */
export function findProviderTable(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string' || !name) return null;
  const re = /\[providers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*\n([\s\S]*?)(?=\n\[|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const providerName = m[1] || m[2];
    if (providerName === name) return m[3];
  }
  return null;
}

/**
 * Resolve the small provider-config subset needed by usage adapters. The
 * returned object is deliberately never persisted or logged by this module.
 * @param {object} opts
 * @param {string} opts.provider exact provider table name
 * @param {string} opts.configText complete config.toml text
 * @returns {{provider: string, type: string|null, baseUrl: string|null, apiKey: string|null}|null}
 */
export function resolveProviderConfig({ provider, configText } = {}) {
  const table = findProviderTable(configText, provider);
  if (table === null) return null;
  return {
    provider,
    type: decodedStringValue(table, 'type'),
    baseUrl: decodedStringValue(table, 'base_url'),
    apiKey: decodedStringValue(table, 'api_key'),
  };
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
