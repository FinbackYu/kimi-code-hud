import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'sync-status-line.mjs');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-hook-'));
  const pluginRoot = path.join(home, 'plugins', 'managed', 'kimi-code-hud');
  return { home, pluginRoot, toml: path.join(home, 'tui.toml') };
}

function runHook(env) {
  execFileSync(process.execPath, [HOOK], {
    env: { PATH: process.env.PATH, ...env },
    stdio: 'pipe',
  });
}

test('creates tui.toml pointing at the managed copy', () => {
  const { home, pluginRoot, toml } = setup();
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  const out = fs.readFileSync(toml, 'utf8');
  assert.equal(out, `[status_line]\ncommand = "node ${pluginRoot}/bin/kimi-hud.mjs"\n`);
});

test('rewrites a previous kimi-hud command to the managed copy', () => {
  const { home, pluginRoot, toml } = setup();
  fs.writeFileSync(toml, '[status_line]\ncommand = "node /Users/test/kimi-code-hud/bin/kimi-hud.mjs"\n');
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  const out = fs.readFileSync(toml, 'utf8');
  assert.equal(out, `[status_line]\ncommand = "node ${pluginRoot}/bin/kimi-hud.mjs"\n`);
});

test('installs even when another section has its own command key', () => {
  const { home, pluginRoot, toml } = setup();
  // Real default tui.toml: [editor] carries `command = ""`, which must not
  // be mistaken for a foreign status-line command.
  fs.writeFileSync(toml, '[editor]\ncommand = "" # Empty uses $VISUAL / $EDITOR\n');
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  const out = fs.readFileSync(toml, 'utf8');
  assert.equal(
    out,
    `[editor]\ncommand = "" # Empty uses $VISUAL / $EDITOR\n\n[status_line]\ncommand = "node ${pluginRoot}/bin/kimi-hud.mjs"\n`,
  );
});

test('leaves a foreign status line command untouched', () => {
  const { home, pluginRoot, toml } = setup();
  const original = '[status_line]\ncommand = "node /Users/test/my-own-statusline.mjs"\n';
  fs.writeFileSync(toml, original);
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  assert.equal(fs.readFileSync(toml, 'utf8'), original);
});

test('preserves other sections and status_line keys', () => {
  const { home, pluginRoot, toml } = setup();
  fs.writeFileSync(toml, '[theme]\nname = "dark"\n\n[status_line]\nitems = ["model"]\n');
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  const out = fs.readFileSync(toml, 'utf8');
  assert.equal(
    out,
    `[theme]\nname = "dark"\n\n[status_line]\ncommand = "node ${pluginRoot}/bin/kimi-hud.mjs"\nitems = ["model"]\n`,
  );
});

test('is idempotent across runs', () => {
  const { home, pluginRoot, toml } = setup();
  const env = { KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot };
  runHook(env);
  const once = fs.readFileSync(toml, 'utf8');
  runHook(env);
  assert.equal(fs.readFileSync(toml, 'utf8'), once);
});

test('exits 0 even when tui.toml is unreadable', () => {
  const { home, pluginRoot } = setup();
  fs.mkdirSync(path.join(home, 'tui.toml')); // a directory where a file is expected
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
});
