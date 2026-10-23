import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { PROVIDER_USAGE_RESULT, normalizeUsage } from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  KILO_PROVIDER,
  KILO_USAGE_URL,
  parseKiloBalance,
  requestKiloUsage,
} from '../src/provider-usage/kilo.mjs';

const API_KEY = 'test-key';
const NOW = Date.parse('2026-02-10T00:00:00.000Z');

const CREDIT_BLOCKS = {
  creditBlocks: [
    {
      id: 'cb-1',
      effective_date: '2026-02-01T00:00:00Z',
      expiry_date: null,
      balance_mUsd: 19000000,
      amount_mUsd: 19000000,
      is_free: false,
    },
  ],
  totalBalance_mUsd: 19000000,
  autoTopUpEnabled: false,
};

const SUBSCRIPTION = {
  subscription: {
    tier: 'tier_19',
    currentPeriodUsageUsd: 0,
    currentPeriodBaseCreditsUsd: 19.0,
    currentPeriodBonusCreditsUsd: 9.5,
    nextBillingAt: '2026-03-28T04:00:00.000Z',
  },
};

const AUTO_TOP_UP = { enabled: false, amountCents: 5000, paymentMethod: null };

const BATCH_RESPONSE = [
  { result: { data: CREDIT_BLOCKS } },
  { result: { data: SUBSCRIPTION } },
  { result: { data: AUTO_TOP_UP } },
];

const ENDPOINTS = Object.freeze({ usageUrl: KILO_USAGE_URL });

function kiloConfig(baseUrl = 'https://api.kilo.ai/api/gateway') {
  return { baseUrl };
}

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function statusResponse(status, retryAfter = null) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: retryAfter === null ? undefined : { get: (name) => (name === 'retry-after' ? retryAfter : null) },
    json: async () => ({}),
  });
}

test('the adapter pins its id, official inference hosts and balance metric', () => {
  assert.equal(ADAPTER.id, KILO_PROVIDER);
  assert.equal(ADAPTER.id, 'kilo');
  assert.equal(ADAPTER.metric, 'balance');
  assert.deepEqual([...ADAPTER.hosts], ['ai-gateway.kilo.ai', 'api.kilo.ai']);
  assert.equal(typeof ADAPTER.accepts, 'function');
  assert.equal(ADAPTER.request, requestKiloUsage);
  assert.ok(Object.isFrozen(ADAPTER));
  // Hosts already owned by the sibling adapters must not be claimed here.
  for (const foreign of ['api.deepseek.com', 'opencode.ai', 'open.bigmodel.cn', 'api.z.ai']) {
    assert.equal(ADAPTER.hosts.includes(foreign), false, foreign);
  }
});

test('parseKiloBalance maps the credit-block fixture to a USD balance', () => {
  const parsed = parseKiloBalance(CREDIT_BLOCKS);
  assert.deepEqual(parsed, {
    kind: 'balance',
    label: 'Kilo',
    available: true,
    balances: [{ currency: 'USD', total: 19, granted: null, toppedUp: null }],
  });
  assert.deepEqual(normalizeUsage(parsed), parsed);
});

test('parseKiloBalance treats an exhausted account as a zero balance', () => {
  const parsed = parseKiloBalance({ creditBlocks: [], totalBalance_mUsd: 0, autoTopUpEnabled: false });
  assert.deepEqual(parsed, {
    kind: 'balance',
    label: 'Kilo',
    available: false,
    balances: [{ currency: 'USD', total: 0, granted: null, toppedUp: null }],
  });
});

test('parseKiloBalance recomputes the total from blocks only when the aggregate is absent', () => {
  const summed = parseKiloBalance({
    creditBlocks: [
      { balance_mUsd: 1_500_000, is_free: true },
      { balance_mUsd: 2_500_000, is_free: false },
    ],
  });
  assert.equal(summed.balances[0].total, 4);
  // The aggregate wins over the block sum when both are present.
  assert.equal(parseKiloBalance({
    creditBlocks: [{ balance_mUsd: 1 }],
    totalBalance_mUsd: 7_000_000,
  }).balances[0].total, 7);
  // String amounts are accepted the way JSON encoders sometimes emit them.
  assert.equal(parseKiloBalance({ totalBalance_mUsd: '2500000' }).balances[0].total, 2.5);
});

