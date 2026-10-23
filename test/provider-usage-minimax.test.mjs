import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import {
  PROVIDER_USAGE_RESULT,
  normalizeUsage,
} from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  MINIMAX_CN_BALANCE_URL,
  MINIMAX_CN_LEGACY_BALANCE_URL,
  MINIMAX_CN_LEGACY_USAGE_URL,
  MINIMAX_CN_USAGE_URL,
  MINIMAX_GLOBAL_BALANCE_URL,
  MINIMAX_GLOBAL_USAGE_URL,
  MINIMAX_HOSTS,
  parseMiniMaxBalance,
  parseMiniMaxUsage,
  requestMiniMaxUsage,
} from '../src/provider-usage/minimax.mjs';
import { ADAPTER as DEEPSEEK_ADAPTER } from '../src/provider-usage/deepseek.mjs';
import { ADAPTER as OPENCODE_GO_ADAPTER } from '../src/provider-usage/opencode-go.mjs';
import { ADAPTER as ZHIPU_ADAPTER } from '../src/provider-usage/zhipu.mjs';

const API_KEY = 'test-key';
const SUBSCRIPTION_KEY = 'sk-plan-test-key';
const PAY_AS_YOU_GO_KEY = 'sk-api-test-key';
// The fixture's interval closes at 07:00Z; a fixed clock keeps the
// `remains_time` fallback deterministic.
const NOW = Date.parse('2026-06-01T05:00:00.000Z');

const GLOBAL_ENDPOINTS = Object.freeze({
  region: 'global',
  currency: 'USD',
  usageUrl: MINIMAX_GLOBAL_USAGE_URL,
  balanceUrl: MINIMAX_GLOBAL_BALANCE_URL,
});
const CN_ENDPOINTS = Object.freeze({
  region: 'cn',
  currency: 'CNY',
  usageUrl: MINIMAX_CN_USAGE_URL,
  balanceUrl: MINIMAX_CN_BALANCE_URL,
});
const CN_LEGACY_ENDPOINTS = Object.freeze({
  region: 'cn',
  currency: 'CNY',
  usageUrl: MINIMAX_CN_LEGACY_USAGE_URL,
  balanceUrl: MINIMAX_CN_LEGACY_BALANCE_URL,
});

// CodexBar's `data`-wrapped Token Plan fixture, desensitized.
const USAGE_RESPONSE = {
  base_resp: { status_code: 0, status_msg: 'success' },
  data: {
    current_subscribe_title: 'Token Plan Plus',
    points_balance: '14000',
    model_remains: [
      {
        model_name: 'general',
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: '96',
        start_time: 1780279200000,
        end_time: 1780297200000,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_weekly_remaining_percent: '99',
        weekly_start_time: 1780243200000,
        weekly_end_time: 1780848000000,
      },
    ],
  },
};

// The official CLI fixture is flat: `model_remains` sits at the top level.
const FLAT_USAGE_RESPONSE = {
  base_resp: { status_code: 0, status_msg: 'success' },
  model_remains: USAGE_RESPONSE.data.model_remains,
};

const BALANCE_RESPONSE = {
  base_resp: { status_code: 0, status_msg: 'success' },
  available_amount: '98.00001',
  cash_balance: '-2.50',
  voucher_balance: '100.50001',
  credit_balance: '0',
  owed_amount: '2.50',
  balance_alert_switch: true,
  balance_alert_threshold: '10',
};

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function textConfig(baseUrl) {
  return { baseUrl };
}

