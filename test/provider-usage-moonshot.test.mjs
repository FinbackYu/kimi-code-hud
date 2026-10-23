import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { PROVIDER_USAGE_RESULT, normalizeUsage } from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  MOONSHOT_CN_BALANCE_URL,
  MOONSHOT_INTL_BALANCE_URL,
  MOONSHOT_PROVIDER,
  parseMoonshotBalance,
  requestMoonshotUsage,
} from '../src/provider-usage/moonshot.mjs';

const API_KEY = 'test-key';
const INTL_ENDPOINTS = Object.freeze({
  region: 'intl',
  currency: 'USD',
  usageUrl: MOONSHOT_INTL_BALANCE_URL,
  balanceUrl: null,
});
const CN_ENDPOINTS = Object.freeze({
  region: 'cn',
  currency: 'CNY',
  usageUrl: MOONSHOT_CN_BALANCE_URL,
  balanceUrl: null,
});

// Official-document sample, matching the CodexBar fixture shape.
const BALANCE_RESPONSE = {
  code: 0,
  data: {
    available_balance: 49.58894,
    voucher_balance: 46.58893,
    cash_balance: 3.00001,
  },
  scode: '0x0',
  status: true,
};

function configFor(baseUrl) {
  return { provider: 'kimi', baseUrl };
}

test('parseMoonshotBalance maps the official sample onto a USD balance', () => {
  const parsed = parseMoonshotBalance(BALANCE_RESPONSE, 'USD');
  assert.deepEqual(parsed, {
    kind: 'balance',
    label: 'Moonshot',
    available: true,
    balances: [{
      currency: 'USD',
      total: 49.58894,
      granted: 46.58893,
      toppedUp: 3.00001,
    }],
  });
  assert.deepEqual(normalizeUsage(parsed), parsed);
  assert.deepEqual(parseMoonshotBalance(BALANCE_RESPONSE, 'CNY').balances[0].currency, 'CNY');
  // ISO 4217 currency is required and upper-cased.
  assert.equal(parseMoonshotBalance(BALANCE_RESPONSE, 'usd').balances[0].currency, 'USD');
  assert.deepEqual(parseMoonshotBalance(BALANCE_RESPONSE), parseMoonshotBalance(BALANCE_RESPONSE, 'USD'));
  for (const currency of ['', 'US', 'USDD', 'USDX', null, 42]) {
    assert.equal(parseMoonshotBalance(BALANCE_RESPONSE, currency), null, String(currency));
  }
});

test('parseMoonshotBalance clamps negative balances instead of rejecting them', () => {
  const arrears = parseMoonshotBalance({
    code: 0,
    status: true,
    data: { available_balance: -12.345, voucher_balance: 0, cash_balance: -12.345 },
  }, 'USD');
  assert.deepEqual(arrears.balances, [{
    currency: 'USD', total: 0, granted: 0, toppedUp: 0,
  }]);
  // A negative voucher figure (documented as impossible) still cannot leak a
  // negative amount into the shared balance contract.
  const voucherDebt = parseMoonshotBalance({
    code: 0,
    status: true,
    data: { available_balance: 2, voucher_balance: -1 },
  }, 'USD');
  assert.equal(voucherDebt.balances[0].total, 2);
  assert.equal(voucherDebt.balances[0].granted, 0);
  assert.equal(voucherDebt.balances[0].toppedUp, null);
  // Zero balance is a normal answer, not an error.
  assert.deepEqual(
    parseMoonshotBalance({ code: 0, status: true, data: { available_balance: 0, cash_balance: 0 } }, 'USD')
      .balances[0],
    { currency: 'USD', total: 0, granted: null, toppedUp: 0 },
  );
});

test('parseMoonshotBalance accepts numeric strings and refuses non-finite totals', () => {
  const parsed = parseMoonshotBalance({
    code: 0,
    status: true,
    data: { available_balance: '7.25', voucher_balance: '7', cash_balance: ' 0.25 ' },
  }, 'USD');
  assert.deepEqual(parsed.balances[0], { currency: 'USD', total: 7.25, granted: 7, toppedUp: 0.25 });
  // The total is required; it is never recomputed from the parts.
  assert.equal(parseMoonshotBalance({ code: 0, status: true, data: { cash_balance: 1 } }, 'USD'), null);
  assert.equal(parseMoonshotBalance({
    code: 0, status: true, data: { available_balance: 'Infinity' },
  }, 'USD'), null);
  assert.equal(parseMoonshotBalance({
    code: 0, status: true, data: { available_balance: 1e999 },
  }, 'USD'), null);
  assert.equal(parseMoonshotBalance({
    code: 0, status: true, data: { available_balance: '' },
  }, 'USD'), null);
  // Blank optional parts become null rather than zero.
  assert.equal(parseMoonshotBalance({
    code: 0, status: true, data: { available_balance: 1, voucher_balance: '', cash_balance: null },
  }, 'USD').balances[0].granted, null);
});

