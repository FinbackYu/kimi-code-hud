import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { PROVIDER_USAGE_RESULT, normalizeUsage } from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  VENICE_BALANCE_URL,
  parseVeniceBalance,
  requestVeniceUsage,
} from '../src/provider-usage/venice.mjs';

const API_KEY = 'test-key';
const ENDPOINTS = Object.freeze({ usageUrl: VENICE_BALANCE_URL, balanceUrl: null });

// Official billing-balance sample (docs.venice.ai) with synthetic amounts: a
// DIEM account that still has a separate USD credit, which the DIEM epoch wins
// over. The service reports no reset timestamp.
const DIEM_RESPONSE = {
  canConsume: true,
  consumptionCurrency: 'DIEM',
  balances: { diem: 90.5, usd: 25 },
  diemEpochAllocation: 100,
};

const DIEM_EXPECTED = Object.freeze({
  kind: 'windows',
  label: 'Venice',
  windows: [{ label: '1d', usedRatio: 0.095, resetAt: null }],
});

const USD_RESPONSE = {
  canConsume: true,
  consumptionCurrency: 'USD',
  balances: { diem: null, usd: 25 },
  diemEpochAllocation: 100,
};

const USD_EXPECTED = Object.freeze({
  kind: 'balance',
  label: 'Venice',
  available: true,
  balances: [{ currency: 'USD', total: 25, granted: null, toppedUp: null }],
});

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('ADAPTER exposes the frozen balance contract', () => {
  assert.equal(ADAPTER.id, 'venice');
  assert.deepEqual(ADAPTER.hosts, ['api.venice.ai']);
  assert.equal(ADAPTER.metric, 'balance');
  assert.equal(Object.isFrozen(ADAPTER), true);
  assert.equal(Object.isFrozen(ADAPTER.hosts), true);
  assert.equal(VENICE_BALANCE_URL, 'https://api.venice.ai/api/v1/billing/balance');
  assert.deepEqual(ADAPTER.accepts({ baseUrl: 'https://api.venice.ai/api/v1' }), {
    usageUrl: VENICE_BALANCE_URL,
    balanceUrl: null,
  });
});

test('parseVeniceBalance maps the DIEM epoch to one 1d window', () => {
  assert.deepEqual(parseVeniceBalance(DIEM_RESPONSE), DIEM_EXPECTED);
  // The CodexBar golden fixture (synthetic) uses a plain USD null.
  assert.deepEqual(parseVeniceBalance({
    canConsume: true,
    consumptionCurrency: 'DIEM',
    balances: { diem: 90.5, usd: null },
    diemEpochAllocation: 100,
  }), DIEM_EXPECTED);
  // Decimal strings are accepted the same way as numbers.
  assert.deepEqual(parseVeniceBalance({
    canConsume: true,
    consumptionCurrency: 'DIEM',
    balances: { diem: '90.50', usd: null },
    diemEpochAllocation: '100.0',
  }), DIEM_EXPECTED);
  // The result passes the shared normalizer unchanged.
  assert.deepEqual(normalizeUsage(DIEM_EXPECTED), DIEM_EXPECTED);
});

test('parseVeniceBalance reports a USD consumption currency as a USD balance', () => {
  assert.deepEqual(parseVeniceBalance(USD_RESPONSE), USD_EXPECTED);
  assert.deepEqual(normalizeUsage(USD_EXPECTED), USD_EXPECTED);
  // A non-USD purchase currency with a positive USD credit shows that credit.
  assert.deepEqual(parseVeniceBalance({
    canConsume: true,
    consumptionCurrency: 'BUNDLED_CREDITS',
    balances: { diem: null, usd: 5 },
    diemEpochAllocation: null,
  }), {
    kind: 'balance',
    label: 'Venice',
    available: true,
    balances: [{ currency: 'USD', total: 5, granted: null, toppedUp: null }],
  });
});

test('parseVeniceBalance clamps the epoch share into [0, 1]', () => {
  // Remaining DIEM above the allocation is ahead of schedule, not negative use.
  const ahead = parseVeniceBalance({
    canConsume: true,
    consumptionCurrency: 'DIEM',
    balances: { diem: 120, usd: null },
    diemEpochAllocation: 100,
  });
  assert.equal(ahead.windows[0].usedRatio, 0);
  // An overdrawn epoch saturates at fully used.
  const overdrawn = parseVeniceBalance({
    canConsume: true,
    consumptionCurrency: 'DIEM',
    balances: { diem: -5, usd: null },
    diemEpochAllocation: 100,
  });
  assert.equal(overdrawn.windows[0].usedRatio, 1);
});

test('parseVeniceBalance maps an exhausted account and missing data conservatively', () => {
  // canConsume false is the service's own "cannot consume" signal.
  const exhausted = parseVeniceBalance({
    canConsume: false,
    consumptionCurrency: null,
    balances: { diem: 0, usd: 0 },
    diemEpochAllocation: 100,
  });
  assert.equal(exhausted.windows[0].usedRatio, 1);
  // DIEM without an allocation cannot be a share, but it is not consumed yet.
  const noAllocation = parseVeniceBalance({
    canConsume: true,
    consumptionCurrency: 'DIEM',
    balances: { diem: 30, usd: null },
    diemEpochAllocation: null,
  });
  assert.equal(noAllocation.windows[0].usedRatio, 0);
  // "Can consume" with nothing quantified is hidden, not advertised as spent.
  assert.equal(parseVeniceBalance({
    canConsume: true,
    consumptionCurrency: 'BUNDLED_CREDITS',
    balances: { diem: null, usd: null },
    diemEpochAllocation: null,
  }), null);
  assert.equal(parseVeniceBalance({
    canConsume: true,
    consumptionCurrency: null,
    balances: { diem: null, usd: null },
    diemEpochAllocation: null,
  }), null);
});