test('ADAPTER declares the minimax identity without claiming another adapter host', () => {
  assert.ok(Object.isFrozen(ADAPTER));
  assert.ok(Object.isFrozen(ADAPTER.hosts));
  assert.equal(ADAPTER.id, 'minimax');
  assert.equal(ADAPTER.metric, 'usage windows');
  assert.deepEqual(ADAPTER.hosts, ['api.minimax.io', 'api.minimax.cn', 'api.minimaxi.com']);
  assert.equal(typeof ADAPTER.accepts, 'function');
  assert.equal(typeof ADAPTER.request, 'function');
  const taken = new Set([
    ...DEEPSEEK_ADAPTER.hosts,
    ...OPENCODE_GO_ADAPTER.hosts,
    ...ZHIPU_ADAPTER.hosts,
  ]);
  for (const host of MINIMAX_HOSTS) {
    assert.equal(taken.has(host), false, `${host} is already served`);
  }
});

test('accepts resolves region and currency from the official inference hosts', () => {
  const global = ADAPTER.accepts(textConfig('https://api.minimax.io/v1'));
  assert.deepEqual(global, {
    region: 'global',
    currency: 'USD',
    usageUrl: MINIMAX_GLOBAL_USAGE_URL,
    balanceUrl: MINIMAX_GLOBAL_BALANCE_URL,
  });
  assert.equal(ADAPTER.accepts(textConfig('https://api.minimax.io/anthropic')).currency, 'USD');
  assert.equal(ADAPTER.accepts(textConfig('https://api.minimax.io')).usageUrl,
    MINIMAX_GLOBAL_USAGE_URL);
  const cn = ADAPTER.accepts(textConfig('https://api.minimax.cn/v1/'));
  assert.equal(cn.region, 'cn');
  assert.equal(cn.currency, 'CNY');
  const legacy = ADAPTER.accepts(textConfig('https://api.minimaxi.com/anthropic'));
  assert.equal(legacy.currency, 'CNY');
  assert.equal(legacy.usageUrl, MINIMAX_CN_LEGACY_USAGE_URL);
  assert.equal(legacy.balanceUrl, MINIMAX_CN_LEGACY_BALANCE_URL);
});

test('accepts normalizes the public www and platform spellings onto the api host', () => {
  for (const [baseUrl, expected] of [
    ['https://www.minimax.io/v1', MINIMAX_GLOBAL_USAGE_URL],
    ['https://platform.minimax.io/anthropic', MINIMAX_GLOBAL_USAGE_URL],
    ['https://www.minimax.cn/v1', MINIMAX_CN_USAGE_URL],
    ['https://platform.minimaxi.com/v1', MINIMAX_CN_LEGACY_USAGE_URL],
  ]) {
    const endpoints = ADAPTER.accepts(textConfig(baseUrl));
    assert.ok(endpoints, baseUrl);
    assert.equal(endpoints.usageUrl, expected, baseUrl);
  }
});

test('accepts fails closed for proxies, lookalikes and unsafe URLs', () => {
  for (const baseUrl of [
    'https://proxy.example/v1',
    'http://api.minimax.io/v1',
    'https://api.minimax.io.evil/v1',
    'https://notapi.minimax.io/v1',
    'https://api.minimax.io:8443/v1',
    'https://user:pass@api.minimax.io/v1',
    'https://api.minimax.chat/v1',
    'https://api.minimaxi.chat/v1',
    'not a url',
    '',
  ]) {
    assert.equal(ADAPTER.accepts(textConfig(baseUrl)), null, baseUrl);
  }
  assert.equal(ADAPTER.accepts(null), null);
  assert.equal(ADAPTER.accepts(undefined), null);
  assert.equal(ADAPTER.accepts({}), null);
  assert.equal(ADAPTER.accepts(textConfig(null)), null);
});

test('parseMiniMaxUsage maps the 5h and 7d windows of the wrapped fixture', () => {
  assert.deepEqual(parseMiniMaxUsage(USAGE_RESPONSE, NOW), {
    kind: 'windows',
    label: 'MiniMax Token Plan Plus',
    windows: [
      { label: '5h', usedRatio: 0.04, resetAt: '2026-06-01T07:00:00.000Z' },
      { label: '7d', usedRatio: 0.01, resetAt: '2026-06-07T16:00:00.000Z' },
    ],
  });
  assert.deepEqual(parseMiniMaxUsage(USAGE_RESPONSE, NOW), normalizeUsage(
    parseMiniMaxUsage(USAGE_RESPONSE, NOW),
  ));
});

