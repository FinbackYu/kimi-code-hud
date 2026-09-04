import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteFile } from '../src/fs-store.mjs';
import { getMetrics } from '../src/metrics.mjs';
import { resolveSessionFilePath, sessionFileName } from '../src/session-files.mjs';
import { resolveThinkingLevel } from '../src/thinking.mjs';
import { FRESH_NOW, makeSession } from './.helpers.mjs';

// Per-session state file locations: sanitized names plus the lazy migration
// that adopts pre-`sessions/` root-level copies the first time their session
// is touched again.

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('sessionFileName flattens hostile session ids to a safe name', () => {
  assert.equal(sessionFileName('metrics', 'a/b:c d'), 'metrics-a_b_c_d.json');
  assert.equal(sessionFileName('thinking', 'session_9f03'), 'thinking-session_9f03.json');
});

test('resolveSessionFilePath returns an existing target untouched', () => {
  const dir = tmpDir('kimi-hud-sf-');
  const legacyDir = tmpDir('kimi-hud-sf-legacy-');
  atomicWriteFile(path.join(dir, 'metrics-s1.json'), '{"v":8}');
  const resolved = resolveSessionFilePath(dir, legacyDir, 'metrics', 's1');
  assert.equal(resolved, path.join(dir, 'metrics-s1.json'));
  assert.equal(fs.readdirSync(legacyDir).length, 0);
});

test('resolveSessionFilePath migrates a legacy copy atomically', () => {
  const dir = tmpDir('kimi-hud-sf-');
  const legacyDir = tmpDir('kimi-hud-sf-legacy-');
  atomicWriteFile(path.join(legacyDir, 'thinking-s2.json'), '{"level":"high"}');
  const resolved = resolveSessionFilePath(dir, legacyDir, 'thinking', 's2');
  assert.equal(resolved, path.join(dir, 'thinking-s2.json'));
  assert.equal(fs.readFileSync(resolved, 'utf8'), '{"level":"high"}');
  assert.ok(!fs.existsSync(path.join(legacyDir, 'thinking-s2.json')));
});

test('resolveSessionFilePath without a legacy copy creates nothing', () => {
  const dir = tmpDir('kimi-hud-sf-');
  const legacyDir = tmpDir('kimi-hud-sf-legacy-');
  const resolved = resolveSessionFilePath(dir, legacyDir, 'metrics', 's3');
  assert.equal(resolved, path.join(dir, 'metrics-s3.json'));
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(fs.readdirSync(legacyDir).length, 0);
});

test('resolveSessionFilePath without a legacy dir never touches the filesystem', () => {
  const dir = tmpDir('kimi-hud-sf-');
  const resolved = resolveSessionFilePath(dir, null, 'metrics', 's4');
  assert.equal(resolved, path.join(dir, 'metrics-s4.json'));
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('getMetrics adopts a legacy root state file when legacyStateDir is set', () => {
  const { root, id, wires } = makeSession();
  fs.writeFileSync(wires.main, '');
  const hudRoot = tmpDir('kimi-hud-sf-hud-');
  const sessionsDir = path.join(hudRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const legacyPath = path.join(hudRoot, `metrics-${id}.json`);
  fs.writeFileSync(legacyPath, JSON.stringify({ v: 8, agents: {}, modelAlias: 'K3' }));

  getMetrics(id, {
    sessionsRoot: root,
    stateDir: sessionsDir,
    legacyStateDir: hudRoot,
    now: FRESH_NOW,
  });

  assert.ok(!fs.existsSync(legacyPath), 'legacy file should be gone');
  const migrated = JSON.parse(
    fs.readFileSync(path.join(sessionsDir, `metrics-${id}.json`), 'utf8'),
  );
  assert.equal(migrated.modelAlias, 'K3');
});

test('getMetrics without legacyStateDir leaves a root state file alone', () => {
  const { root, id } = makeSession();
  const hudRoot = tmpDir('kimi-hud-sf-hud-');
  const sessionsDir = path.join(hudRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const legacyPath = path.join(hudRoot, `metrics-${id}.json`);
  fs.writeFileSync(legacyPath, '{"v":8,"agents":{}}');

  getMetrics(id, { sessionsRoot: root, stateDir: sessionsDir, now: FRESH_NOW });

  assert.ok(fs.existsSync(legacyPath));
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), '{"v":8,"agents":{}}');
});

test('resolveThinkingLevel adopts a legacy snapshot and pins the level', () => {
  const { root, id, wires } = makeSession({ id: 's9' });
  fs.writeFileSync(wires.main, '');
  const hudRoot = tmpDir('kimi-hud-sf-hud-');
  const sessionsDir = path.join(hudRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(hudRoot, 'thinking-s9.json'),
    JSON.stringify({ level: 'high', model: 'K3', confirmed: true }),
  );

  const resolved = resolveThinkingLevel({
    sessionLevel: null,
    model: 'K3',
    sessionId: 's9',
    configPath: path.join(hudRoot, 'config.toml'), // absent: must not be read
    snapshotDir: sessionsDir,
    legacySnapshotDir: hudRoot,
  });

  assert.deepEqual(resolved, { level: 'high', confirmed: true });
  assert.ok(fs.existsSync(path.join(sessionsDir, 'thinking-s9.json')));
  assert.ok(!fs.existsSync(path.join(hudRoot, 'thinking-s9.json')));
});
