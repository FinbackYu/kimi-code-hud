#!/usr/bin/env node
// kimi-code-hud: custom status line (HUD) for Kimi Code CLI.
// Default mode renders a single status line from the stdin JSON snapshot.
// The host kills us after 300ms and falls back silently on any failure, so
// every error path degrades quietly — never log, and never exit non-zero
// except for one deliberate case: running from a disabled/removed plugin
// managed copy, where a non-zero exit hands the line back to the builtin
// status line (that is what makes /plugins disable work).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readPayload } from '../src/payload.mjs';
import { isGitDirty } from '../src/git.mjs';
import { getMetrics } from '../src/metrics.mjs';
import { resolveThinkingLevel } from '../src/thinking.mjs';
import { readQuotaCache, ensureFreshQuota, refreshQuota, HUD_DIR } from '../src/quota.mjs';
import { renderHud } from '../src/render.mjs';
import { managedPluginDisabled } from '../src/plugin-state.mjs';
import { setStatusLineCommand, removeStatusLineCommand } from '../src/toml.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIG_PATH = path.join(HUD_DIR, 'config.json');
const TUI_TOML_PATH = process.env.KIMI_HUD_TUI_TOML
  || path.join(os.homedir(), '.kimi-code', 'tui.toml');

const HELP = `kimi-code-hud — custom status line for Kimi Code CLI

Usage:
  kimi-code-hud                  render the status line (reads JSON from stdin)
  kimi-code-hud --install        register in ~/.kimi-code/tui.toml
  kimi-code-hud --uninstall      remove from ~/.kimi-code/tui.toml
  kimi-code-hud --refresh-quota  refresh the quota cache (internal, silent)
  kimi-code-hud --help           show this help

Config: ~/.kimi-code-hud/config.json  {"layout":"compact|normal|full"}
Env:    KIMI_HUD_LAYOUT overrides config; NO_COLOR / KIMI_HUD_NO_COLOR disable colors.
`;

function resolveLayout() {
  const env = process.env.KIMI_HUD_LAYOUT;
  if (env === 'compact' || env === 'normal' || env === 'full') return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg && (cfg.layout === 'compact' || cfg.layout === 'normal' || cfg.layout === 'full')) {
      return cfg.layout;
    }
  } catch {
    // no config -> default
  }
  return 'normal';
}

function colorEnabled() {
  return !process.env.KIMI_HUD_NO_COLOR && !process.env.NO_COLOR;
}

function backupToml() {
  try {
    if (!fs.existsSync(TUI_TOML_PATH)) return;
    const stamp = new Date().toISOString().slice(0, 19)
      .replace(/[-:]/g, '').replace('T', '-');
    fs.copyFileSync(TUI_TOML_PATH, `${TUI_TOML_PATH}.${stamp}.bak`);
  } catch {
    // best effort
  }
}

function install() {
  const command = `node ${SCRIPT_PATH}`;
  let content = '';
  try { content = fs.readFileSync(TUI_TOML_PATH, 'utf8'); } catch { /* new file */ }
  backupToml();
  fs.mkdirSync(path.dirname(TUI_TOML_PATH), { recursive: true });
  fs.writeFileSync(TUI_TOML_PATH, setStatusLineCommand(content, command));
  process.stdout.write(`Installed status line command in ${TUI_TOML_PATH}\n`);
  process.stdout.write('重启 Kimi Code 或运行 /reload-tui 生效\n');
}

function uninstall() {
  const command = `node ${SCRIPT_PATH}`;
  let content = '';
  try { content = fs.readFileSync(TUI_TOML_PATH, 'utf8'); } catch { /* nothing to do */ }
  backupToml();
  fs.writeFileSync(TUI_TOML_PATH, removeStatusLineCommand(content, command));
  process.stdout.write(`Removed status line command from ${TUI_TOML_PATH}\n`);
  process.stdout.write('重启 Kimi Code 或运行 /reload-tui 生效\n');
}

async function render() {
  const payload = await readPayload();
  if (!payload) {
    process.stdout.write('kimi-code-hud\n');
    return;
  }
  // Hot path: serve the quota cache as-is (stale or not) and kick a detached
  // background refresh when stale. Never blocks on the network.
  ensureFreshQuota({ scriptPath: SCRIPT_PATH });
  const quota = readQuotaCache();
  const metrics = getMetrics(payload.sessionId);
  // The wire log's config.update events carry the effort (new hosts:
  // `thinkingEffort`, including an initial event at session start; older
  // hosts: `thinkingLevel`, only after an in-session change). The
  // per-session snapshot fills the gap when the wire has no such event,
  // so another session's /effort (which rewrites the global config.toml)
  // never moves this session's display.
  metrics.thinkingLevel = resolveThinkingLevel({
    sessionLevel: metrics.thinkingLevel,
    model: payload.model,
    sessionId: payload.sessionId,
  });
  const gitDirty = payload.gitBranch ? isGitDirty(payload.cwd) : false;
  const lines = renderHud({
    payload,
    quota,
    metrics,
    gitDirty,
    layout: resolveLayout(),
    color: colorEnabled(),
  });
  process.stdout.write(`${lines[0]}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes('--refresh-quota')) {
    await refreshQuota(); // silent by contract
    return;
  }
  if (args.includes('--install')) { install(); return; }
  if (args.includes('--uninstall')) { uninstall(); return; }
  // Plugin on/off switch: when this script is the plugin managed copy and
  // the plugin is disabled or removed, exit non-zero with no output so the
  // host falls back to its builtin status line.
  if (managedPluginDisabled(SCRIPT_PATH)) process.exit(1);
  await render();
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    // Last-resort degradation: emit something harmless and exit cleanly.
    try { process.stdout.write('kimi-code-hud\n'); } catch { /* ignore */ }
    process.exit(0);
  });
