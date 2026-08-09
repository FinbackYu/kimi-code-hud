import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PROVIDER_USAGE_RESULT,
  PROVIDER_USAGE_TTL_MS,
  acquireProviderUsageLock,
  ensureFreshProviderUsage,
  isProviderUsageStale,
  parseDeepSeekBalance,
  readProviderUsageCache,
  refreshProviderUsage,
  releaseProviderUsageLock,
  requestDeepSeekUsage,
  resolveProviderUsageTarget,
  writeProviderUsageCache,
} from '../src/provider-usage.mjs';

const API_KEY = 'redacted-provider-credential';
const RESPONSE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

function config({ apiKey = API_KEY, baseUrl = 'https://api.deepseek.com/v1' } = {}) {
  return `
[providers.deepseek]
type = "openai"
base_url = "${baseUrl}"
api_key = "${apiKey}"
`;
}

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-provider-usage-'));
  return {
    configPath: path.join(root, 'config.toml'),
    providerUsageDir: path.join(root, 'provider-usage'),
  };
}

function targetFor(paths, configText = config()) {
  return resolveProviderUsageTarget({
    provider: 'deepseek',
    configText,
    providerUsageDir: paths.providerUsageDir,
  });
}

test('parseDeepSeekBalance normalizes official decimal-string fields', () => {
  assert.deepEqual(parseDeepSeekBalance(RESPONSE), {
    kind: 'balance',
    label: 'DeepSeek',
    available: true,
    balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }],
  });
  assert.equal(parseDeepSeekBalance(null), null);
  assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [] }), null);
  assert.equal(parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '-1' }],
  }), null);
  assert.equal(parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '' }],
  }), null);
});

test('cache label contract accepts full brands and rejects HUD delimiters', () => {
  const paths = tempPaths();
  const target = targetFor(paths);
  assert.equal(writeProviderUsageCache({
    kind: 'balance', label: 'OpenRouter', available: true,
    balances: [{ currency: 'USD', total: 1 }],
  }, target), true);
  assert.equal(writeProviderUsageCache({
    kind: 'balance', label: 'OpenRouter │ forged', available: true,
    balances: [{ currency: 'USD', total: 1 }],
  }, target), false);
});

test('target resolution requires the exact provider and official DeepSeek base URL', () => {
  const paths = tempPaths();
  const target = targetFor(paths);
  assert.equal(target.provider, 'deepseek');
  assert.equal(target.adapter, 'deepseek');
  assert.equal(Object.hasOwn(target, 'apiKey'), false);
  assert.doesNotMatch(target.cachePath, /redacted|credential/);
  assert.ok(targetFor(paths, config({ baseUrl: 'https://api.deepseek.com' })));
  assert.equal(targetFor(paths, config({ baseUrl: 'https://api.deepseek.com.evil/v1' })), null);
  assert.equal(targetFor(paths, config({ baseUrl: 'https://proxy.example/v1' })), null);
  assert.equal(resolveProviderUsageTarget({
    provider: 'deepseek-main', configText: config(), providerUsageDir: paths.providerUsageDir,
  }), null);
});

test('cache is atomic, secret-free, stale-aware, and isolated across key switches', () => {
  const paths = tempPaths();
  const target = targetFor(paths);
  const usage = parseDeepSeekBalance(RESPONSE);
  assert.equal(writeProviderUsageCache(usage, target, { now: 1_000 }), true);
  const cached = readProviderUsageCache(target);
  assert.equal(cached.fetchedAt, 1_000);
  assert.equal(cached.balances[0].total, 110);
  assert.equal(isProviderUsageStale(cached, 1_000 + PROVIDER_USAGE_TTL_MS), false);
  assert.equal(isProviderUsageStale(cached, 1_001 + PROVIDER_USAGE_TTL_MS), true);
  const raw = fs.readFileSync(target.cachePath, 'utf8');
  assert.doesNotMatch(raw, new RegExp(API_KEY));

  const switched = targetFor(paths, config({ apiKey: 'redacted-other-account' }));
  assert.notEqual(switched.credentialFingerprint, target.credentialFingerprint);
  assert.notEqual(switched.cachePath, target.cachePath);
  assert.equal(readProviderUsageCache(switched), null);
  fs.copyFileSync(target.cachePath, switched.cachePath);
  assert.equal(readProviderUsageCache(switched), null);
});