test('parseVeniceBalance refuses unusable payloads instead of reading them as zero', () => {
  for (const payload of [
    null,
    undefined,
    'ok',
    [],
    {},
    { canConsume: true },
    { canConsume: true, balances: null },
    { canConsume: true, balances: [] },
    { canConsume: 'true', balances: { diem: 1, usd: 1 }, diemEpochAllocation: 10 },
    { balances: { diem: 1, usd: 1 }, diemEpochAllocation: 10 },
    { canConsume: true, balances: { diem: '0x10', usd: null }, diemEpochAllocation: 10 },
    { canConsume: true, balances: { diem: '1,000', usd: null }, diemEpochAllocation: 10 },
    { canConsume: true, balances: { diem: '1e999', usd: null }, diemEpochAllocation: 10 },
    { canConsume: true, balances: { diem: '', usd: null }, diemEpochAllocation: 10 },
    { canConsume: true, balances: { diem: true, usd: null }, diemEpochAllocation: 10 },
    { canConsume: true, balances: { diem: { amount: 1 }, usd: null }, diemEpochAllocation: 10 },
    { canConsume: true, balances: { diem: NaN, usd: null }, diemEpochAllocation: 10 },
    { error: 'Unauthorized' },
  ]) {
    assert.equal(parseVeniceBalance(payload), null, JSON.stringify(payload));
  }
});

test('accepts honors the official inference base and fails closed elsewhere', () => {
  for (const baseUrl of [
    'https://api.venice.ai',
    'https://api.venice.ai/',
    'https://api.venice.ai/api/v1',
    'https://api.venice.ai/api/v1/',
    'https://api.venice.ai:443/api/v1',
  ]) {
    assert.deepEqual(ADAPTER.accepts({ baseUrl }), {
      usageUrl: VENICE_BALANCE_URL,
      balanceUrl: null,
    }, baseUrl);
  }
  for (const baseUrl of [
    'https://api.venice.ai.evil/api/v1',
    'https://venice.ai/api/v1',
    'https://outerface.venice.ai/api/v1',
    'https://proxy.example/api/v1',
    'http://api.venice.ai/api/v1',
    'https://api.venice.ai:8443/api/v1',
    'https://user:pass@api.venice.ai/api/v1',
    'https://api.venice.ai/api/v1?x=1',
    'https://api.venice.ai/api/v1#frag',
    'https://api.venice.ai/v1',
    'https://api.venice.ai/api/v2',
    'not a url',
    '',
    42,
    undefined,
  ]) {
    assert.equal(ADAPTER.accepts({ baseUrl }), null, String(baseUrl));
  }
  assert.equal(ADAPTER.accepts(null), null);
  assert.equal(ADAPTER.accepts({}), null);
});

test('requestVeniceUsage calls the pinned balance endpoint with the key', async () => {
  const calls = [];
  const result = await requestVeniceUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => DIEM_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed, DIEM_EXPECTED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.venice.ai/api/v1/billing/balance');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});

test('requestVeniceUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    null,
    {},
    { usageUrl: 'https://proxy.example/api/v1/billing/balance' },
    { usageUrl: 'https://api.venice.ai.evil/api/v1/billing/balance' },
    { usageUrl: 'https://venice.ai/api/v1/billing/balance' },
    { usageUrl: 'http://api.venice.ai/api/v1/billing/balance' },
    { usageUrl: 'https://api.venice.ai:8443/api/v1/billing/balance' },
    { usageUrl: 'https://user:pass@api.venice.ai/api/v1/billing/balance' },
    { usageUrl: 'https://api.venice.ai/api/v1/billing/balance?account=42' },
    { usageUrl: 'https://api.venice.ai/api/v1/billing/balance#frag' },
    { usageUrl: 'https://api.venice.ai/api/v1/billing/usage' },
  ]) {
    const result = await requestVeniceUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, String(endpoints?.usageUrl));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  for (const apiKey of ['', null, undefined, 42]) {
    const result = await requestVeniceUsage({ apiKey, endpoints: ENDPOINTS, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  }
  assert.equal(called, false);
});

test('requestVeniceUsage maps INFERENCE-key 401 and HTTP failures onto the four states', async () => {
  const cases = [
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.RATE_LIMITED],
    [500, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [503, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [400, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [404, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expectedStatus, expectedCategory] of cases) {
    const result = await requestVeniceUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal(result.status, expectedStatus, `HTTP ${status}`);
    assert.equal(result.category, expectedCategory, `HTTP ${status}`);
    assert.equal(Object.hasOwn(result, 'parsed'), false, `HTTP ${status}`);
  }
  const rateLimited = await requestVeniceUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
    }),
  });
  assert.equal(rateLimited.retryAfterSeen, true);
  assert.equal(rateLimited.retryAfterMs, 30_000);

  const offline = await requestVeniceUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);

  const timedOut = await requestVeniceUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    timeoutMs: 10,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(timedOut.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(timedOut.category, REQUEST_CATEGORY.TIMEOUT);
});

test('requestVeniceUsage treats an unusable 200 body as invalid format', async () => {
  for (const body of [
    {},
    { canConsume: true },
    { canConsume: true, balances: { diem: null, usd: null }, diemEpochAllocation: null },
    { error: 'Unauthorized' },
    { balances: { diem: 1, usd: 1 } },
  ]) {
    const result = await requestVeniceUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: jsonResponse(body),
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(body));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
});
