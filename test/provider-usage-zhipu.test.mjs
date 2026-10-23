import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import {
  PROVIDER_USAGE_RESULT,
  ZHIPU_CN_BALANCE_URL,
  ZHIPU_CN_USAGE_URL,
  ZHIPU_INTL_USAGE_URL,
  ZHIPU_PROVIDER_ALIASES,
  parseZhipuBalance,
  parseZhipuQuota,
  readProviderUsageCache,
  refreshProviderUsage,
  requestZhipuUsage,
  resolveProviderUsageTarget,
  writeProviderUsageCache,
} from '../src/provider-usage.mjs';

const API_KEY = 'redacted-zhipu-credential';
// A fixed clock close to the fixture's resets keeps the reset-defense rule
// (window length plus slack) deterministic.
const NOW = Date.parse('2026-08-04T00:00:00.000Z');
const CN_ENDPOINTS = Object.freeze({
  region: 'cn',
  usageUrl: ZHIPU_CN_USAGE_URL,
  balanceUrl: ZHIPU_CN_BALANCE_URL,
});
const INTL_ENDPOINTS = Object.freeze({
  region: 'intl',
  usageUrl: ZHIPU_INTL_USAGE_URL,
  balanceUrl: null,
});

const QUOTA_RESPONSE = {
  code: 200,
  msg: 'success',
  success: true,
  data: {
    planName: 'Pro',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 25, nextResetTime: 1785816000000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 9, nextResetTime: 1786291200000 },
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 1000,
        currentValue: 224,
        remaining: 776,
        percentage: 22,
        usageDetails: [{ modelCode: 'search-prime', usage: 210 }],
      },
    ],
  },
};

const BALANCE_RESPONSE = {
  code: 200,
  data: {
    balance: 15.39077652,
    rechargeAmount: 50,
    giveAmount: 15.385292,
    availableBalance: 15.39077652,
    totalSpendAmount: 49.99451548,
  },
  success: true,
};

function zhipuConfig({
  provider = 'zhipuai-coding-plan',
  baseUrl = 'https://open.bigmodel.cn/api/paas/v4',
  apiKey = API_KEY,
} = {}) {
  return `
[providers.${provider}]
type = "openai"
base_url = "${baseUrl}"
api_key = "${apiKey}"
`;
}

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-provider-usage-zhipu-'));
  return {
    configPath: path.join(root, 'config.toml'),
    providerUsageDir: path.join(root, 'provider-usage'),
  };
}

function targetFor(paths, configText = zhipuConfig()) {
  return resolveProviderUsageTarget({
    provider: 'zhipuai-coding-plan',
    configText,
    providerUsageDir: paths.providerUsageDir,
  });
}

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('parseZhipuQuota maps the 5h, 7d and monthly MCP windows', () => {
  assert.deepEqual(parseZhipuQuota(QUOTA_RESPONSE, NOW), {
    kind: 'windows',
    label: 'Zhipu Pro',
    windows: [
      { label: '5h', usedRatio: 0.25, resetAt: '2026-08-04T04:00:00.000Z' },
      { label: '7d', usedRatio: 0.09, resetAt: '2026-08-09T16:00:00.000Z' },
      { label: 'mcp', usedRatio: 0.224, resetAt: null },
    ],
  });
});

test('parseZhipuQuota derives labels from window length in ascending order', () => {
  const parsed = parseZhipuQuota({
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 1 },
        { type: 'TOKENS_LIMIT', unit: 5, number: 90, percentage: 2 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 1, percentage: 3 },
        { type: 'TOKENS_LIMIT', unit: 1, number: 3, percentage: 4 },
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 5 },
      ],
    },
  }, NOW);
  assert.equal(parsed.label, 'Zhipu');
  assert.deepEqual(parsed.windows.map((window) => window.label), ['1h', '90m', '5h', '3d', '7d']);
  assert.deepEqual(parsed.windows.map((window) => window.usedRatio), [0.03, 0.02, 0.05, 0.04, 0.01]);
  const duplicate = parseZhipuQuota({
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20 },
      ],
    },
  }, NOW);
  assert.equal(duplicate.windows.length, 1);
});