test('parseMoonshotBalance requires a successful envelope', () => {
  const data = { available_balance: 1, voucher_balance: 0, cash_balance: 1 };
  assert.equal(parseMoonshotBalance({ code: 0, scode: '0x0', status: true, data }, 'USD').kind, 'balance');
  // Either success signal alone is enough…
  assert.ok(parseMoonshotBalance({ code: 0, data }, 'USD'));
  assert.ok(parseMoonshotBalance({ status: true, data }, 'USD'));
  // …and either failure signal defeats the other.
  assert.equal(parseMoonshotBalance({ status: false, code: 0, data }, 'USD'), null);
  assert.equal(parseMoonshotBalance({ status: true, code: 500, data }, 'USD'), null);
  assert.equal(parseMoonshotBalance({ code: '401', scode: 'unauthorized', status: false, data }, 'USD'), null);
  // No envelope signal at all fails closed.
  assert.equal(parseMoonshotBalance({ data }, 'USD'), null);
  assert.equal(parseMoonshotBalance({ status: 'true', code: null, data }, 'USD'), null);
  for (const body of [null, undefined, [], 'ok', 42]) {
    assert.equal(parseMoonshotBalance(body, 'USD'), null);
  }
  assert.equal(parseMoonshotBalance({ code: 0, status: true, data: null }, 'USD'), null);
  assert.equal(parseMoonshotBalance({ code: 0, status: true, data: [data] }, 'USD'), null);
});

test('accepts() pins the official hosts and derives the currency from the host', () => {
  assert.deepEqual(ADAPTER.accepts(configFor('https://api.moonshot.ai/v1')), INTL_ENDPOINTS);
  assert.deepEqual(ADAPTER.accepts(configFor('https://api.moonshot.ai/v1/')), INTL_ENDPOINTS);
  assert.deepEqual(ADAPTER.accepts(configFor('https://api.moonshot.ai')), INTL_ENDPOINTS);
  assert.deepEqual(ADAPTER.accepts(configFor('https://api.moonshot.cn/v1')), CN_ENDPOINTS);
  assert.deepEqual(ADAPTER.accepts(configFor('https://api.moonshot.cn/v1/')), CN_ENDPOINTS);
  for (const baseUrl of [
    'https://api.moonshot.ai.evil/v1',
    'https://proxy.example/v1',
    'http://api.moonshot.ai/v1',
    'https://api.moonshot.ai:8443/v1',
    'https://user:pass@api.moonshot.ai/v1',
    'https://api.moonshot.ai/v2',
    'https://api.moonshot.ai/v1/chat/completions',
    'https://api.moonshot.ai/v1?key=1',
    'https://api.moonshot.ai/v1#frag',
    'https://api.kimi.com/coding/v1',
    'https://platform.moonshot.ai/v1',
    'https://platform.kimi.com/v1',
    'not a url',
    '',
    null,
    undefined,
  ]) {
    assert.equal(ADAPTER.accepts(configFor(baseUrl)), null, String(baseUrl));
  }
  assert.equal(ADAPTER.accepts(null), null);
  assert.equal(ADAPTER.accepts({}), null);
  assert.equal(ADAPTER.accepts({ baseUrl: 42 }), null);
});

test('the adapter identity and hosts stay disjoint from the other adapters', () => {
  assert.equal(ADAPTER.id, 'moonshot');
  assert.equal(MOONSHOT_PROVIDER, 'moonshot');
  assert.equal(ADAPTER.metric, 'balance');
  assert.deepEqual([...ADAPTER.hosts], ['api.moonshot.ai', 'api.moonshot.cn']);
  assert.ok(Object.isFrozen(ADAPTER));
  assert.ok(Object.isFrozen(ADAPTER.hosts));
  for (const occupied of ['api.deepseek.com', 'opencode.ai', 'open.bigmodel.cn', 'api.z.ai']) {
    assert.equal(ADAPTER.hosts.includes(occupied), false, occupied);
  }
});