test('parseKiloBalance refuses unusable payloads', () => {
  assert.equal(parseKiloBalance(null), null);
  assert.equal(parseKiloBalance([]), null);
  assert.equal(parseKiloBalance({}), null);
  assert.equal(parseKiloBalance({ creditBlocks: [] }), null);
  assert.equal(parseKiloBalance({ totalBalance_mUsd: -1 }), null);
  assert.equal(parseKiloBalance({ totalBalance_mUsd: 'n/a' }), null);
  assert.equal(parseKiloBalance({ creditBlocks: [{ balance_mUsd: 'n/a' }] }), null);
  assert.equal(parseKiloBalance({ creditBlocks: [{ balance_mUsd: -5 }] }), null);
});

test('accepts serves the documented Kilo inference hosts and paths', () => {
  for (const baseUrl of [
    'https://ai-gateway.kilo.ai',
    'https://ai-gateway.kilo.ai/',
    'https://ai-gateway.kilo.ai/api/v1',
    'https://ai-gateway.kilo.ai/api/v1/',
    'https://api.kilo.ai',
    'https://api.kilo.ai/api/gateway',
    'https://api.kilo.ai/api/openrouter',
  ]) {
    assert.deepEqual(ADAPTER.accepts(kiloConfig(baseUrl)), { usageUrl: KILO_USAGE_URL }, baseUrl);
  }
  assert.equal(KILO_USAGE_URL.startsWith('https://app.kilo.ai/api/trpc/'), true);
});

test('accepts fails closed on proxies, credentials and foreign hosts', () => {
  for (const baseUrl of [
    'https://api.kilo.ai.evil/api/gateway',
    'https://proxy.example/api/gateway',
    'http://api.kilo.ai/api/gateway',
    'https://api.kilo.ai:8443/api/gateway',
    'https://user:pass@api.kilo.ai/api/gateway',
    'https://api.kilo.ai/api/gateway?x=1',
    'https://api.kilo.ai/api/gateway#fragment',
    'https://api.kilo.ai/api/v1',
    'https://ai-gateway.kilo.ai/api/openrouter',
    'https://app.kilo.ai/api/trpc',
    'https://api.deepseek.com/v1',
    'https://opencode.ai/zen/v1',
    'https://open.bigmodel.cn/api/paas/v4',
    'https://api.z.ai/api/paas/v4',
  ]) {
    assert.equal(ADAPTER.accepts(kiloConfig(baseUrl)), null, baseUrl);
  }
  assert.equal(ADAPTER.accepts(null), null);
  assert.equal(ADAPTER.accepts({}), null);
  assert.equal(ADAPTER.accepts({ baseUrl: null }), null);
});

test('requestKiloUsage calls the pinned tRPC batch with the key only', async () => {
  const calls = [];
  const result = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    now: NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(BATCH_RESPONSE)();
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, KILO_USAGE_URL);
  assert.equal(
    calls[0].url,
    'https://app.kilo.ai/api/trpc/user.getCreditBlocks,kiloPass.getState,user.getAutoTopUpPaymentMethod'
      + '?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%2C%221%22%3A%7B%22json%22%3Anull%7D%2C%222%22%3A%7B%22json%22%3Anull%7D%7D',
  );
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ['Accept', 'Authorization']);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.deepEqual(result.parsed, {
    kind: 'balance',
    label: 'Kilo',
    available: true,
    balances: [{ currency: 'USD', total: 19, granted: null, toppedUp: null }],
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
});

test('requestKiloUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    null,
    {},
    { usageUrl: 'https://proxy.example/api/trpc/user.getCreditBlocks' },
    { usageUrl: `https://app.kilo.ai.evil${KILO_USAGE_URL.slice('https://app.kilo.ai'.length)}` },
    { usageUrl: 'https://app.kilo.ai/api/trpc/user.getCreditBlocks' },
    { usageUrl: `${KILO_USAGE_URL}&extra=1` },
  ]) {
    const result = await requestKiloUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, String(endpoints && endpoints.usageUrl));
  }
  const missingKey = await requestKiloUsage({ apiKey: '', endpoints: ENDPOINTS, fetchImpl });
  assert.equal(missingKey.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(missingKey.category, REQUEST_CATEGORY.INVALID_FORMAT);
  assert.equal(called, false);
});

