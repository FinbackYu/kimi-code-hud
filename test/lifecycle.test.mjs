import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeCommand } from '../src/command.mjs';
import { inspectStatusLineCommand } from '../src/toml.mjs';

// Plugin lifecycle isolation (H05, dynamic half): install / update / --off /
// --on / uninstall / third-party coexistence / SessionStart self-heal /
// partial write failure, all executed through the REAL CLI and hook processes
// inside a sandboxed HOME + KIMI_CODE_HOME + KIMI_HUD_HOME. Nothing here may
// touch the user's real configuration.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'kimi-hud.mjs');
const HOOK = path.join(REPO, 'hooks', 'sync-status-line.mjs');

const POSIX_SKIP = process.platform === 'win32'
  ? 'drives /bin/sh and POSIX path semantics; Windows needs its own verified run'
  : false;

// Unrelated settings that must survive every lifecycle step byte-for-byte.
const UNRELATED_TUI = '[theme]\nname = "dark"\n\n[editor]\ncommand = "vim"\n';
const UNRELATED_CONFIG = 'model = "K3-256k"\n\n[[hooks]]\nevent = "Stop"\ncommand = "/other/bin"\n';
const FOREIGN_TUI = '[theme]\nname = "dark"\n\n[status_line]\ncommand = "node /opt/other-hud/render.mjs"\nitems = ["model"]\n';

const RENDER_PAYLOAD = (root) => JSON.stringify({
  model: 'K3',
  cwd: root,
  gitBranch: '',
  permissionMode: 'manual',
  sessionId: 'lifecycle-probe',
});

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function setup({ tui = UNRELATED_TUI, config = UNRELATED_CONFIG } = {}) {
  // realpathSync: on macOS /var is a symlink to /private/var, and the CLI
  // registers its own script path via fileURLToPath(import.meta.url), which
  // reports the resolved location. Building every assertion path from the
  // same resolved root keeps both sides of each comparison identical.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-lifecycle-')));
  const kimiHome = path.join(root, 'kimi-home');
  const hudHome = path.join(root, 'hud-home');
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.mkdirSync(hudHome, { recursive: true });
  // HOME is pinned too, so even a fallback os.homedir() lookup lands in the
  // sandbox instead of the user's real home.
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    KIMI_CODE_HOME: kimiHome,
    KIMI_HUD_HOME: hudHome,
  };
  const tuiToml = path.join(kimiHome, 'tui.toml');
  const configToml = path.join(kimiHome, 'config.toml');
  const hudConfig = path.join(hudHome, 'config.json');
  if (tui !== null) fs.writeFileSync(tuiToml, tui);
  if (config !== null) fs.writeFileSync(configToml, config);
  return {
    root, env, kimiHome, hudHome, tuiToml, configToml, hudConfig,
    readTui: () => fs.readFileSync(tuiToml, 'utf8'),
    readConfigToml: () => fs.readFileSync(configToml, 'utf8'),
    statusCommand: () => inspectStatusLineCommand(fs.readFileSync(tuiToml, 'utf8')),
    runCli: (args, input = '') =>
      spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8' }),
    runHook: (hookPath = HOOK) =>
      spawnSync(process.execPath, [hookPath], { env, encoding: 'utf8' }),
    runShell: (command, input = '') =>
      spawnSync('/bin/sh', ['-c', command], { env, input, encoding: 'utf8' }),
  };
}

function copyRuntime(targetRoot) {
  for (const part of ['bin', 'src', 'hooks']) {
    fs.cpSync(path.join(REPO, part), path.join(targetRoot, part), { recursive: true });
  }
}

function hookBlockCount(content) {
  return content.split('kimi-code-hud hooks START').length - 1;
}

