import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setStatusLineCommand, removeStatusLineCommand } from '../src/toml.mjs';

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

test('uninstall removes only our command line', () => {
  const input = `[status_line]\ncommand = "${CMD}"\nitems = ["model"]\n\n[other]\ncommand = "keep me"\n`;
  const out = removeStatusLineCommand(input, CMD);
  assert.equal(out, '[status_line]\nitems = ["model"]\n\n[other]\ncommand = "keep me"\n');
});

test('uninstall on a file without the section is a no-op', () => {
  const input = '[theme]\nname = "dark"\n';
  assert.equal(removeStatusLineCommand(input, CMD), input);
});
