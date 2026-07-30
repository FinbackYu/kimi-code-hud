// Managed-plugin enablement gate. When kimi-hud runs from a Kimi Code plugin
// managed copy (<kimiHome>/plugins/managed/<id>/...), the status line should
// only render while the plugin record in plugins/installed.json is enabled.
// A plain git-checkout install (any other path) always renders.
//
// installed.json schema (agent-core-v2 plugin store):
//   { "version": 1, "plugins": [ { "id", "root", "enabled", ... } ] }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANAGED_MARKER = `${path.sep}plugins${path.sep}managed${path.sep}`;

/**
 * @param {string} scriptPath absolute path of bin/kimi-hud.mjs
 * @returns {string|null} plugin id when running from a managed copy
 */
export function managedPluginId(scriptPath) {
  const i = scriptPath.indexOf(MANAGED_MARKER);
  if (i < 0) return null;
  const rest = scriptPath.slice(i + MANAGED_MARKER.length);
  const id = rest.split(path.sep)[0];
  return id || null;
}

/**
 * @param {string} scriptPath absolute path of bin/kimi-hud.mjs
 * @param {string} [kimiHome] defaults to $KIMI_CODE_HOME or ~/.kimi-code
 * @returns {boolean} true when the HUD must stay silent (host falls back to
 *   the builtin status line)
 */
export function managedPluginDisabled(scriptPath, kimiHome) {
  const id = managedPluginId(scriptPath);
  if (!id) return false;
  const home = kimiHome
    || process.env.KIMI_CODE_HOME
    || path.join(os.homedir(), '.kimi-code');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed.json'), 'utf8'));
  } catch (err) {
    // Record file gone => plugin was removed => stay silent. Malformed JSON
    // fails open so a schema change can never blank out the status line.
    return err && err.code === 'ENOENT';
  }
  const plugins = data && Array.isArray(data.plugins) ? data.plugins : null;
  if (!plugins) return false;
  const record = plugins.find((p) => p && p.id === id);
  if (!record) return true; // managed copy on disk but no install record
  return record.enabled === false;
}