test('install registers a command that really renders and preserves unrelated settings', { skip: POSIX_SKIP }, () => {
  const s = setup();
  const result = s.runCli(['--install']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Installed status line command/);
  assert.match(result.stdout, /Registered SessionStart self-heal hook/);

  assert.deepEqual(s.statusCommand(), { kind: 'parsed', value: nodeCommand(BIN) });
  assert.ok(s.readTui().includes('[theme]\nname = "dark"'));
  assert.ok(s.readTui().includes('[editor]\ncommand = "vim"'));
  const configToml = s.readConfigToml();
  assert.equal(hookBlockCount(configToml), 1);
  assert.ok(configToml.includes('model = "K3-256k"'));
  assert.ok(configToml.includes('[[hooks]]\nevent = "Stop"\ncommand = "/other/bin"'));

  // The stored command must survive the TOML round trip and render for real.
  const rendered = s.runShell(s.statusCommand().value, RENDER_PAYLOAD(s.root));
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stderr, '');
  assert.ok(rendered.stdout.includes('K3'), rendered.stdout);

  // Right after install the hook must agree: running it changes nothing.
  const tuiBefore = s.readTui();
  const hook = s.runHook();
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(s.readTui(), tuiBefore);
});

test('repeated install is byte-stable and registers exactly one command and hook', { skip: POSIX_SKIP }, () => {
  const s = setup();
  assert.equal(s.runCli(['--install']).status, 0);
  const tuiOnce = s.readTui();
  const configOnce = s.readConfigToml();
  assert.equal(s.runCli(['--install']).status, 0);
  assert.equal(s.readTui(), tuiOnce);
  assert.equal(s.readConfigToml(), configOnce);
  assert.equal(hookBlockCount(s.readConfigToml()), 1);
});

test('uninstall restores tui.toml and config.toml byte-for-byte and is repeatable', { skip: POSIX_SKIP }, () => {
  const s = setup();
  fs.writeFileSync(s.hudConfig, '{"layout":"full"}\n');
  assert.equal(s.runCli(['--install']).status, 0);
  assert.equal(s.runCli(['--uninstall']).status, 0);

  assert.equal(s.statusCommand().kind, 'absent');
  assert.equal(s.readTui(), UNRELATED_TUI);
  assert.equal(s.readConfigToml(), UNRELATED_CONFIG);
  // Uninstall never touches the HUD config.json.
  assert.deepEqual(JSON.parse(fs.readFileSync(s.hudConfig, 'utf8')), { layout: 'full' });

  const tuiAfterFirst = s.readTui();
  assert.equal(s.runCli(['--uninstall']).status, 0);
  assert.equal(s.readTui(), tuiAfterFirst);
  assert.equal(hookBlockCount(s.readConfigToml()), 0);
});

test('--off strips the command, keeps the hook dormant, and the hook does not resurrect it', { skip: POSIX_SKIP }, () => {
  const s = setup();
  fs.writeFileSync(s.hudConfig, '{"layout":"full"}\n');
  assert.equal(s.runCli(['--install']).status, 0);
  assert.equal(s.runCli(['--off']).status, 0);

  assert.deepEqual(
    JSON.parse(fs.readFileSync(s.hudConfig, 'utf8')),
    { layout: 'full', disabled: true },
  );
  assert.equal(s.statusCommand().kind, 'absent');
  assert.equal(hookBlockCount(s.readConfigToml()), 1, 'hook stays registered but dormant');

  const tuiWhileOff = s.readTui();
  const hook = s.runHook();
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(s.readTui(), tuiWhileOff, 'dormant hook must not re-add the command');
});