test('requestKiloUsage maps HTTP failures to the four result states', async () => {
  const cases = [
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.RATE_LIMITED],
    [500, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [503, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [404, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [400, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expected, category] of cases) {
    const result = await requestKiloUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: statusResponse(status),
    });
    assert.equal(result.status, expected, `HTTP ${status}`);
    assert.equal(result.category, category, `HTTP ${status}`);
  }
  const limited = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    now: NOW,
    fetchImpl: statusResponse(429, '60'),
  });
  assert.equal(limited.retryAfterSeen, true);
  assert.equal(limited.retryAfterMs, 60_000);
  const offline = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);
});

test('requestKiloUsage classifies tRPC errors per required slot', async () => {
  const unauthorized = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse([
      { error: { json: { data: { code: 'UNAUTHORIZED' }, message: 'Invalid API key' } } },
      { result: { data: SUBSCRIPTION } },
      { result: { data: AUTO_TOP_UP } },
    ]),
  });
  assert.equal(unauthorized.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);
  assert.equal(unauthorized.category, REQUEST_CATEGORY.AUTH);

  // The code is also read from error.data.code and error.code.
  const forbidden = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse([{ error: { data: { code: 'FORBIDDEN' } } }]),
  });
  assert.equal(forbidden.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);
  const bareCode = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse([{ error: { code: 'UNAUTHORIZED', message: 'token expired' } }]),
  });
  assert.equal(bareCode.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);

  // Slot 1 is required too: its error fails the whole response.
  const slotOne = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse([
      { result: { data: CREDIT_BLOCKS } },
      { error: { json: { data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'boom' } } },
      { result: { data: AUTO_TOP_UP } },
    ]),
  });
  assert.equal(slotOne.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(slotOne.category, REQUEST_CATEGORY.INVALID_FORMAT);

  // Slot 2 is optional: its error is ignored even when a balance is present.
  const slotTwo = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse([
      { result: { data: CREDIT_BLOCKS } },
      { result: { data: SUBSCRIPTION } },
      { error: { json: { data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'boom' } } },
    ]),
  });
  assert.equal(slotTwo.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.equal(slotTwo.parsed.kind, 'balance');
  // A renamed procedure (NOT_FOUND) and unknown codes collapse onto INVALID.
  const renamed = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse([
      { error: { json: { data: { code: 'NOT_FOUND' }, message: 'No procedure found on path' } } },
    ]),
  });
  assert.equal(renamed.status, PROVIDER_USAGE_RESULT.INVALID);
});

test('requestKiloUsage accepts every batch envelope shape', async () => {
  const shapes = [
    // Sparse numeric-key object: the omitted slot 1 is not an error.
    { 0: { result: { data: CREDIT_BLOCKS } }, 2: { result: { data: AUTO_TOP_UP } } },
    // Single, non-batch envelope for the credit procedure.
    { result: { data: CREDIT_BLOCKS } },
    // superjson transformer: business fields under result.data.json.
    { result: { data: { json: CREDIT_BLOCKS, meta: { values: {} } } } },
    // Sparse object that also omits slot 2.
    { 0: { result: { data: CREDIT_BLOCKS } } },
  ];
  for (const body of shapes) {
    const result = await requestKiloUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: jsonResponse(body),
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(result.parsed.balances, [{ currency: 'USD', total: 19, granted: null, toppedUp: null }]);
  }
});

test('requestKiloUsage rejects unusable 200 bodies as invalid', async () => {
  for (const body of [[], {}, { result: { data: null } }, { result: { data: {} } }, { 0: {} }]) {
    const result = await requestKiloUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: jsonResponse(body),
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(body));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
    assert.equal(Object.hasOwn(result, 'parsed'), false);
  }
  const nullBody = await requestKiloUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse(null),
  });
  assert.equal(nullBody.status, PROVIDER_USAGE_RESULT.INVALID);
});