test('parseZhipuQuota recomputes the ratio from counters before trusting percentage', () => {
  const parsed = parseZhipuQuota({
    code: 200,
    success: true,
    data: {
      limits: [{
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        usage: 1000,
        currentValue: 120,
        remaining: 900,
        percentage: 90,
      }],
    },
  }, NOW);
  assert.equal(parsed.windows[0].usedRatio, 0.12);
  // currentValue wins when it is the larger of the two used figures.
  const larger = parseZhipuQuota({
    code: 200,
    success: true,
    data: {
      limits: [{
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        usage: 1000,
        currentValue: 400,
        remaining: 900,
        percentage: 1,
      }],
    },
  }, NOW);
  assert.equal(larger.windows[0].usedRatio, 0.4);
  // Ratios clamp into [0, 1]; percentage alone is the fallback.
  const clamped = parseZhipuQuota({
    code: 200,
    success: true,
    data: {
      limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 10, currentValue: 30, remaining: 1 }],
    },
  }, NOW);
  assert.equal(clamped.windows[0].usedRatio, 1);
  const percentageOnly = parseZhipuQuota({
    code: 200,
    success: true,
    data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 140 }] },
  }, NOW);
  assert.equal(percentageOnly.windows[0].usedRatio, 1);
});

test('parseZhipuQuota converts epoch milliseconds and drops impossible short-window resets', () => {
  const farReset = NOW + 6 * 60 * 60 * 1000; // 6h out, beyond a 5h window + 5m slack
  const parsed = parseZhipuQuota({
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: farReset },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 10, nextResetTime: 1790000000000 },
      ],
    },
  }, NOW);
  assert.equal(parsed.windows[0].resetAt, null);
  assert.equal(parsed.windows[1].resetAt, '2026-09-21T14:13:20.000Z');
  const nearReset = parseZhipuQuota({
    code: 200,
    success: true,
    data: {
      limits: [{
        type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: NOW + 60_000,
      }],
    },
  }, NOW);
  assert.equal(nearReset.windows[0].resetAt, '2026-08-04T00:01:00.000Z');
  // A monthly MCP reset is judged against a month, not the per-call unit.
  const mcp = parseZhipuQuota({
    code: 200,
    success: true,
    data: {
      limits: [{
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 10,
        currentValue: 1,
        remaining: 9,
        nextResetTime: NOW + 20 * 24 * 60 * 60 * 1000,
      }],
    },
  }, NOW);
  assert.equal(mcp.windows[0].label, 'mcp');
  assert.equal(mcp.windows[0].resetAt, '2026-08-24T00:00:00.000Z');
});

test('parseZhipuQuota refuses unusable templates and sanitizes the plan name', () => {
  assert.equal(parseZhipuQuota(null, NOW), null);
  assert.equal(parseZhipuQuota({ code: 200, success: false, data: { limits: [] } }, NOW), null);
  assert.equal(parseZhipuQuota({ code: 500, msg: '当前用户不存在coding plan', success: false }, NOW), null);
  assert.equal(parseZhipuQuota({ code: 200, success: true, data: null }, NOW), null);
  assert.equal(parseZhipuQuota({ code: 200, success: true, data: { limits: [] } }, NOW), null);
  assert.equal(parseZhipuQuota({
    code: 200,
    success: true,
    data: { limits: [{ type: 'UNKNOWN_LIMIT', unit: 3, number: 5, percentage: 1 }] },
  }, NOW), null);
  assert.equal(parseZhipuQuota({
    code: 200,
    success: true,
    data: { planName: 'GLM Coding │ forged', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1 }] },
  }, NOW).label, 'Zhipu');
  assert.equal(parseZhipuQuota({
    code: 200,
    success: true,
    data: { planName: '专业版', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1 }] },
  }, NOW).label, 'Zhipu');
  assert.equal(parseZhipuQuota({
    code: 200,
    success: true,
    data: { planName: 'Lite', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1 }] },
  }, NOW).label, 'Zhipu Lite');
});

test('parseZhipuBalance reports the available CNY balance without cumulative grants', () => {
  assert.deepEqual(parseZhipuBalance(BALANCE_RESPONSE), {
    kind: 'balance',
    label: 'Zhipu',
    available: true,
    balances: [{ currency: 'CNY', total: 15.39077652, granted: null, toppedUp: null }],
  });
  // availableBalance wins; balance is the fallback.
  assert.equal(parseZhipuBalance({ code: 200, success: true, data: { balance: 4.5 } })
    .balances[0].total, 4.5);
  assert.equal(parseZhipuBalance({
    code: 200, success: true, data: { availableBalance: '7.25', balance: 4.5 },
  }).balances[0].total, 7.25);
  assert.equal(parseZhipuBalance({ code: 500, success: false, data: { balance: 1 } }), null);
  assert.equal(parseZhipuBalance({ code: 200, success: true, data: {} }), null);
  assert.equal(parseZhipuBalance({ code: 200, success: true, data: { availableBalance: -1 } }), null);
  assert.equal(parseZhipuBalance(null), null);
});