test('parseMiniMaxUsage accepts the flat official CLI shape', () => {
  const parsed = parseMiniMaxUsage(FLAT_USAGE_RESPONSE, NOW);
  assert.equal(parsed.label, 'MiniMax');
  assert.deepEqual(parsed.windows.map((window) => window.label), ['5h', '7d']);
  assert.deepEqual(parsed.windows.map((window) => window.usedRatio), [0.04, 0.01]);
});

test('parseMiniMaxUsage picks text rows and drops non-text or unlimited placeholders', () => {
  const withVideo = {
    base_resp: { status_code: 0 },
    data: {
      model_remains: [
        {
          model_name: 'video',
          current_interval_status: 3,
          current_interval_total_count: 0,
          current_interval_remaining_percent: '0',
        },
        { model_name: 'speech-01', current_interval_remaining_percent: '5' },
        { model_name: 'image-01', current_weekly_remaining_percent: '5' },
        {
          model_name: 'general',
          current_interval_remaining_percent: 40,
          current_weekly_remaining_percent: 80,
        },
      ],
    },
  };
  const parsed = parseMiniMaxUsage(withVideo, NOW);
  assert.deepEqual(parsed.windows.map((window) => window.usedRatio), [0.6, 0.2]);
  assert.equal(parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [{ model_name: 'video', current_weekly_remaining_percent: '10' }],
  }, NOW), null);
  // A new-format model row is still text quota.
  const newFormat = parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [
      { model_name: 'video', current_interval_status: 3 },
      { model_name: 'MiniMax-M2.7', current_interval_remaining_percent: '25' },
    ],
  }, NOW);
  assert.equal(newFormat.windows[0].label, '5h');
  assert.equal(newFormat.windows[0].usedRatio, 0.75);
  // An unlimited interval keeps the weekly window only.
  const unlimited = parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      current_interval_status: 3,
      current_interval_remaining_percent: '0',
      current_weekly_remaining_percent: '50',
    }],
  }, NOW);
  assert.deepEqual(unlimited.windows.map((window) => window.label), ['7d']);
  // Exhausted (status 2) is a real window at 100% use.
  const exhausted = parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      current_interval_status: 2,
      current_interval_remaining_percent: 0,
    }],
  }, NOW);
  assert.equal(exhausted.windows[0].usedRatio, 1);
  // Without a percentage the counts are not guessed into a ratio.
  assert.equal(parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      current_interval_total_count: 1000,
      current_interval_usage_count: 120,
    }],
  }, NOW), null);
});

test('parseMiniMaxUsage falls back to remains_time and refuses implausible stamps', () => {
  const baseRow = {
    model_name: 'general',
    current_interval_remaining_percent: 50,
  };
  const millisecondFallback = parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [{ ...baseRow, remains_time: 3_600_000 }],
  }, NOW);
  assert.equal(millisecondFallback.windows[0].resetAt, '2026-06-01T06:00:00.000Z');
  const secondFallback = parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [{ ...baseRow, remains_time: 600 }],
  }, NOW);
  assert.equal(secondFallback.windows[0].resetAt, '2026-06-01T05:10:00.000Z');
  // A seconds-sized `end_time` is not coerced into a 1970 reset.
  const secondsStamp = parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [{ ...baseRow, end_time: 1780297200 }],
  }, NOW);
  assert.equal(secondsStamp.windows[0].resetAt, null);
  const zeroStamp = parseMiniMaxUsage({
    base_resp: { status_code: 0 },
    model_remains: [{ ...baseRow, end_time: 0, remains_time: 0 }],
  }, NOW);
  assert.equal(zeroStamp.windows[0].resetAt, '2026-06-01T05:00:00.000Z');
});

