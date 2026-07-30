#!/usr/bin/env node
// Plugin SessionStart hook: point tui.toml's [status_line] command at this
// plugin's managed copy. Runs on every session start while the plugin is
// enabled, so it also repairs the entry after a reinstall moved the root.
//
// Never touches a [status_line] command that does not reference kimi-hud —
// the user's own status line wins. Observational hook: always exits 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStatusLineCommand, setStatusLineCommand } from '../src/toml.mjs';

function main() {
  const pluginRoot = process.env.KIMI_PLUGIN_ROOT
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const kimiHome = process.env.KIMI_CODE_HOME
    || path.join(os.homedir(), '.kimi-code');
  const tomlPath = path.join(kimiHome, 'tui.toml');

  let content = '';
  try { content = fs.readFileSync(tomlPath, 'utf8'); } catch { /* new file */ }

  // Guard only looks at [status_line]'s own command — a `command` key in any
  // other section (e.g. [editor]) must not trip it.
  const existing = getStatusLineCommand(content);
  if (existing !== null && !existing.includes('kimi-hud')) return;

  const next = setStatusLineCommand(content, `node ${path.join(pluginRoot, 'bin', 'kimi-hud.mjs')}`);
  if (next === content) return;
  fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
  fs.writeFileSync(tomlPath, next);
}

try { main(); } catch { /* fail-open */ }
process.exit(0);
