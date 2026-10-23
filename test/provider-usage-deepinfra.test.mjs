import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { PROVIDER_USAGE_RESULT } from '../src/provider-usage/common.mjs';
import { ADAPTER as DEEPSEEK_ADAPTER } from '../src/provider-usage/deepseek.mjs';
import { ADAPTER as OPENCODE_GO_ADAPTER } from '../src/provider-usage/opencode-go.mjs';
import { ADAPTER as ZHIPU_ADAPTER } from '../src/provider-usage/zhipu.mjs';
import {
  ADAPTER,
  DEEPINFRA_CHECKLIST_URL,
  DEEPINFRA_PROVIDER,
  parseDeepInfraChecklist,
  requestDeepInfraUsage,
} from '../src/provider-usage/deepinfra.mjs';

const API_KEY = 'test-key';
const ENDPOINTS = Object.freeze({ checklistUrl: DEEPINFRA_CHECKLIST_URL });

// Verbatim from DeepInfra's documented Checklist schema / the reference
// client's fixture: a negative stripe_balance is prepaid credit and `recent`
// is usage billed since the last invoice.
const CHECKLIST_RESPONSE = {
  stripe_balance: -99.75,
  recent: 3.94,
  limit: 20,
  suspend_reason: null,
  suspended: false,
  overdue_invoices: 0,
  topup: false,
  topup_amount: 0,
  topup_threshold: 0,
  topup_failed: false,
  billing_type: null,
  scoped_credits: [{
    name: 'example',
    granted_cents: 123,
    remaining_cents: 45,
    granted_ts: 1730000000,
    expires_ts: null,
    expired: false,
  }],
};

const EXPECTED_BALANCE = {
  kind: 'balance',
  label: 'DeepInfra',
  available: true,
  balances: [{ currency: 'USD', total: 95.81, granted: null, toppedUp: null }],
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('ADAPTER publishes the deepinfra identity and claims only its own official host', () => {
  assert.equal(ADAPTER.id, DEEPINFRA_PROVIDER);
  assert.equal(ADAPTER.id, 'deepinfra');
  assert.equal(ADAPTER.metric, 'balance');
  assert.deepEqual(ADAPTER.hosts, ['api.deepinfra.com']);
  assert.equal(Object.isFrozen(ADAPTER), true);
  const claimed = new Set(ADAPTER.hosts);
  for (const other of [DEEPSEEK_ADAPTER, OPENCODE_GO_ADAPTER, ZHIPU_ADAPTER]) {
    for (const host of other.hosts) {
      assert.equal(claimed.has(host), false, `${host} is already served by ${other.id}`);
    }
  }
});

test('accepts opens only documented DeepInfra inference bases', () => {
  for (const baseUrl of [
    'https://api.deepinfra.com',
    'https://api.deepinfra.com/',
    'https://api.deepinfra.com/v1',
    'https://api.deepinfra.com/v1/openai',
    'https://api.deepinfra.com/v1/openai/',
    'https://api.deepinfra.com/v1/inference',
    'https://api.deepinfra.com:443/v1/openai',
  ]) {
    assert.deepEqual(ADAPTER.accepts({ baseUrl }), { checklistUrl: DEEPINFRA_CHECKLIST_URL }, baseUrl);
  }
  for (const baseUrl of [
    null,
    '',
    'https://api.deepinfra.com.evil/v1/openai',
    'https://proxy.example/v1/openai',
    'http://api.deepinfra.com/v1/openai',
    'https://api.deepinfra.com:8443/v1/openai',
    'https://user:pass@api.deepinfra.com/v1/openai',
    'https://api.deepinfra.com/v1/openai?x=1',
    'https://api.deepinfra.com/v1/openai#x',
    'https://api.deepinfra.com/v1/other',
    'https://api.deepinfra.com/payment/checklist',
  ]) {
    assert.equal(ADAPTER.accepts({ baseUrl }), null, String(baseUrl));
  }
});

test('parseDeepInfraChecklist folds prepaid credit and recent usage into one USD row', () => {
  assert.deepEqual(parseDeepInfraChecklist(CHECKLIST_RESPONSE), EXPECTED_BALANCE);
  // scoped_credits are per-model discounts, never an account-wide grant.
  assert.equal(parseDeepInfraChecklist(CHECKLIST_RESPONSE).balances[0].granted, null);
  assert.equal(parseDeepInfraChecklist(CHECKLIST_RESPONSE).balances[0].toppedUp, null);
  // Decimal-string amounts are coerced like the sibling balance adapters.
  assert.deepEqual(
    parseDeepInfraChecklist({ stripe_balance: '-99.75', recent: '3.94' }),
    EXPECTED_BALANCE,
  );
  // `limit` is a spending cap, not part of the balance.
  assert.deepEqual(parseDeepInfraChecklist({ stripe_balance: -99.75, recent: 3.94, limit: null }), EXPECTED_BALANCE);
});

test('parseDeepInfraChecklist marks debt and suspension as unavailable instead of negative', () => {
  assert.deepEqual(parseDeepInfraChecklist({ stripe_balance: 5.25, recent: 1 }), {
    kind: 'balance',
    label: 'DeepInfra',
    available: false,
    balances: [{ currency: 'USD', total: 0, granted: null, toppedUp: null }],
  });
  assert.deepEqual(parseDeepInfraChecklist({ ...CHECKLIST_RESPONSE, suspended: true }), {
    kind: 'balance',
    label: 'DeepInfra',
    available: false,
    balances: [{ currency: 'USD', total: 95.81, granted: null, toppedUp: null }],
  });
  assert.deepEqual(parseDeepInfraChecklist({ stripe_balance: 0, recent: 0 }), {
    kind: 'balance',
    label: 'DeepInfra',
    available: true,
    balances: [{ currency: 'USD', total: 0, granted: null, toppedUp: null }],
  });
  // Only a boolean true suspends; anything else is not a documented signal.
  assert.equal(parseDeepInfraChecklist({ stripe_balance: -10, recent: 0, suspended: 'yes' }).available, true);
});

test('parseDeepInfraChecklist fails closed on unusable payloads', () => {
  for (const payload of [
    null,
    undefined,
    [],
    {},
    { stripe_balance: -1 },
    { recent: 0 },
    { stripe_balance: null, recent: 0 },
    { stripe_balance: ' ', recent: 0 },
    { stripe_balance: 'abc', recent: 0 },
    { stripe_balance: Infinity, recent: 0 },
    { stripe_balance: Number.NaN, recent: 0 },
    { stripe_balance: true, recent: 0 },
    { stripe_balance: {}, recent: 0 },
    { stripe_balance: -1, recent: null },
  ]) {
    assert.equal(parseDeepInfraChecklist(payload), null);
  }
});

test('requestDeepInfraUsage calls the pinned checklist endpoint with the provider key', async () => {
  const calls = [];
  const result = await requestDeepInfraUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(CHECKLIST_RESPONSE);
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed, EXPECTED_BALANCE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepinfra.com/payment/checklist?compute_owed=true');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');

  // Without an explicit endpoint the adapter still uses the pinned URL.
  const fallback = [];
  await requestDeepInfraUsage({
    apiKey: API_KEY,
    fetchImpl: async (url) => {
      fallback.push(url);
      return jsonResponse(CHECKLIST_RESPONSE);
    },
  });
  assert.deepEqual(fallback, [DEEPINFRA_CHECKLIST_URL]);
});

