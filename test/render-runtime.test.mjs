import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';

import { renderStatusLine, RUNTIME_BUDGET_MS } from '../src/render-runtime.mjs';
import { captureRuntimeSnapshot } from '../src/runtime-snapshot.mjs';

function makePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-runtime-'));
  const kimiHome = path.join(root, 'kimi');
  const hudDir = path.join(root, 'hud');
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.mkdirSync(hudDir, { recursive: true });
  return {
    kimiHome,
    hudDir,
    sessionsRoot: path.join(kimiHome, 'sessions'),
    configPath: path.join(hudDir, 'config.json'),
    quotaCachePath: path.join(hudDir, 'quota.json'),
    quotaLockPath: path.join(hudDir, 'refresh.lock'),
    tuiTomlPath: path.join(kimiHome, 'tui.toml'),
    configTomlPath: path.join(kimiHome, 'config.toml'),
    credentialsPath: path.join(kimiHome, 'credentials.json'),
  };
}

function payload() {
  return {
    model: 'K3',
    cwd: '/tmp/project',
    gitBranch: 'main',
    permissionMode: 'manual',
    planMode: false,
    contextUsage: 0.1,
    sessionId: 'runtime-session',
    version: '0.31.1',
  };
}

function metrics() {
  return {
    tps: null,
    tpsStale: false,
    ttftMs: null,
    thinkingLevel: 'high',
    goal: null,
    modelAlias: null,
    swarmMode: false,
    cache: null,
    tpsTotal: null,
    activeAgents: 0,
    turnStartedAt: null,
    compactingSince: null,
    compactionMs: null,
  };
}

test('runtime snapshot reads and parses the four per-frame sources', () => {
  const paths = makePaths();
  fs.writeFileSync(paths.configPath, '{"layout":"full"}');
  fs.writeFileSync(paths.configTomlPath, '[models."K3"]\nprovider = "anthropic"\n');
  fs.writeFileSync(paths.tuiTomlPath, 'theme = "light"\n');
  fs.writeFileSync(paths.quotaCachePath, JSON.stringify({
    fetchedAt: 1,
    weekly: null,
    windows: [],
  }));
  const snapshot = captureRuntimeSnapshot({ paths, clock: () => 0 });
  assert.equal(snapshot.hudConfig.layout, 'full');
  assert.match(snapshot.configTomlText, /anthropic/);
  assert.match(snapshot.tuiTomlText, /light/);
  assert.equal(snapshot.quota.fetchedAt, 1);
});

test('runtime snapshot skips the remaining sources once the deadline is spent', () => {
  const paths = makePaths();
  fs.writeFileSync(paths.configPath, '{"layout":"full"}');
  fs.writeFileSync(paths.configTomlPath, '[models."K3"]\nprovider = "anthropic"\n');
  fs.writeFileSync(paths.tuiTomlPath, 'theme = "light"\n');
  fs.writeFileSync(paths.quotaCachePath, JSON.stringify({
    fetchedAt: 1,
    weekly: null,
    windows: [],
  }));
  const times = [50, 150, 200, 250];
  const snapshot = captureRuntimeSnapshot({
    paths,
    deadline: 100,
    clock: () => times.shift() ?? 250,
  });
  assert.equal(snapshot.hudConfig.layout, 'full');
  assert.equal(snapshot.configTomlText, '');
  assert.equal(snapshot.tuiTomlText, '');
  assert.equal(snapshot.quota, null);
});

test('runtime clamps the stdin timeout to the remaining budget', async () => {
  const paths = makePaths();
  const times = [0, 120];
  let payloadOptions = null;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    clock: () => times.shift() ?? 120,
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async (options) => { payloadOptions = options; return null; },
    },
  });
  assert.equal(payloadOptions.timeoutMs, 100);
  assert.equal(result.exitCode, 0);
  assert.equal(result.line, 'kimi-code-hud');
});

test('runtime shares one deadline and skips refresh and Git when budget is gone', async () => {
  const paths = makePaths();
  const times = [0, 219, 221, 222];
  let refreshes = 0;
  let gitChecks = 0;
  let metricsDeadline = null;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    clock: () => times.shift() ?? 222,
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async () => payload(),
      captureRuntimeSnapshot: () => ({
        hudConfig: { layout: 'normal' },
        configTomlText: '',
        tuiTomlText: '',
        quota: { fetchedAt: 1, weekly: null, windows: [] },
      }),
      getMetrics: (_sessionId, options) => {
        metricsDeadline = options.deadline;
        return metrics();
      },
      ensureFreshQuota: () => { refreshes += 1; },
      isGitDirty: () => { gitChecks += 1; return true; },
    },
  });
  assert.equal(metricsDeadline, RUNTIME_BUDGET_MS);
  assert.equal(refreshes, 0);
  assert.equal(gitChecks, 0);
  assert.equal(result.exitCode, 0);
  assert.ok(result.line.includes('git:(main)'));
});

test('runtime passes the captured quota to refresh and uses remaining Git time', async () => {
  const paths = makePaths();
  const cachedQuota = { fetchedAt: 1, weekly: null, windows: [] };
  let refreshOptions = null;
  let gitTimeout = null;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    clock: () => 0,
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async () => payload(),
      captureRuntimeSnapshot: () => ({
        hudConfig: {}, configTomlText: '', tuiTomlText: '', quota: cachedQuota,
      }),
      getMetrics: () => metrics(),
      ensureFreshQuota: (options) => { refreshOptions = options; },
      isGitDirty: (_cwd, options) => { gitTimeout = options.timeoutMs; return true; },
    },
  });
  assert.equal(refreshOptions.cachedQuota, cachedQuota);
  assert.equal(refreshOptions.cachePath, paths.quotaCachePath);
  assert.equal(gitTimeout, 218);
  assert.ok(result.line.includes('git:(main*)'));
});

test('a normal local render frame completes inside the 220ms internal budget', async () => {
  const paths = makePaths();
  fs.mkdirSync(paths.sessionsRoot, { recursive: true });
  fs.writeFileSync(paths.configTomlPath, '[models."K3"]\nprovider = "anthropic"\n');
  fs.writeFileSync(paths.tuiTomlPath, 'theme = "dark"\n');
  const stdin = new PassThrough();
  stdin.end(JSON.stringify({ ...payload(), gitBranch: null }));
  const started = performance.now();
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    stdin,
  });
  const elapsed = performance.now() - started;
  assert.equal(result.exitCode, 0);
  assert.ok(result.line.startsWith('[manual]'));
  assert.ok(elapsed < RUNTIME_BUDGET_MS, `render took ${elapsed.toFixed(1)}ms`);
});
