import fs from 'node:fs';

import { nodeCommand } from './command.mjs';
import { atomicWriteFile } from './fs-store.mjs';
import { ensureHooksBlock, removeHooksBlock } from './hooks.mjs';
import { resolveRuntimePaths } from './paths.mjs';
import {
  inspectStatusLineCommand,
  isKimiHudCommand,
  removeStatusLineCommand,
  setStatusLineCommand,
} from './toml.mjs';

function backupFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stamp = new Date().toISOString().slice(0, 19)
      .replace(/[-:]/g, '').replace('T', '-');
    fs.copyFileSync(filePath, `${filePath}.${stamp}.bak`);
  } catch {
    // Backups are best effort; the atomic target write remains authoritative.
  }
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function readHudConfig(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

function writeHudConfig(configPath, config) {
  atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

function syncHooksBlock({ installing, hookScriptPath, paths, stdout }) {
  const hookCommand = nodeCommand(hookScriptPath);
  const content = readText(paths.configTomlPath);
  const next = installing
    ? ensureHooksBlock(content, hookCommand)
    : removeHooksBlock(content, hookCommand);
  if (next === content) return false;
  backupFile(paths.configTomlPath);
  atomicWriteFile(paths.configTomlPath, next);
  writeLine(
    stdout,
    installing
      ? `Registered SessionStart self-heal hook in ${paths.configTomlPath}`
      : `Removed SessionStart hook from ${paths.configTomlPath}`,
  );
  return true;
}

function writeStatusLine({ scriptPath, paths, installing, stdout }) {
  const command = nodeCommand(scriptPath);
  const content = readText(paths.tuiTomlPath);
  backupFile(paths.tuiTomlPath);
  // Unlike the SessionStart hook, management commands still overwrite a
  // third-party status line — but say so instead of staying silent.
  if (installing) {
    const existing = inspectStatusLineCommand(content);
    if (existing.kind === 'parsed' && !isKimiHudCommand(existing.value)) {
      writeLine(stdout, `Replaced existing statusLine command: ${existing.value}`);
    }
  }
  const next = installing
    ? setStatusLineCommand(content, command)
    : removeStatusLineCommand(content, command);
  atomicWriteFile(paths.tuiTomlPath, next);
}

function resolvedOptions(options = {}) {
  return {
    ...options,
    paths: options.paths || resolveRuntimePaths(),
    stdout: options.stdout || process.stdout,
  };
}

export function installHud(options = {}) {
  const opts = resolvedOptions(options);
  writeStatusLine({ ...opts, installing: true });
  writeLine(opts.stdout, `Installed status line command in ${opts.paths.tuiTomlPath}`);
  syncHooksBlock({ ...opts, installing: true });
  writeLine(opts.stdout, '重启 Kimi Code 或运行 /reload-tui 生效');
}

export function uninstallHud(options = {}) {
  const opts = resolvedOptions(options);
  writeStatusLine({ ...opts, installing: false });
  writeLine(opts.stdout, `Removed status line command from ${opts.paths.tuiTomlPath}`);
  syncHooksBlock({ ...opts, installing: false });
  writeLine(opts.stdout, '重启 Kimi Code 或运行 /reload-tui 生效');
}

export function disableHud(options = {}) {
  const opts = resolvedOptions(options);
  const config = readHudConfig(opts.paths.configPath);
  config.disabled = true;
  writeHudConfig(opts.paths.configPath, config);
  writeLine(opts.stdout, `Set "disabled": true in ${opts.paths.configPath}`);
  writeStatusLine({ ...opts, installing: false });
  writeLine(opts.stdout, `Removed status line command from ${opts.paths.tuiTomlPath}`);
  writeLine(opts.stdout, '重启 Kimi Code 或运行 /reload-tui 生效');
}

export function enableHud(options = {}) {
  const opts = resolvedOptions(options);
  const config = readHudConfig(opts.paths.configPath);
  if ('disabled' in config) {
    delete config.disabled;
    writeHudConfig(opts.paths.configPath, config);
    writeLine(opts.stdout, `Removed "disabled" flag from ${opts.paths.configPath}`);
  }
  writeStatusLine({ ...opts, installing: true });
  writeLine(opts.stdout, `Installed status line command in ${opts.paths.tuiTomlPath}`);
  syncHooksBlock({ ...opts, installing: true });
  writeLine(opts.stdout, '重启 Kimi Code 或运行 /reload-tui 生效');
}

/** Best-effort self-clean used only by a disabled managed plugin copy. */
export function removeManagedStatusLine({ scriptPath, tuiTomlPath }) {
  try {
    const content = fs.readFileSync(tuiTomlPath, 'utf8');
    const next = removeStatusLineCommand(content, nodeCommand(scriptPath));
    if (next !== content) atomicWriteFile(tuiTomlPath, next);
  } catch {
    // The managed-plugin gate must remain silent.
  }
}