test('requestDeepInfraUsage refuses unpinned endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const options of [
    { endpoints: null, url: 'https://proxy.example/payment/checklist?compute_owed=true' },
    { endpoints: { checklistUrl: 'https://proxy.example/payment/checklist?compute_owed=true' } },
    { endpoints: { checklistUrl: 'https://api.deepinfra.com.evil/payment/checklist?compute_owed=true' } },
    { endpoints: { checklistUrl: 'http://api.deepinfra.com/payment/checklist?compute_owed=true' } },
    { endpoints: { checklistUrl: 'https://api.deepinfra.com:8443/payment/checklist?compute_owed=true' } },
    { endpoints: { checklistUrl: 'https://api.deepinfra.com/payment/checklist' } },
    { endpoints: { checklistUrl: 'https://api.deepinfra.com/payment/checklist?compute_owed=false' } },
    { endpoints: { checklistUrl: 'https://api.deepinfra.com/payment/usage?from=current' } },
    { endpoints: { checklistUrl: `${DEEPINFRA_CHECKLIST_URL}#x` } },
  ]) {
    const result = await requestDeepInfraUsage({ apiKey: API_KEY, fetchImpl, ...options });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(options));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  const missingKey = await requestDeepInfraUsage({ apiKey: '', endpoints: ENDPOINTS, fetchImpl });
  assert.equal(missingKey.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(called, false);
});

test('requestDeepInfraUsage maps transport failures onto the shared categories', async () => {
  const cases = [
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.RATE_LIMITED],
    [500, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [503, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [404, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [408, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expectedStatus, expectedCategory] of cases) {
    const result = await requestDeepInfraUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal(result.status, expectedStatus, `HTTP ${status}`);
    assert.equal(result.category, expectedCategory, `HTTP ${status}`);
  }
  const offline = await requestDeepInfraUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);
});

test('requestDeepInfraUsage honours Retry-After and reports timeouts as transient', async () => {
  const limited = await requestDeepInfraUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? '2' : null) },
    }),
  });
  assert.equal(limited.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(limited.retryAfterSeen, true);
  assert.equal(limited.retryAfterMs, 2_000);

  const timedOut = await requestDeepInfraUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    timeoutMs: 5,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(timedOut.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(timedOut.category, REQUEST_CATEGORY.TIMEOUT);
});

test('requestDeepInfraUsage turns unusable bodies into invalid without throwing', async () => {
  for (const body of [
    {},
    { stripe_balance: -1 },
    { stripe_balance: 'abc', recent: 0 },
    [],
    null,
  ]) {
    const result = await requestDeepInfraUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: jsonResponse(body),
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(body));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  // A hostile body that throws on access is swallowed by the request guard.
  const hostile = {};
  Object.defineProperty(hostile, 'stripe_balance', {
    get() { throw new Error('boom'); },
  });
  const result = await requestDeepInfraUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => hostile }),
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
});
