import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  disableHud,
  enableHud,
  installHud,
  uninstallHud,
} from '../src/management-service.mjs';
import { nodeCommand } from '../src/command.mjs';
import { inspectStatusLineCommand } from '../src/toml.mjs';

test('management service preserves config while installing, toggling, and uninstalling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-management-'));
  const paths = {
    configPath: path.join(root, 'hud', 'config.json'),
    tuiTomlPath: path.join(root, 'kimi', 'tui.toml'),
    configTomlPath: path.join(root, 'kimi', 'config.toml'),
  };
  const scriptPath = '/tmp/Kimi HUD/bin/kimi-hud.mjs';
  const hookScriptPath = '/tmp/Kimi HUD/hooks/sync-status-line.mjs';
  let output = '';
  const stdout = { write(chunk) { output += chunk; return true; } };
  const options = { paths, scriptPath, hookScriptPath, stdout };

  installHud(options);
  assert.deepEqual(
    inspectStatusLineCommand(fs.readFileSync(paths.tuiTomlPath, 'utf8')),
    { kind: 'parsed', value: nodeCommand(scriptPath) },
  );
  assert.ok(fs.readFileSync(paths.configTomlPath, 'utf8').includes('sync-status-line.mjs'));
  assert.match(output, /Installed status line command/);

  fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
  fs.writeFileSync(paths.configPath, '{"layout":"full"}\n');
  disableHud(options);
  let config = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
  assert.deepEqual(config, { layout: 'full', disabled: true });
  assert.equal(inspectStatusLineCommand(fs.readFileSync(paths.tuiTomlPath, 'utf8')).kind, 'absent');
  assert.ok(fs.readFileSync(paths.configTomlPath, 'utf8').includes('sync-status-line.mjs'));

  enableHud(options);
  config = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
  assert.deepEqual(config, { layout: 'full' });
  assert.equal(
    inspectStatusLineCommand(fs.readFileSync(paths.tuiTomlPath, 'utf8')).value,
    nodeCommand(scriptPath),
  );
  assert.equal(
    fs.readFileSync(paths.configTomlPath, 'utf8').split('kimi-code-hud hooks START').length - 1,
    1,
  );

  uninstallHud(options);
  assert.equal(inspectStatusLineCommand(fs.readFileSync(paths.tuiTomlPath, 'utf8')).kind, 'absent');
  assert.equal(
    fs.readFileSync(paths.configTomlPath, 'utf8').includes('kimi-code-hud hooks START'),
    false,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.configPath, 'utf8')), { layout: 'full' });
});

test('install over a third-party status line reports the replaced command and keeps other keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-management-'));
  const paths = {
    configPath: path.join(root, 'hud', 'config.json'),
    tuiTomlPath: path.join(root, 'kimi', 'tui.toml'),
    configTomlPath: path.join(root, 'kimi', 'config.toml'),
  };
  fs.mkdirSync(path.dirname(paths.tuiTomlPath), { recursive: true });
  fs.writeFileSync(
    paths.tuiTomlPath,
    '[editor]\ncommand = "vim"\n\n[status_line]\ncommand = "node /opt/other-hud/render.mjs"\nitems = ["model"]\n',
  );
  let output = '';
  const stdout = { write(chunk) { output += chunk; return true; } };

  installHud({
    paths,
    scriptPath: '/tmp/Kimi HUD/bin/kimi-hud.mjs',
    hookScriptPath: '/tmp/Kimi HUD/hooks/sync-status-line.mjs',
    stdout,
  });

  assert.match(output, /Replaced existing statusLine command: node \/opt\/other-hud\/render\.mjs\n/);
  const content = fs.readFileSync(paths.tuiTomlPath, 'utf8');
  assert.deepEqual(
    inspectStatusLineCommand(content),
    { kind: 'parsed', value: nodeCommand('/tmp/Kimi HUD/bin/kimi-hud.mjs') },
  );
  assert.ok(content.includes('[editor]\ncommand = "vim"'));
  assert.ok(content.includes('items = ["model"]'));
});

test('install over this tool\'s own status line stays silent about replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-management-'));
  const paths = {
    configPath: path.join(root, 'hud', 'config.json'),
    tuiTomlPath: path.join(root, 'kimi', 'tui.toml'),
    configTomlPath: path.join(root, 'kimi', 'config.toml'),
  };
  fs.mkdirSync(path.dirname(paths.tuiTomlPath), { recursive: true });
  fs.writeFileSync(
    paths.tuiTomlPath,
    `[status_line]\ncommand = "${nodeCommand('/old/location/bin/kimi-hud.mjs')}"\n`,
  );
  let output = '';
  const stdout = { write(chunk) { output += chunk; return true; } };

  installHud({
    paths,
    scriptPath: '/tmp/Kimi HUD/bin/kimi-hud.mjs',
    hookScriptPath: '/tmp/Kimi HUD/hooks/sync-status-line.mjs',
    stdout,
  });

  assert.equal(output.includes('Replaced existing statusLine command'), false);
  assert.equal(
    inspectStatusLineCommand(fs.readFileSync(paths.tuiTomlPath, 'utf8')).value,
    nodeCommand('/tmp/Kimi HUD/bin/kimi-hud.mjs'),
  );
});
