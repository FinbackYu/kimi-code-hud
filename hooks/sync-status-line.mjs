#!/usr/bin/env node
// Plugin SessionStart hook: point tui.toml's [status_line] command at this
// plugin's managed copy. Runs on every session start while the plugin is
// enabled, so it also repairs the entry after a reinstall moved the root.
//
// Never touches a [status_line] command that does not reference kimi-hud —
// the user's own status line wins. Stays silent while the HUD is switched
// off via --off ("disabled": true in config.json), or it would resurrect
// the HUD the user meant to keep off. Observational hook: always exits 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectStatusLineCommand,
  isKimiHudCommand,
  setStatusLineCommand,
} from '../src/toml.mjs';
import { isHudDisabled } from '../src/plugin-state.mjs';
import { HUD_DIR } from '../src/paths.mjs';
import { nodeCommand } from '../src/command.mjs';
import { atomicWriteFile } from '../src/fs-store.mjs';

function main() {
  // --off switch: honor the flag before touching anything.
  const hudHome = process.env.KIMI_HUD_HOME || HUD_DIR;
  if (isHudDisabled(path.join(hudHome, 'config.json'))) return;

  const pluginRoot = process.env.KIMI_PLUGIN_ROOT
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const kimiHome = process.env.KIMI_CODE_HOME
    || path.join(os.homedir(), '.kimi-code');
  const tomlPath = path.join(kimiHome, 'tui.toml');

  let content = '';
  try { content = fs.readFileSync(tomlPath, 'utf8'); } catch { /* new file */ }

  // Guard only looks at [status_line]'s own command — a `command` key in any
  // other section (e.g. [editor]) must not trip it.
  const existing = inspectStatusLineCommand(content);
  if (existing.kind === 'unknown') return;
  if (existing.kind === 'parsed' && !isKimiHudCommand(existing.value)) return;

  const next = setStatusLineCommand(
    content,
    nodeCommand(path.join(pluginRoot, 'bin', 'kimi-hud.mjs')),
  );
  if (next === content) return;
  atomicWriteFile(tomlPath, next);
}

try { main(); } catch { /* fail-open */ }
process.exit(0);
