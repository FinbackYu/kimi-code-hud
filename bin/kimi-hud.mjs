#!/usr/bin/env node
// Thin command router. Rendering is the data plane (render-runtime.mjs);
// config mutation is the control plane (management-service.mjs).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  disableHud,
  enableHud,
  installHud,
  uninstallHud,
} from '../src/management-service.mjs';
import { resolveRuntimePaths } from '../src/paths.mjs';
import { refreshQuota } from '../src/quota.mjs';
import { renderStatusLine } from '../src/render-runtime.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOOK_SCRIPT_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  '..',
  'hooks',
  'sync-status-line.mjs',
);
const RUNTIME_PATHS = resolveRuntimePaths();
const COMMAND_CONTEXT = {
  scriptPath: SCRIPT_PATH,
  hookScriptPath: HOOK_SCRIPT_PATH,
  paths: RUNTIME_PATHS,
  stdout: process.stdout,
};

const HELP = `kimi-code-hud — custom status line for Kimi Code CLI

Usage:
  kimi-code-hud                  render the status line (reads JSON from stdin)
  kimi-code-hud --install        register in ~/.kimi-code/tui.toml (+ self-heal hook)
  kimi-code-hud --uninstall      remove from ~/.kimi-code/tui.toml (+ the hook)
  kimi-code-hud --on             re-enable: write the command back (+ ensure the hook)
  kimi-code-hud --off            switch off (reversible): strip the command, hook stays dormant
  kimi-code-hud --refresh-quota  refresh the quota cache (internal, silent)
  kimi-code-hud --help           show this help

Config: ~/.kimi-code-hud/config.json  {"layout":"compact|normal"}
Env:    KIMI_HUD_LAYOUT overrides config; NO_COLOR / KIMI_HUD_NO_COLOR disable colors.
        KIMI_HUD_THEME=dark|light pins the badge palette (default: tui.toml's
        theme, with auto resolved via COLORFGBG, falling back to dark).
`;

function adminFailure(action, err) {
  const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
  try { process.stderr.write(`kimi-code-hud: ${action} failed${detail}\n`); } catch { /* ignore */ }
  return 1;
}

async function renderMain() {
  try {
    const result = await renderStatusLine({
      scriptPath: SCRIPT_PATH,
      paths: RUNTIME_PATHS,
    });
    if (result.line !== null) process.stdout.write(`${result.line}\n`);
    return result.exitCode;
  } catch {
    // Rendering is fail-open: diagnostics never leak into the status line.
    try { process.stdout.write('kimi-code-hud\n'); } catch { /* ignore */ }
    return 0;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.includes('--refresh-quota')) {
    try {
      await refreshQuota({
        credentialsPath: RUNTIME_PATHS.credentialsPath,
        cachePath: RUNTIME_PATHS.quotaCachePath,
        lockPath: RUNTIME_PATHS.quotaLockPath,
        lockToken: process.env.KIMI_HUD_QUOTA_LOCK_TOKEN,
      });
    } catch {
      // Detached refresh is silent by contract.
    }
    return 0;
  }
  const actions = [
    ['--install', 'install', installHud],
    ['--uninstall', 'uninstall', uninstallHud],
    ['--on', 'enable', enableHud],
    ['--off', 'disable', disableHud],
  ];
  for (const [flag, name, action] of actions) {
    if (!args.includes(flag)) continue;
    try {
      action(COMMAND_CONTEXT);
      return 0;
    } catch (err) {
      return adminFailure(name, err);
    }
  }
  return renderMain();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => process.exit(adminFailure('command', err)));
