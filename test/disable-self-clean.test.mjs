import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The enablement gate keys on the script's real location, so the test must
// run an actual copy living under <home>/plugins/managed/<id>/.
function setup(installedJson) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-gate-'));
  const managed = path.join(home, 'plugins', 'managed', 'kimi-code-hud');
  fs.mkdirSync(managed, { recursive: true });
  fs.cpSync(path.join(REPO, 'bin'), path.join(managed, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(managed, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'installed.json'), installedJson);
  const toml = path.join(home, 'tui.toml');
  const script = path.join(managed, 'bin', 'kimi-hud.mjs');
  fs.writeFileSync(toml, `[status_line]\ncommand = "node ${script}"\n`);
  return { home, toml, script };
}

function runCopiedScript(home, script, toml) {
  return spawnSync(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      KIMI_CODE_HOME: home,
      KIMI_HUD_TUI_TOML: toml,
      KIMI_HUD_CONFIG_TOML: path.join(home, 'config.toml'),
    },
    stdio: 'pipe',
  });
}

test('removed plugin: exits 1 and strips its own status_line entry', () => {
  const { home, toml, script } = setup('{"version":1,"plugins":[]}');
  const res = runCopiedScript(home, script, toml);
  assert.equal(res.status, 1);
  assert.equal(res.stdout.toString(), '');
  assert.ok(!fs.readFileSync(toml, 'utf8').includes('kimi-hud'));
});

test('disabled plugin: exits 1 and strips its own status_line entry', () => {
  const { home, toml, script } = setup(
    '{"version":1,"plugins":[{"id":"kimi-code-hud","enabled":false}]}',
  );
  const res = runCopiedScript(home, script, toml);
  assert.equal(res.status, 1);
  assert.equal(res.stdout.toString(), '');
  assert.ok(!fs.readFileSync(toml, 'utf8').includes('kimi-hud'));
});
