import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';

import { renderStatusLine, RUNTIME_BUDGET_MS } from '../src/render-runtime.mjs';
import {
  resolveProviderUsageTarget,
  writeProviderUsageCache,
} from '../src/provider-usage.mjs';
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
    gitStatusCachePath: path.join(hudDir, 'git-status-cache.json'),
    quotaLockPath: path.join(hudDir, 'refresh.lock'),
    providerUsageDir: path.join(hudDir, 'provider-usage'),
    sessionStateDir: path.join(hudDir, 'sessions'),
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
    version: '0.33.0',
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
    modelUsage: null,
    tpsTotal: null,
    tpsAgents: 0,
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
  let metricsHostVersion = null;
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
        metricsHostVersion = options.hostVersion;
        return metrics();
      },
      ensureFreshQuota: () => { refreshes += 1; },
      isGitDirty: () => { gitChecks += 1; return true; },
    },
  });
  assert.equal(metricsDeadline, RUNTIME_BUDGET_MS);
  assert.equal(metricsHostVersion, '0.33.0');
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
  let gitCachePath = null;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    clock: () => 0,
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async () => payload(),
      captureRuntimeSnapshot: () => ({
        hudConfig: {},
        configTomlText: '[models."K3"]\nprovider = "managed:kimi-code"\n',
        tuiTomlText: '',
        quota: cachedQuota,
      }),
      getMetrics: () => metrics(),
      ensureFreshQuota: (options) => { refreshOptions = options; },
      isGitDirty: (_cwd, options) => {
        gitTimeout = options.timeoutMs;
        gitCachePath = options.cachePath;
        return true;
      },
    },
  });
  assert.equal(refreshOptions.cachedQuota, cachedQuota);
  assert.equal(refreshOptions.cachePath, paths.quotaCachePath);
  assert.equal(gitTimeout, 218);
  assert.equal(gitCachePath, paths.gitStatusCachePath);
  assert.ok(result.line.includes('git:(main*)'));
});

test('runtime fails closed for a null provider without quota or provider refresh', async () => {
  const paths = makePaths();
  const cachedQuota = {
    fetchedAt: 1,
    weekly: { used: 99, limit: 100 },
    windows: [{ label: '5h', used: 99, limit: 100 }],
  };
  let quotaRefreshes = 0;
  let usageTargetResolutions = 0;
  let costTargetResolutions = 0;
  let usageRefreshes = 0;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    clock: () => 0,
    env: { NO_COLOR: '1' },
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async () => ({ ...payload(), gitBranch: null }),
      captureRuntimeSnapshot: () => ({
        hudConfig: {}, configTomlText: '', tuiTomlText: '', quota: cachedQuota,
      }),
      getMetrics: () => metrics(),
      ensureFreshQuota: () => { quotaRefreshes += 1; },
      resolveProviderUsageTarget: () => { usageTargetResolutions += 1; return {}; },
      resolveProviderCostTarget: () => { costTargetResolutions += 1; return {}; },
      ensureFreshProviderUsage: () => { usageRefreshes += 1; },
    },
  });
  assert.equal(quotaRefreshes, 0);
  assert.equal(usageTargetResolutions, 0);
  assert.equal(costTargetResolutions, 0);
  assert.equal(usageRefreshes, 0);
  assert.doesNotMatch(result.line, /5h|7d|Balance|Session Cost/);
});

test('runtime combines cached DeepSeek balance with all-agent session cost', async () => {
  const paths = makePaths();
  const configText = `
[providers.deepseek]
type = "openai"
base_url = "https://api.deepseek.com/v1"
api_key = "redacted-runtime-credential"

[models."deepseek-chat"]
provider = "deepseek"
model = "deepseek-chat"
display_name = "DeepSeek Chat"
`;
  fs.writeFileSync(paths.configTomlPath, configText);
  fs.writeFileSync(paths.quotaCachePath, JSON.stringify({
    fetchedAt: 1,
    weekly: { used: 99, limit: 100 },
    windows: [{ label: '5h', used: 99, limit: 100 }],
  }));
  const target = resolveProviderUsageTarget({
    provider: 'deepseek', configText, providerUsageDir: paths.providerUsageDir,
  });
  writeProviderUsageCache({
    kind: 'balance',
    label: 'DeepSeek',
    available: true,
    balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }],
  }, target, { now: 1_000 });
  let quotaRefreshes = 0;
  let usageRefresh = null;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    now: 1_000,
    clock: () => 0,
    env: { NO_COLOR: '1' },
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async () => ({ ...payload(), model: 'DeepSeek Chat', gitBranch: null }),
      getMetrics: () => ({
        ...metrics(),
        modelAlias: 'deepseek-chat',
        modelUsage: {
          scope: 'session', agents: 'all',
          byModel: {
            'deepseek-chat': {
              // Current Kimi Code folds DeepSeek's cache-hit field into inputOther.
              inputOther: 3_000,
              inputCacheRead: 0,
              inputCacheCreation: 0,
              output: 500,
            },
          },
        },
      }),
      ensureFreshQuota: () => { quotaRefreshes += 1; },
      ensureFreshProviderUsage: (options) => { usageRefresh = options; },
    },
  });
  assert.equal(quotaRefreshes, 0);
  assert.equal(usageRefresh.target.credentialFingerprint, target.credentialFingerprint);
  assert.equal(usageRefresh.cachedUsage.balances[0].total, 110);
  assert.match(result.line, /DeepSeek Balance ¥110\.00 · Session Cost ≈¥0\.004/);
  assert.doesNotMatch(result.line, /5h|7d/);
});

