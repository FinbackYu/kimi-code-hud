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
    env: {
      PATH: process.env.PATH,
      // The hook also runs housekeeping; keep it away from the real
      // ~/.kimi-code-hud even when a test forgets to pin the home.
      KIMI_HUD_HOME: path.join(env.KIMI_CODE_HOME, 'hud-home'),
      ...env,
    },
    stdio: 'pipe',
  });
}

test('creates tui.toml pointing at the managed copy', () => {
  const { home, pluginRoot, toml } = setup();
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  const out = fs.readFileSync(toml, 'utf8');
  assert.equal(out, `[status_line]\ncommand = "node ${pluginRoot}/bin/kimi-hud.mjs"\n`);
});

test('session start sweeps stale HUD temporaries and expired session state', () => {
  const { home, pluginRoot } = setup();
  const hudHome = path.join(home, 'hud-home');
  const sessionsDir = path.join(hudHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const staleTmp = write(hudHome, 'refresh.lock.tmp-4242-1788427855383-abc');
  const expiredState = write(sessionsDir, 'metrics-session_dead.json', '{"v":8}');
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const p of [staleTmp, expiredState]) fs.utimesSync(p, stale, stale);

  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot, KIMI_HUD_HOME: hudHome });

  assert.ok(!fs.existsSync(staleTmp));
  assert.ok(!fs.existsSync(expiredState));
  assert.ok(fs.existsSync(path.join(sessionsDir, '.housekeeping-stamp')));
});

function write(dir, name, content = '') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

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

test('rewrites a previous kimi-hud command that carries trailing arguments', () => {
  const { home, pluginRoot, toml } = setup();
  fs.writeFileSync(toml, '[status_line]\ncommand = "node /a/bin/kimi-hud.mjs --layout compact"\n');
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  const out = fs.readFileSync(toml, 'utf8');
  assert.equal(out, `[status_line]\ncommand = "node ${pluginRoot}/bin/kimi-hud.mjs"\n`);
});

test('leaves a foreign command with trailing arguments untouched', () => {
  const { home, pluginRoot, toml } = setup();
  const original = '[status_line]\ncommand = "node /a/other.mjs --foo"\n';
  fs.writeFileSync(toml, original);
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  assert.equal(fs.readFileSync(toml, 'utf8'), original);
});

test('leaves a kimi-hud command with unsafe trailing words untouched', () => {
  const { home, pluginRoot, toml } = setup();
  const original = '[status_line]\ncommand = "node /a/bin/kimi-hud.mjs extra"\n';
  fs.writeFileSync(toml, original);
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  assert.equal(fs.readFileSync(toml, 'utf8'), original);
});

test('leaves a foreign status line command untouched', () => {
  const { home, pluginRoot, toml } = setup();
  const original = '[status_line]\ncommand = "node /Users/test/my-own-statusline.mjs"\n';
  fs.writeFileSync(toml, original);
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  assert.equal(fs.readFileSync(toml, 'utf8'), original);
});

test('leaves a single-quoted foreign status line command untouched', () => {
  const { home, pluginRoot, toml } = setup();
  const original = "[status_line]\ncommand = 'node /Users/test/my-own-statusline.mjs'\n";
  fs.writeFileSync(toml, original);
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  assert.equal(fs.readFileSync(toml, 'utf8'), original);
});

test('leaves an unknown command syntax untouched', () => {
  const { home, pluginRoot, toml } = setup();
  const original = '[status_line]\ncommand = bare-value\n';
  fs.writeFileSync(toml, original);
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  assert.equal(fs.readFileSync(toml, 'utf8'), original);
});

test('quotes a managed-copy path containing spaces', () => {
  const { home, toml } = setup();
  const pluginRoot = path.join(home, 'managed plugins', 'kimi-code-hud');
  runHook({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: pluginRoot });
  assert.equal(
    fs.readFileSync(toml, 'utf8'),
    `[status_line]\ncommand = "node \\"${pluginRoot}/bin/kimi-hud.mjs\\""\n`,
  );
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
