import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managedPluginId, managedPluginDisabled } from '../src/plugin-state.mjs';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
}

function writeInstalled(home, plugins) {
  const dir = path.join(home, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ version: 1, plugins }));
}

const DEV_PATH = '/Users/test/kimi-code-hud/bin/kimi-hud.mjs';
const managedPath = (home, id = 'kimi-code-hud') =>
  path.join(home, 'plugins', 'managed', id, 'bin', 'kimi-hud.mjs');

test('managedPluginId detects managed copies only', () => {
  assert.equal(managedPluginId(DEV_PATH), null);
  assert.equal(managedPluginId(managedPath('/x/.kimi-code')), 'kimi-code-hud');
});

test('plain checkout always renders', () => {
  assert.equal(managedPluginDisabled(DEV_PATH, tmpHome()), false);
});

test('enabled plugin renders', () => {
  const home = tmpHome();
  writeInstalled(home, [{ id: 'kimi-code-hud', enabled: true }]);
  assert.equal(managedPluginDisabled(managedPath(home), home), false);
});

test('disabled plugin stays silent', () => {
  const home = tmpHome();
  writeInstalled(home, [{ id: 'kimi-code-hud', enabled: false }]);
  assert.equal(managedPluginDisabled(managedPath(home), home), true);
});

test('removed plugin (no record) stays silent', () => {
  const home = tmpHome();
  writeInstalled(home, [{ id: 'other-plugin', enabled: true }]);
  assert.equal(managedPluginDisabled(managedPath(home), home), true);
});

test('missing installed.json means removed', () => {
  const home = tmpHome();
  assert.equal(managedPluginDisabled(managedPath(home), home), true);
});

test('malformed installed.json fails open', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'installed.json'), 'not json');
  assert.equal(managedPluginDisabled(managedPath(home), home), false);
});

test('record without enabled flag defaults to rendering', () => {
  const home = tmpHome();
  writeInstalled(home, [{ id: 'kimi-code-hud' }]);
  assert.equal(managedPluginDisabled(managedPath(home), home), false);
});