test('parseMiniMaxUsage refuses unusable envelopes and sanitizes the plan title', () => {
  for (const body of [
    null,
    [],
    {},
    { base_resp: null },
    { base_resp: {} },
    { base_resp: { status_code: 'abc' } },
    { base_resp: { status_code: 1004, status_msg: 'invalid api key' } },
    { base_resp: { status_code: 1005, status_msg: 'oops' } },
    { base_resp: { status_code: 0 }, model_remains: [] },
    { base_resp: { status_code: 0 }, data: { model_remains: [] } },
    { base_resp: { status_code: 0 }, data: { model_remains: 'nope' } },
  ]) {
    assert.equal(parseMiniMaxUsage(body, NOW), null);
  }
  // A numeric string code still opens the envelope.
  const stringCode = parseMiniMaxUsage({
    base_resp: { status_code: '0' },
    model_remains: [{
      model_name: 'general',
      current_interval_remaining_percent: '100',
      end_time: 1780297200000,
    }],
  }, NOW);
  assert.equal(stringCode.windows[0].usedRatio, 0);
  for (const title of ['GLM │ forged', '专业版', 'X'.repeat(40)]) {
    assert.equal(parseMiniMaxUsage({
      base_resp: { status_code: 0 },
      data: {
        current_subscribe_title: title,
        model_remains: [{ model_name: 'general', current_interval_remaining_percent: 1 }],
      },
    }, NOW).label, 'MiniMax');
  }
});

test('parseMiniMaxBalance maps the decimal-string amounts into a USD balance', () => {
  assert.deepEqual(parseMiniMaxBalance(BALANCE_RESPONSE, 'USD'), {
    kind: 'balance',
    label: 'MiniMax',
    available: true,
    balances: [{
      currency: 'USD',
      total: 98.00001,
      granted: 100.50001,
      toppedUp: null,
    }],
  });
  assert.equal(parseMiniMaxBalance(BALANCE_RESPONSE, 'CNY').balances[0].currency, 'CNY');
  assert.equal(parseMiniMaxBalance({
    base_resp: { status_code: 0 },
    available_amount: '12.5',
  }, 'USD').balances[0].granted, null);
  assert.equal(parseMiniMaxBalance({
    base_resp: { status_code: 0 },
    available_amount: '12.5',
    cash_balance: '0',
    voucher_balance: '-1',
  }, 'USD').balances[0].toppedUp, 0);
  assert.equal(parseMiniMaxBalance({
    base_resp: { status_code: 0 },
    available_amount: '12.5',
    voucher_balance: '-1',
  }, 'USD').balances[0].granted, null);
  for (const body of [
    null,
    [],
    { base_resp: { status_code: 1004 }, available_amount: '1' },
    { available_amount: '1' },
    { base_resp: { status_code: 0 } },
    { base_resp: { status_code: 0 }, available_amount: '-1' },
    { base_resp: { status_code: 0 }, available_amount: 'abc' },
  ]) {
    assert.equal(parseMiniMaxBalance(body, 'USD'), null);
  }
  for (const currency of ['usd', 'US', 'USDD', '', null]) {
    assert.equal(parseMiniMaxBalance(BALANCE_RESPONSE, currency), null, String(currency));
  }
  assert.equal(parseMiniMaxBalance(BALANCE_RESPONSE).balances[0].currency, 'USD');
  assert.deepEqual(parseMiniMaxBalance(BALANCE_RESPONSE, 'USD'), normalizeUsage(
    parseMiniMaxBalance(BALANCE_RESPONSE, 'USD'),
  ));
});