test('--on restores the command, clears only the disabled flag, and the hook agrees', { skip: POSIX_SKIP }, () => {
  const s = setup();
  fs.writeFileSync(s.hudConfig, '{"layout":"full","note":"keep"}\n');
  assert.equal(s.runCli(['--install']).status, 0);
  assert.equal(s.runCli(['--off']).status, 0);
  assert.equal(s.runCli(['--on']).status, 0);

  assert.deepEqual(
    JSON.parse(fs.readFileSync(s.hudConfig, 'utf8')),
    { layout: 'full', note: 'keep' },
  );
  assert.deepEqual(s.statusCommand(), { kind: 'parsed', value: nodeCommand(BIN) });
  assert.equal(hookBlockCount(s.readConfigToml()), 1);

  const rendered = s.runShell(s.statusCommand().value, RENDER_PAYLOAD(s.root));
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.ok(rendered.stdout.includes('K3'), rendered.stdout);

  const tuiBefore = s.readTui();
  assert.equal(s.runHook().status, 0);
  assert.equal(s.readTui(), tuiBefore);
});

test('reinstall at a moved root refreshes command and hook in place and self-heals tui.toml', { skip: POSIX_SKIP }, () => {
  const s = setup();
  const oldRoot = path.join(s.root, 'old copy', 'kimi-code-hud');
  copyRuntime(oldRoot);
  const oldBin = path.join(oldRoot, 'bin', 'kimi-hud.mjs');
  const oldHook = path.join(oldRoot, 'hooks', 'sync-status-line.mjs');

  const installOld = spawnSync(process.execPath, [oldBin, '--install'], {
    env: s.env, encoding: 'utf8',
  });
  assert.equal(installOld.status, 0, installOld.stderr);
  assert.deepEqual(s.statusCommand(), { kind: 'parsed', value: nodeCommand(oldBin) });
  assert.ok(s.readConfigToml().includes(oldHook));

  // A host upgrade wipes tui.toml's [status_line]; the SessionStart hook of
  // the installed copy repairs it on the next session start.
  fs.writeFileSync(s.tuiToml, UNRELATED_TUI);
  assert.equal(s.runHook(oldHook).status, 0);
  assert.deepEqual(s.statusCommand(), { kind: 'parsed', value: nodeCommand(oldBin) });

  // Update: the managed copy moves to a hostile new root; a reinstall from
  // there must refresh the stored command AND the registered hook in place.
  const newRoot = path.join(s.root, '新位置 hud');
  copyRuntime(newRoot);
  const newBin = path.join(newRoot, 'bin', 'kimi-hud.mjs');
  const newHook = path.join(newRoot, 'hooks', 'sync-status-line.mjs');
  const installNew = spawnSync(process.execPath, [newBin, '--install'], {
    env: s.env, encoding: 'utf8',
  });
  assert.equal(installNew.status, 0, installNew.stderr);

  assert.deepEqual(s.statusCommand(), { kind: 'parsed', value: nodeCommand(newBin) });
  const configToml = s.readConfigToml();
  assert.equal(hookBlockCount(configToml), 1);
  assert.ok(configToml.includes(newHook));
  assert.ok(!configToml.includes('old copy'), 'stale hook path refreshed in place');

  const rendered = s.runShell(nodeCommand(newBin), RENDER_PAYLOAD(s.root));
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.ok(rendered.stdout.includes('K3'), rendered.stdout);

  // The new copy's own hook is in a steady state with the new command.
  const tuiBefore = s.readTui();
  assert.equal(s.runHook(newHook).status, 0);
  assert.equal(s.readTui(), tuiBefore);
});

test('a third-party status line is announced when replaced and never touched by the hook', { skip: POSIX_SKIP }, () => {
  const s = setup({ tui: FOREIGN_TUI, config: null });
  const result = s.runCli(['--install']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Replaced existing statusLine command: node \/opt\/other-hud\/render\.mjs/);
  assert.deepEqual(s.statusCommand(), { kind: 'parsed', value: nodeCommand(BIN) });
  const replaced = s.readTui();
  assert.ok(replaced.includes('items = ["model"]'), 'foreign keys survive the replacement');
  assert.ok(replaced.includes('[theme]\nname = "dark"'));

  // Uninstall removes only our command; the section keeps the foreign keys.
  assert.equal(s.runCli(['--uninstall']).status, 0);
  const afterUninstall = s.readTui();
  assert.equal(inspectStatusLineCommand(afterUninstall).kind, 'absent');
  assert.ok(afterUninstall.includes('items = ["model"]'));
  assert.ok(afterUninstall.includes('[status_line]'));

  // The SessionStart hook must leave a foreign command alone, always.
  const foreign = setup({ tui: FOREIGN_TUI, config: null });
  const tuiBefore = foreign.readTui();
  assert.equal(foreign.runHook().status, 0);
  assert.equal(foreign.readTui(), tuiBefore);
});

