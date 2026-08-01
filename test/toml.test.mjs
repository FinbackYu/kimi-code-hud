import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStatusLineCommand,
  inspectStatusLineCommand,
  isKimiHudCommand,
  setStatusLineCommand,
  removeStatusLineCommand,
} from '../src/toml.mjs';

const CMD = 'node /Users/test/kimi-code-hud/bin/kimi-hud.mjs';

test('installs into an empty file', () => {
  const out = setStatusLineCommand('', CMD);
  assert.equal(out, `[status_line]\ncommand = "${CMD}"\n`);
});

test('installs alongside existing sections', () => {
  const input = '[theme]\nname = "dark"\n';
  const out = setStatusLineCommand(input, CMD);
  assert.equal(out, `[theme]\nname = "dark"\n\n[status_line]\ncommand = "${CMD}"\n`);
});

test('preserves existing items in [status_line] and replaces command', () => {
  const input = '[status_line]\nitems = ["model"]\ncommand = "node /old/path.mjs"\n\n[other]\nx = 1\n';
  const out = setStatusLineCommand(input, CMD);
  assert.equal(out, `[status_line]\nitems = ["model"]\ncommand = "${CMD}"\n\n[other]\nx = 1\n`);
});

test('adds command to a [status_line] section without one', () => {
  const input = '[status_line]\nitems = ["model"]\n';
  const out = setStatusLineCommand(input, CMD);
  assert.equal(out, `[status_line]\ncommand = "${CMD}"\nitems = ["model"]\n`);
});

test('install is idempotent', () => {
  const once = setStatusLineCommand('[theme]\nname = "dark"\n', CMD);
  const twice = setStatusLineCommand(once, CMD);
  assert.equal(once, twice);
  assert.equal(once.split('command =').length - 1, 1);
});

test('inspection distinguishes absent, parsed literal, and unknown commands', () => {
  assert.deepEqual(inspectStatusLineCommand('[status_line]\nitems = []\n'), {
    kind: 'absent', value: null,
  });
  const literal = "[status_line]\ncommand = 'node /opt/foreign.mjs' # keep\n";
  assert.deepEqual(inspectStatusLineCommand(literal), {
    kind: 'parsed', value: 'node /opt/foreign.mjs',
  });
  assert.equal(getStatusLineCommand(literal), 'node /opt/foreign.mjs');
  assert.deepEqual(inspectStatusLineCommand('[status_line]\ncommand = bare\n'), {
    kind: 'unknown', value: null,
  });
});

test('HUD ownership requires the exact script basename', () => {
  assert.equal(isKimiHudCommand('node /opt/kimi-code-hud/bin/kimi-hud.mjs'), true);
  assert.equal(isKimiHudCommand('node "/opt/kimi code/bin/kimi-hud.mjs"'), true);
  assert.equal(isKimiHudCommand('node /opt/not-kimi-hud-wrapper.mjs'), false);
  assert.equal(isKimiHudCommand('echo /tmp/kimi-hud.mjs'), false);
  assert.equal(isKimiHudCommand('node /tmp/kimi-hud.mjs && echo changed'), false);
});

test('HUD ownership accepts safe trailing flag arguments', () => {
  assert.equal(isKimiHudCommand('node /opt/kimi-code-hud/bin/kimi-hud.mjs --layout compact'), true);
  assert.equal(isKimiHudCommand('node /opt/kimi-code-hud/bin/kimi-hud.mjs --layout=compact'), true);
  assert.equal(isKimiHudCommand('node /opt/kimi-code-hud/bin/kimi-hud.mjs --layout compact extra'), false);
  assert.equal(isKimiHudCommand('node /opt/kimi-code-hud/bin/kimi-hud.mjs --layout; rm -rf /'), false);
  assert.equal(isKimiHudCommand('node /opt/kimi-code-hud/bin/kimi-hud.mjs --theme=$(whoami)'), false);
  assert.equal(isKimiHudCommand('node /opt/kimi-code-hud/bin/kimi-hud.mjs --'), false);
  assert.equal(isKimiHudCommand('node /opt/kimi-code-hud/bin/kimi-hud.mjs -x'), false);
});

test('uninstall removes our command even with trailing arguments', () => {
  const input = '[status_line]\ncommand = "node /a/bin/kimi-hud.mjs --layout compact"\nitems = ["model"]\n';
  const out = removeStatusLineCommand(input, CMD);
  assert.equal(out, '[status_line]\nitems = ["model"]\n');
});

test('uninstall leaves a foreign command with trailing arguments untouched', () => {
  const input = '[status_line]\ncommand = "node /a/other.mjs --foo"\n';
  assert.equal(removeStatusLineCommand(input, CMD), input);
});

test('uninstall removes only our command line', () => {
  const input = `[status_line]\ncommand = "${CMD}"\nitems = ["model"]\n\n[other]\ncommand = "keep me"\n`;
  const out = removeStatusLineCommand(input, CMD);
  assert.equal(out, '[status_line]\nitems = ["model"]\n\n[other]\ncommand = "keep me"\n');
});

test('uninstall on a file without the section is a no-op', () => {
  const input = '[theme]\nname = "dark"\n';
  assert.equal(removeStatusLineCommand(input, CMD), input);
});

test('uninstall drops a trailing section left empty', () => {
  const input = `[editor]\ncommand = ""\n\n[status_line]\ncommand = "${CMD}"\n`;
  const out = removeStatusLineCommand(input, CMD);
  assert.equal(out, '[editor]\ncommand = ""\n');
});

test('uninstall drops a middle section left empty, keeping neighbours', () => {
  const input = `[theme]\nname = "dark"\n\n[status_line]\ncommand = "${CMD}"\n\n[other]\nx = 1\n`;
  const out = removeStatusLineCommand(input, CMD);
  assert.equal(out, '[theme]\nname = "dark"\n\n[other]\nx = 1\n');
});

test('uninstall of the only content yields an empty file', () => {
  assert.equal(removeStatusLineCommand(`[status_line]\ncommand = "${CMD}"\n`, CMD), '');
});