test('DeepSeek request classifies responses and refuses non-official targets', async () => {
  let request = null;
  const success = await requestDeepSeekUsage({
    apiKey: API_KEY,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => RESPONSE };
    },
  });
  assert.equal(success.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.equal(success.parsed.balances[0].total, 110);
  assert.equal(request.url, 'https://api.deepseek.com/user/balance');
  assert.equal(request.options.headers.Authorization, `Bearer ${API_KEY}`);

  let called = false;
  const refused = await requestDeepSeekUsage({
    apiKey: API_KEY,
    url: 'https://proxy.example/user/balance',
    fetchImpl: async () => { called = true; },
  });
  assert.equal(refused.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(called, false);

  for (const [status, expected] of [
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT],
    [500, PROVIDER_USAGE_RESULT.TRANSIENT],
    [400, PROVIDER_USAGE_RESULT.INVALID],
  ]) {
    const result = await requestDeepSeekUsage({
      apiKey: API_KEY,
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal(result.status, expected);
  }
  const networkFailure = await requestDeepSeekUsage({
    apiKey: API_KEY,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(networkFailure.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  const malformedResponse = await requestDeepSeekUsage({
    apiKey: API_KEY,
    fetchImpl: async () => null,
  });
  assert.equal(malformedResponse.status, PROVIDER_USAGE_RESULT.INVALID);
});

test('account-scoped lock permits only one detached refresh', () => {
  const paths = tempPaths();
  const target = targetFor(paths);
  let spawnCall = null;
  const child = { once() {}, unref() {} };
  const spawnImpl = (...args) => { spawnCall = args; return child; };
  assert.equal(ensureFreshProviderUsage({
    scriptPath: '/tmp/kimi-hud.mjs', target, cachedUsage: null,
    now: 10, spawnImpl, tokenFactory: () => 'one',
  }), true);
  assert.equal(ensureFreshProviderUsage({
    scriptPath: '/tmp/kimi-hud.mjs', target, cachedUsage: null,
    now: 11, spawnImpl, tokenFactory: () => 'two',
  }), false);
  assert.deepEqual(spawnCall[1], [
    '/tmp/kimi-hud.mjs', '--refresh-provider-usage', 'deepseek', target.credentialFingerprint,
  ]);
  assert.doesNotMatch(JSON.stringify(spawnCall), new RegExp(API_KEY));
  const lock = JSON.parse(fs.readFileSync(target.lockPath, 'utf8'));
  assert.equal(releaseProviderUsageLock(target.lockPath, lock.token), true);
});

test('provider lock cleanup is ownership-safe', () => {
  const paths = tempPaths();
  const target = targetFor(paths);
  const owner = acquireProviderUsageLock({ lockPath: target.lockPath, now: 1, token: 'owner' });
  assert.equal(owner, 'owner');
  assert.equal(releaseProviderUsageLock(target.lockPath, 'other'), false);
  assert.equal(fs.existsSync(target.lockPath), true);
  assert.equal(releaseProviderUsageLock(target.lockPath, owner), true);
});

test('refresh writes success, preserves transient cache, and clears auth failures', async () => {
  const paths = tempPaths();
  fs.writeFileSync(paths.configPath, config());
  const target = targetFor(paths);
  const success = await refreshProviderUsage({
    provider: 'deepseek',
    configPath: paths.configPath,
    providerUsageDir: paths.providerUsageDir,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => RESPONSE }),
  });
  assert.equal(success, true);
  assert.equal(readProviderUsageCache(target).balances[0].total, 110);

  const transient = await refreshProviderUsage({
    provider: 'deepseek',
    configPath: paths.configPath,
    providerUsageDir: paths.providerUsageDir,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(transient, false);
  assert.equal(readProviderUsageCache(target).balances[0].total, 110);

  const invalid = await refreshProviderUsage({
    provider: 'deepseek',
    configPath: paths.configPath,
    providerUsageDir: paths.providerUsageDir,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  assert.equal(invalid, false);
  assert.equal(readProviderUsageCache(target), null);
  writeProviderUsageCache(parseDeepSeekBalance(RESPONSE), target);

  const unauthorized = await refreshProviderUsage({
    provider: 'deepseek',
    configPath: paths.configPath,
    providerUsageDir: paths.providerUsageDir,
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(unauthorized, false);
  assert.equal(readProviderUsageCache(target), null);
});

test('detached refresh rejects a credential switch before making a request', async () => {
  const paths = tempPaths();
  const oldTarget = targetFor(paths);
  writeProviderUsageCache(parseDeepSeekBalance(RESPONSE), oldTarget);
  fs.writeFileSync(paths.configPath, config({ apiKey: 'redacted-new-account' }));
  let called = false;
  const refreshed = await refreshProviderUsage({
    provider: 'deepseek',
    expectedFingerprint: oldTarget.credentialFingerprint,
    configPath: paths.configPath,
    providerUsageDir: paths.providerUsageDir,
    fetchImpl: async () => { called = true; },
  });
  assert.equal(refreshed, false);
  assert.equal(called, false);
  assert.equal(fs.existsSync(oldTarget.cachePath), false);
});