const READONLY_SKIP = (typeof process.getuid === 'function' && process.getuid() === 0)
  ? 'root ignores directory permissions, so the read-only scenario cannot be simulated'
  : false;
const WRITABLE = 0o755;
const READONLY = 0o555;

test('a read-only config directory fails loudly and leaves tui.toml byte-identical', { skip: READONLY_SKIP || POSIX_SKIP }, () => {
  const s = setup();
  assert.equal(s.runCli(['--install']).status, 0);
  const tuiBefore = s.readTui();
  const configBefore = s.readConfigToml();
  const baksBefore = listDir(s.kimiHome).filter((f) => f.endsWith('.bak')).length;

  fs.chmodSync(s.kimiHome, READONLY);
  try {
    const result = s.runCli(['--uninstall']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /kimi-code-hud: uninstall failed/);
    assert.equal(result.stdout.includes('Removed status line command'), false);
    assert.equal(s.readTui(), tuiBefore, 'target file untouched by the failed write');
    assert.equal(s.readConfigToml(), configBefore, 'hook step never ran');
    assert.deepEqual(
      listDir(s.kimiHome).filter((f) => /\.tmp-/.test(f)),
      [],
      'the atomic write leaves no temporary behind',
    );
    assert.equal(
      listDir(s.kimiHome).filter((f) => f.endsWith('.bak')).length,
      baksBefore,
      'a failed write leaves no backup behind',
    );
  } finally {
    fs.chmodSync(s.kimiHome, WRITABLE);
  }
});

test('a read-only config directory makes --off fail loudly while the flag write persists', { skip: READONLY_SKIP || POSIX_SKIP }, () => {
  const s = setup();
  assert.equal(s.runCli(['--install']).status, 0);
  fs.chmodSync(s.kimiHome, READONLY);
  try {
    const result = s.runCli(['--off']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /kimi-code-hud: disable failed/);
    assert.equal(s.statusCommand().kind, 'parsed', 'the command removal failed, so the command stays');
    // Cross-file boundary observed by this test (documented, not endorsed):
    // the reversible flag is persisted to the HUD home before tui.toml
    // fails, so on-disk state is mixed — the hook honors the flag while the
    // host keeps calling the still-registered command. The failure is at
    // least reported via exit code and stderr.
    assert.equal(JSON.parse(fs.readFileSync(s.hudConfig, 'utf8')).disabled, true);
    assert.deepEqual(
      listDir(s.kimiHome).filter((f) => /\.tmp-/.test(f)),
      [],
    );
  } finally {
    fs.chmodSync(s.kimiHome, WRITABLE);
  }
});

test('an orphaned temporary from an interrupted write is never adopted into tui.toml', { skip: POSIX_SKIP }, () => {
  const s = setup();
  assert.equal(s.runCli(['--install']).status, 0);
  const planted = 'tui.toml.tmp-99999-7';
  fs.writeFileSync(
    path.join(s.kimiHome, planted),
    '[status_line]\ncommand = "node /interrupted-write/x.mjs"\n',
  );

  assert.equal(s.runCli(['--off']).status, 0);
  assert.equal(s.statusCommand().kind, 'absent');
  assert.ok(!s.readTui().includes('/interrupted-write/x.mjs'));
  // The planted debris stays exactly as planted: successful atomic writes
  // never adopt it and never leak their own temporaries.
  assert.deepEqual(listDir(s.kimiHome).filter((f) => /\.tmp-/.test(f)), [planted]);
});