test('runtime renders only CNY DeepSeek session cost when balance is unavailable', async () => {
  const paths = makePaths();
  const configText = `
[providers.deepseek]
type = "openai"
base_url = "https://api.deepseek.com/v1"
api_key = "redacted-runtime-credential"

[models."deepseek/flash"]
provider = "deepseek"
model = "deepseek-v4-flash"
display_name = "DeepSeek V4 Flash"
`;
  fs.writeFileSync(paths.configTomlPath, configText);
  const target = resolveProviderUsageTarget({
    provider: 'deepseek', configText, providerUsageDir: paths.providerUsageDir,
  });
  writeProviderUsageCache({
    kind: 'balance', label: 'DeepSeek', available: false,
    balances: [{ currency: 'CNY', total: 0, granted: 0, toppedUp: 0 }],
  }, target, { now: 1_000 });
  let usageRefreshes = 0;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    now: 1_000,
    clock: () => 0,
    env: { NO_COLOR: '1' },
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async () => ({ ...payload(), model: 'DeepSeek V4 Flash', gitBranch: null }),
      getMetrics: () => ({
        ...metrics(),
        modelAlias: 'deepseek/flash',
        modelUsage: {
          scope: 'session', agents: 'all',
          byModel: {
            'deepseek/flash': {
              inputOther: 3_000,
              inputCacheRead: 0,
              inputCacheCreation: 0,
              output: 500,
            },
          },
        },
      }),
      ensureFreshProviderUsage: () => { usageRefreshes += 1; },
    },
  });
  assert.equal(usageRefreshes, 1);
  assert.match(result.line, /DeepSeek Session Cost ≈¥0\.004/);
  assert.doesNotMatch(result.line, /Balance|5h|7d/);
});

test('runtime refuses provider usage for a DeepSeek-compatible custom proxy', async () => {
  const paths = makePaths();
  fs.writeFileSync(paths.configTomlPath, `
[providers.deepseek]
type = "openai"
base_url = "https://proxy.example/v1"
api_key = "redacted-custom-proxy"

[models."deepseek-chat"]
provider = "deepseek"
`);
  let usageRefreshes = 0;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    clock: () => 0,
    env: { NO_COLOR: '1' },
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async () => ({ ...payload(), gitBranch: null }),
      getMetrics: () => ({ ...metrics(), modelAlias: 'deepseek-chat' }),
      ensureFreshProviderUsage: () => { usageRefreshes += 1; },
    },
  });
  assert.equal(usageRefreshes, 0);
  assert.doesNotMatch(result.line, /DeepSeek Balance|5h|7d/);
});

test('runtime renders OpenAI all-agent session cost without a network refresh', async () => {
  const paths = makePaths();
  fs.writeFileSync(paths.configTomlPath, `
[providers.openai]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "redacted-runtime-openai"

[models."openai/gpt-5.6"]
provider = "openai"
model = "gpt-5.6"
display_name = "GPT-5.6"
`);
  let usageRefreshes = 0;
  const result = await renderStatusLine({
    scriptPath: '/tmp/kimi-hud.mjs',
    paths,
    clock: () => 0,
    env: { NO_COLOR: '1' },
    dependencies: {
      managedPluginDisabled: () => false,
      readPayload: async () => ({ ...payload(), model: 'GPT-5.6', gitBranch: null }),
      getMetrics: () => ({
        ...metrics(),
        modelAlias: 'openai/gpt-5.6',
        modelUsage: {
          scope: 'session',
          agents: 'all',
          byModel: {
            'openai/gpt-5.6': {
              inputOther: 1_000,
              inputCacheRead: 2_000,
              inputCacheCreation: 0,
              output: 500,
            },
          },
        },
      }),
      ensureFreshProviderUsage: () => { usageRefreshes += 1; },
    },
  });
  assert.equal(usageRefreshes, 0);
  assert.match(result.line, /OpenAI Session Cost ≈\$0\.021/);
  assert.doesNotMatch(result.line, /Balance|5h|7d/);
});

test('runtime renders Anthropic session cost only for the official direct API', async () => {
  const paths = makePaths();
  const config = (baseUrl = '') => `
[providers.anthropic]
type = "anthropic"
${baseUrl ? `base_url = "${baseUrl}"` : ''}
api_key = "redacted-runtime-anthropic"

[models."anthropic/sonnet-5"]
provider = "anthropic"
model = "claude-sonnet-5"
display_name = "Claude Sonnet 5"
`;
  const run = async (configText) => {
    fs.writeFileSync(paths.configTomlPath, configText);
    return renderStatusLine({
      scriptPath: '/tmp/kimi-hud.mjs',
      paths,
      now: Date.UTC(2026, 7, 9),
      clock: () => 0,
      env: { NO_COLOR: '1' },
      dependencies: {
        managedPluginDisabled: () => false,
        readPayload: async () => ({ ...payload(), model: 'Claude Sonnet 5', gitBranch: null }),
        getMetrics: () => ({
          ...metrics(),
          modelAlias: 'anthropic/sonnet-5',
          modelUsage: {
            scope: 'session', agents: 'all',
            byModel: {
              'anthropic/sonnet-5': {
                inputOther: 1_000,
                inputCacheRead: 1_000,
                inputCacheCreation: 1_000,
                output: 1_000,
              },
            },
          },
        }),
      },
    });
  };

  const official = await run(config());
  assert.match(official.line, /Anthropic Session Cost ≈\$0\.0147/);
  const proxy = await run(config('https://proxy.example'));
  assert.doesNotMatch(proxy.line, /Anthropic Session Cost|Balance|5h|7d/);
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
    env: { NO_COLOR: '1' },
  });
  const elapsed = performance.now() - started;
  assert.equal(result.exitCode, 0);
  assert.ok(result.line.startsWith('[Always Ask]'));
  assert.ok(elapsed < RUNTIME_BUDGET_MS, `render took ${elapsed.toFixed(1)}ms`);
});