test('zhipu target resolution accepts aliases and decides the region from the official host', () => {
  const paths = tempPaths();
  for (const provider of ZHIPU_PROVIDER_ALIASES) {
    const target = resolveProviderUsageTarget({
      provider,
      configText: zhipuConfig({ provider }),
      providerUsageDir: paths.providerUsageDir,
    });
    assert.ok(target, `${provider} must resolve`);
    assert.equal(target.provider, provider);
    assert.equal(target.adapter, provider);
    assert.equal(Object.hasOwn(target, 'apiKey'), false);
    assert.doesNotMatch(target.cachePath, /redacted|credential/);
  }
  assert.ok(targetFor(paths, zhipuConfig({ baseUrl: 'https://api.z.ai/api/paas/v4' })));
  assert.ok(targetFor(paths, zhipuConfig({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4/' })));
  for (const baseUrl of [
    'https://open.bigmodel.cn.evil/api/paas/v4',
    'https://proxy.example/api/paas/v4',
    'http://open.bigmodel.cn/api/paas/v4',
    'https://open.bigmodel.cn:8443/api/paas/v4',
    'https://user:pass@open.bigmodel.cn/api/paas/v4',
    'https://api.deepseek.com/v1',
  ]) {
    assert.equal(targetFor(paths, zhipuConfig({ baseUrl })), null, baseUrl);
  }
});

test('requestZhipuUsage calls the CN quota endpoint with the provider key', async () => {
  const calls = [];
  const result = await requestZhipuUsage({
    apiKey: API_KEY,
    endpoints: CN_ENDPOINTS,
    now: NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => QUOTA_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed.windows.map((window) => window.label), ['5h', '7d', 'mcp']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');

  const intl = [];
  await requestZhipuUsage({
    apiKey: API_KEY,
    endpoints: INTL_ENDPOINTS,
    now: NOW,
    fetchImpl: async (url) => {
      intl.push(url);
      return { ok: true, status: 200, json: async () => QUOTA_RESPONSE };
    },
  });
  assert.deepEqual(intl, ['https://api.z.ai/api/monitor/usage/quota/limit']);
});

test('requestZhipuUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    null,
    { region: 'cn', usageUrl: 'https://proxy.example/api/monitor/usage/quota/limit', balanceUrl: null },
    { region: 'cn', usageUrl: ZHIPU_CN_USAGE_URL, balanceUrl: 'https://proxy.example/balance' },
    { region: 'cn', usageUrl: 'https://www.bigmodel.cn/api/monitor/usage/quota/limit', balanceUrl: null },
  ]) {
    const result = await requestZhipuUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  }
  const missingKey = await requestZhipuUsage({ apiKey: '', endpoints: CN_ENDPOINTS, fetchImpl });
  assert.equal(missingKey.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(called, false);
});

test('requestZhipuUsage maps body code 401 to unauthorized without a balance request', async () => {
  const urls = [];
  const result = await requestZhipuUsage({
    apiKey: API_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ code: 401, success: false, msg: 'token invalid' }) };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);
  assert.equal(result.category, REQUEST_CATEGORY.AUTH);
  assert.deepEqual(urls, [ZHIPU_CN_USAGE_URL]);
});

test('requestZhipuUsage falls back to the CN balance when the plan is unavailable', async () => {
  const urls = [];
  const result = await requestZhipuUsage({
    apiKey: API_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: async (url) => {
      urls.push(url);
      return url === ZHIPU_CN_USAGE_URL
        ? { ok: true, status: 200, json: async () => ({ code: 500, msg: '当前用户不存在coding plan', success: false }) }
        : { ok: true, status: 200, json: async () => BALANCE_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed, {
    kind: 'balance',
    label: 'Zhipu',
    available: true,
    balances: [{ currency: 'CNY', total: 15.39077652, granted: null, toppedUp: null }],
  });
  assert.deepEqual(urls, [ZHIPU_CN_USAGE_URL, ZHIPU_CN_BALANCE_URL]);
});

test('requestZhipuUsage falls back to balance on succeeded-but-empty quota data', async () => {
  for (const body of [
    { code: 200, success: true, data: null },
    { code: 200, success: true, data: { limits: [] } },
    { code: 200, success: true },
  ]) {
    const urls = [];
    const result = await requestZhipuUsage({
      apiKey: API_KEY,
      endpoints: CN_ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return url === ZHIPU_CN_USAGE_URL
          ? { ok: true, status: 200, json: async () => body }
          : { ok: true, status: 200, json: async () => BALANCE_RESPONSE };
      },
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
    assert.equal(result.parsed.kind, 'balance');
    assert.equal(urls.length, 2);
  }
});

test('requestZhipuUsage hides the international region and failed balance lookups', async () => {
  const intlCalls = [];
  const intl = await requestZhipuUsage({
    apiKey: API_KEY,
    endpoints: INTL_ENDPOINTS,
    fetchImpl: async (url) => {
      intlCalls.push(url);
      return { ok: true, status: 200, json: async () => ({ code: 500, success: false }) };
    },
  });
  assert.equal(intl.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(intlCalls.length, 1);
  assert.equal(intlCalls[0], ZHIPU_INTL_USAGE_URL);

  const noBalance = await requestZhipuUsage({
    apiKey: API_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: async (url) => (url === ZHIPU_CN_USAGE_URL
      ? { ok: true, status: 200, json: async () => ({ code: 500, success: false }) }
      : { ok: true, status: 200, json: async () => ({ code: 500, success: false }) }),
  });
  assert.equal(noBalance.status, PROVIDER_USAGE_RESULT.INVALID);

  const unauthorizedBalance = await requestZhipuUsage({
    apiKey: API_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: async (url) => (url === ZHIPU_CN_USAGE_URL
      ? { ok: true, status: 200, json: async () => ({ code: 500, success: false }) }
      : { ok: false, status: 401 }),
  });
  assert.equal(unauthorizedBalance.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);
});

test('requestZhipuUsage propagates quota HTTP failures without a balance request', async () => {
  const cases = [
    [500, PROVIDER_USAGE_RESULT.TRANSIENT],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT],
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED],
    [404, PROVIDER_USAGE_RESULT.INVALID],
  ];
  for (const [status, expected] of cases) {
    const urls = [];
    const result = await requestZhipuUsage({
      apiKey: API_KEY,
      endpoints: CN_ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: false, status };
      },
    });
    assert.equal(result.status, expected, `HTTP ${status}`);
    assert.deepEqual(urls, [ZHIPU_CN_USAGE_URL]);
  }
  const offline = await requestZhipuUsage({
    apiKey: API_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
});

test('refreshProviderUsage persists the CN balance fallback without the credential', async () => {
  const paths = tempPaths();
  fs.writeFileSync(paths.configPath, zhipuConfig());
  const target = targetFor(paths);
  const refreshed = await refreshProviderUsage({
    provider: 'zhipuai-coding-plan',
    configPath: paths.configPath,
    providerUsageDir: paths.providerUsageDir,
    fetchImpl: async (url) => (url === ZHIPU_CN_USAGE_URL
      ? { ok: true, status: 200, json: async () => ({ code: 500, msg: '当前用户不存在coding plan', success: false }) }
      : { ok: true, status: 200, json: async () => BALANCE_RESPONSE }),
  });
  assert.equal(refreshed, true);
  const cached = readProviderUsageCache(target);
  assert.equal(cached.kind, 'balance');
  assert.equal(cached.label, 'Zhipu');
  assert.equal(cached.balances[0].currency, 'CNY');
  assert.equal(cached.balances[0].total, 15.39077652);
  assert.equal(cached.balances[0].granted, null);
  assert.equal(cached.balances[0].toppedUp, null);
  assert.doesNotMatch(fs.readFileSync(target.cachePath, 'utf8'), new RegExp(API_KEY));
});

test('balance caches round-trip balance rows that carry null grants', () => {
  const paths = tempPaths();
  const target = targetFor(paths);
  assert.equal(writeProviderUsageCache(parseZhipuBalance(BALANCE_RESPONSE), target, { now: 1_000 }), true);
  const cached = readProviderUsageCache(target);
  assert.equal(cached.fetchedAt, 1_000);
  assert.deepEqual(cached.balances, [{
    currency: 'CNY', total: 15.39077652, granted: null, toppedUp: null,
  }]);
});