test('requestMiniMaxUsage reads the subscription endpoint for a plan key', async () => {
  const calls = [];
  const result = await requestMiniMaxUsage({
    apiKey: SUBSCRIPTION_KEY,
    endpoints: GLOBAL_ENDPOINTS,
    now: NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => USAGE_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed.windows.map((window) => window.label), ['5h', '7d']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MINIMAX_GLOBAL_USAGE_URL);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${SUBSCRIPTION_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.doesNotMatch(JSON.stringify(result.parsed), new RegExp(SUBSCRIPTION_KEY));

  const legacyCalls = [];
  const legacy = await requestMiniMaxUsage({
    apiKey: API_KEY,
    endpoints: CN_LEGACY_ENDPOINTS,
    fetchImpl: async (url) => {
      legacyCalls.push(url);
      return { ok: true, status: 200, json: async () => FLAT_USAGE_RESPONSE };
    },
  });
  assert.equal(legacy.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(legacyCalls, [MINIMAX_CN_LEGACY_USAGE_URL]);
});

test('requestMiniMaxUsage reads the balance endpoint for a sk-api- key', async () => {
  const calls = [];
  const cn = await requestMiniMaxUsage({
    apiKey: PAY_AS_YOU_GO_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => BALANCE_RESPONSE };
    },
  });
  assert.equal(cn.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.equal(cn.parsed.kind, 'balance');
  assert.equal(cn.parsed.balances[0].currency, 'CNY');
  assert.equal(cn.parsed.balances[0].total, 98.00001);
  assert.deepEqual(calls.map((call) => call.url), [MINIMAX_CN_BALANCE_URL]);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${PAY_AS_YOU_GO_KEY}`);

  const globalCalls = [];
  const global = await requestMiniMaxUsage({
    apiKey: PAY_AS_YOU_GO_KEY,
    endpoints: GLOBAL_ENDPOINTS,
    fetchImpl: async (url) => {
      globalCalls.push(url);
      return { ok: true, status: 200, json: async () => BALANCE_RESPONSE };
    },
  });
  assert.equal(global.parsed.balances[0].currency, 'USD');
  assert.deepEqual(globalCalls, [MINIMAX_GLOBAL_BALANCE_URL]);
});

test('requestMiniMaxUsage refuses non-official or inconsistent endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    null,
    {},
    {
      currency: 'USD',
      usageUrl: 'https://proxy.example/v1/token_plan/remains',
      balanceUrl: MINIMAX_GLOBAL_BALANCE_URL,
    },
    {
      currency: 'USD',
      usageUrl: MINIMAX_GLOBAL_USAGE_URL,
      balanceUrl: 'https://proxy.example/account/query_balance',
    },
    {
      currency: 'USD',
      usageUrl: 'https://api.minimax.io/v1/token_plan/remain',
      balanceUrl: MINIMAX_GLOBAL_BALANCE_URL,
    },
    {
      currency: 'USD',
      usageUrl: MINIMAX_GLOBAL_USAGE_URL,
      balanceUrl: `${MINIMAX_GLOBAL_BALANCE_URL}?x=1`,
    },
    {
      currency: 'USD',
      usageUrl: MINIMAX_GLOBAL_USAGE_URL,
      balanceUrl: MINIMAX_CN_BALANCE_URL,
    },
    {
      currency: 'USD',
      usageUrl: MINIMAX_CN_USAGE_URL,
      balanceUrl: MINIMAX_CN_BALANCE_URL,
    },
    {
      currency: 'EUR',
      usageUrl: MINIMAX_GLOBAL_USAGE_URL,
      balanceUrl: MINIMAX_GLOBAL_BALANCE_URL,
    },
  ]) {
    const result = await requestMiniMaxUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  for (const apiKey of ['', null, undefined, 42]) {
    const result = await requestMiniMaxUsage({
      apiKey, endpoints: GLOBAL_ENDPOINTS, fetchImpl,
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  }
  assert.equal(called, false);
});

test('requestMiniMaxUsage dispatches HTTP failures through the shared vocabulary', async () => {
  const cases = [
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [500, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [503, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [400, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [404, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [405, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [418, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expectedStatus, expectedCategory] of cases) {
    const result = await requestMiniMaxUsage({
      apiKey: SUBSCRIPTION_KEY,
      endpoints: GLOBAL_ENDPOINTS,
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal(result.status, expectedStatus, `HTTP ${status}`);
    assert.equal(result.category, expectedCategory, `HTTP ${status}`);
  }
  const rateLimited = await requestMiniMaxUsage({
    apiKey: SUBSCRIPTION_KEY,
    endpoints: GLOBAL_ENDPOINTS,
    now: NOW,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
    }),
  });
  assert.equal(rateLimited.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(rateLimited.category, REQUEST_CATEGORY.RATE_LIMITED);
  assert.equal(rateLimited.retryAfterSeen, true);
  assert.equal(rateLimited.retryAfterMs, 30_000);
  const offline = await requestMiniMaxUsage({
    apiKey: SUBSCRIPTION_KEY,
    endpoints: GLOBAL_ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);
  const timedOut = await requestMiniMaxUsage({
    apiKey: SUBSCRIPTION_KEY,
    endpoints: GLOBAL_ENDPOINTS,
    timeoutMs: 10,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(timedOut.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(timedOut.category, REQUEST_CATEGORY.TIMEOUT);
});

test('requestMiniMaxUsage maps body envelope codes before parsing', async () => {
  const unauthorized = await requestMiniMaxUsage({
    apiKey: SUBSCRIPTION_KEY,
    endpoints: GLOBAL_ENDPOINTS,
    fetchImpl: jsonResponse({
      base_resp: {
        status_code: 1004,
        status_msg: 'login fail: Please carry the API secret key in the Authorization field',
      },
    }),
  });
  assert.equal(unauthorized.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);
  assert.equal(unauthorized.category, REQUEST_CATEGORY.AUTH);

  const unauthorizedVariants = [1001, '2049'];
  for (const code of unauthorizedVariants) {
    const result = await requestMiniMaxUsage({
      apiKey: SUBSCRIPTION_KEY,
      endpoints: GLOBAL_ENDPOINTS,
      fetchImpl: jsonResponse({ base_resp: { status_code: code, status_msg: 'invalid api key' } }),
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED, String(code));
  }

  const balanceUnauthorized = await requestMiniMaxUsage({
    apiKey: PAY_AS_YOU_GO_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: jsonResponse({ base_resp: { status_code: 1004, status_msg: 'not authorized' } }),
  });
  assert.equal(balanceUnauthorized.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);

  for (const body of [
    { base_resp: { status_code: 1005, status_msg: 'business error' } },
    { base_resp: { status_code: 0 } },
    { base_resp: { status_code: 0 }, data: null },
    'not an object',
    [],
  ]) {
    const result = await requestMiniMaxUsage({
      apiKey: SUBSCRIPTION_KEY,
      endpoints: GLOBAL_ENDPOINTS,
      fetchImpl: jsonResponse(body),
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(body));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT, JSON.stringify(body));
  }
});

test('the sk-api- prefix alone selects the balance surface', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => BALANCE_RESPONSE };
  };
  const upperCase = await requestMiniMaxUsage({
    apiKey: 'SK-API-test-key', endpoints: GLOBAL_ENDPOINTS, fetchImpl,
  });
  assert.deepEqual(urls, [MINIMAX_GLOBAL_USAGE_URL]);
  assert.equal(upperCase.status, PROVIDER_USAGE_RESULT.INVALID);
  const prefixOnly = await requestMiniMaxUsage({
    apiKey: 'sk-api', endpoints: GLOBAL_ENDPOINTS, fetchImpl,
  });
  assert.deepEqual(urls, [MINIMAX_GLOBAL_USAGE_URL, MINIMAX_GLOBAL_USAGE_URL]);
  assert.equal(prefixOnly.status, PROVIDER_USAGE_RESULT.INVALID);
});