test('requestMoonshotUsage calls the balance endpoint of the accepted region', async () => {
  const calls = [];
  const result = await requestMoonshotUsage({
    apiKey: API_KEY,
    endpoints: INTL_ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => BALANCE_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed.balances, [{
    currency: 'USD', total: 49.58894, granted: 46.58893, toppedUp: 3.00001,
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MOONSHOT_INTL_BALANCE_URL);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.deepEqual(Object.keys(calls[0].options.headers), ['Authorization', 'Accept']);
  assert.doesNotMatch(JSON.stringify(result.parsed), new RegExp(API_KEY));

  const cnCalls = [];
  const cn = await requestMoonshotUsage({
    apiKey: API_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: async (url) => {
      cnCalls.push(url);
      return { ok: true, status: 200, json: async () => BALANCE_RESPONSE };
    },
  });
  assert.deepEqual(cnCalls, [MOONSHOT_CN_BALANCE_URL]);
  assert.equal(cn.parsed.balances[0].currency, 'CNY');
});

test('requestMoonshotUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    null,
    undefined,
    { region: 'intl', currency: 'USD', usageUrl: 'https://proxy.example/v1/users/me/balance', balanceUrl: null },
    { region: 'intl', currency: 'USD', usageUrl: 'https://api.moonshot.ai/v1/users/me/balance?key=1', balanceUrl: null },
    { region: 'intl', currency: 'USD', usageUrl: 'https://api.moonshot.ai/v1/users/me/balance#x', balanceUrl: null },
    { region: 'intl', currency: 'USD', usageUrl: 'http://api.moonshot.ai/v1/users/me/balance', balanceUrl: null },
    { region: 'intl', currency: 'USD', usageUrl: 'https://api.moonshot.ai:8443/v1/users/me/balance', balanceUrl: null },
    { region: 'intl', currency: 'USD', usageUrl: 'https://api.moonshot.ai/v1/users/me/balance/extra', balanceUrl: null },
    { region: 'intl', currency: 'USD', usageUrl: 'https://api.kimi.com/v1/users/me/balance', balanceUrl: null },
    // A currency that disagrees with the endpoint host would label CNY as USD.
    { region: 'intl', currency: 'CNY', usageUrl: MOONSHOT_INTL_BALANCE_URL, balanceUrl: null },
    { region: 'cn', currency: 'USD', usageUrl: MOONSHOT_CN_BALANCE_URL, balanceUrl: null },
  ]) {
    const result = await requestMoonshotUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(endpoints));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  for (const apiKey of ['', null, undefined, 42]) {
    const result = await requestMoonshotUsage({ apiKey, endpoints: INTL_ENDPOINTS, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  }
  assert.equal(called, false);
});

test('requestMoonshotUsage maps HTTP failures onto the four result states', async () => {
  const cases = [
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.RATE_LIMITED],
    [500, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [503, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [201, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [404, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expected, category] of cases) {
    const urls = [];
    const result = await requestMoonshotUsage({
      apiKey: API_KEY,
      endpoints: INTL_ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: status < 300 && status >= 200 && status !== 201, status, json: async () => BALANCE_RESPONSE };
      },
    });
    assert.equal(result.status, expected, `HTTP ${status}`);
    assert.equal(result.category, category, `HTTP ${status}`);
    assert.deepEqual(urls, [MOONSHOT_INTL_BALANCE_URL]);
  }
  const offline = await requestMoonshotUsage({
    apiKey: API_KEY,
    endpoints: INTL_ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);
});

test('requestMoonshotUsage honors Retry-After on 429 without a second request', async () => {
  const urls = [];
  const result = await requestMoonshotUsage({
    apiKey: API_KEY,
    endpoints: CN_ENDPOINTS,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: false, status: 429, headers: { get: () => '30' }, json: async () => ({}) };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(result.category, REQUEST_CATEGORY.RATE_LIMITED);
  assert.equal(result.retryAfterSeen, true);
  assert.equal(result.retryAfterMs, 30_000);
  assert.deepEqual(urls, [MOONSHOT_CN_BALANCE_URL]);
});

test('requestMoonshotUsage reads body-level auth errors without retrying', async () => {
  const bodies = [
    { code: 401, scode: 'unauthorized', status: false, msg: 'token invalid' },
    { code: '401', scode: 'Unauthorized', status: false },
    { code: 401, scode: '0x0', status: false },
  ];
  for (const body of bodies) {
    const urls = [];
    const result = await requestMoonshotUsage({
      apiKey: API_KEY,
      endpoints: INTL_ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => body };
      },
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);
    assert.equal(result.category, REQUEST_CATEGORY.AUTH);
    assert.deepEqual(urls, [MOONSHOT_INTL_BALANCE_URL]);
  }
});

test('requestMoonshotUsage degrades other body and payload failures to invalid', async () => {
  const bodies = [
    { code: 1001, scode: 'insufficient_privilege', status: false },
    { code: 0, status: false },
    { code: 500, status: true, data: { available_balance: 1 } },
    { status: true, data: null },
    { status: true, data: { available_balance: 'nope' } },
    { msg: 'ok' },
    [],
  ];
  for (const body of bodies) {
    const urls = [];
    const result = await requestMoonshotUsage({
      apiKey: API_KEY,
      endpoints: INTL_ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => body };
      },
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(body));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
    assert.deepEqual(urls, [MOONSHOT_INTL_BALANCE_URL]);
  }
  const nonObject = await requestMoonshotUsage({
    apiKey: API_KEY,
    endpoints: INTL_ENDPOINTS,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => null }),
  });
  assert.equal(nonObject.status, PROVIDER_USAGE_RESULT.INVALID);
});

test('requestMoonshotUsage enforces the response body ceiling', async () => {
  const result = await requestMoonshotUsage({
    apiKey: API_KEY,
    endpoints: INTL_ENDPOINTS,
    maxBytes: 16,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => BALANCE_RESPONSE,
      body: {
        getReader() {
          return {
            async read() {
              return { done: false, value: new Uint8Array(64) };
            },
            async cancel() {},
            releaseLock() {},
          };
        },
      },
    }),
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(result.category, REQUEST_CATEGORY.BODY_LIMIT);
});
