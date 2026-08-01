import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kimi-hud.mjs');

test('every admin write failure reports stderr and exits non-zero', () => {
  for (const [flag, action] of [
    ['--install', 'install'],
    ['--uninstall', 'uninstall'],
    ['--on', 'enable'],
    ['--off', 'disable'],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-cli-error-'));
    const result = spawnSync(process.execPath, [BIN, flag], {
      env: {
        ...process.env,
        KIMI_HUD_HOME: path.join(root, 'hud'),
        KIMI_HUD_CONFIG_TOML: path.join(root, 'config.toml'),
        KIMI_HUD_TUI_TOML: path.dirname(BIN),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, flag);
    assert.match(result.stderr, new RegExp(`kimi-code-hud: ${action} failed`));
    assert.equal(result.stdout.includes('kimi-code-hud\n'), false);
  }
});

test('render failures retain the silent exit-zero fallback', () => {
  const result = spawnSync(process.execPath, [BIN], {
    input: JSON.stringify({
      model: 'K3',
      cwd: '/definitely/missing',
      gitBranch: 'main',
      sessionId: 'missing-session',
    }),
    env: { ...process.env, KIMI_HUD_TUI_TOML: path.dirname(BIN) },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.endsWith('\n'));
  assert.equal(result.stderr, '');
});
