import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import {
  PROVIDER_USAGE_RESULT,
  normalizeUsage,
} from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  OPENROUTER_KEY_URL,
  OPENROUTER_PROVIDER,
  parseOpenRouterKey,
  requestOpenRouterUsage,
} from '../src/provider-usage/openrouter.mjs';

const API_KEY = 'test-key';
const ENDPOINTS = Object.freeze({ usageUrl: OPENROUTER_KEY_URL, balanceUrl: null });

// Fixtures from the CodexBar OpenRouter provider tests.
const MONTHLY_CAP_RESPONSE = {
  data: { limit: 30, limit_remaining: 30, limit_reset: 'monthly', usage: 0, usage_monthly: 0 },
};
const NO_CAP_RESPONSE = {
  data: { limit: null, usage_daily: 1.25, usage_weekly: 7.5, usage_monthly: 18.75 },
};
const SIMPLE_CAP_RESPONSE = { data: { limit: 20, usage: 5, is_management_key: false } };

// The fuller payload from OpenRouter's /key reference, with one member budget.
const DOCUMENTED_RESPONSE = {
  data: {
    label: 'sk-or-v1-au7...890',
    limit: 100,
    limit_remaining: 74.5,
    limit_reset: 'monthly',
    usage: 25.5,
    usage_daily: 25.5,
    usage_weekly: 25.5,
    usage_monthly: 25.5,
    include_byok_in_limit: false,
    is_free_tier: false,
    is_management_key: false,
    is_provisioning_key: false,
    byok_usage: 17.38,
    free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 },
    budgets: [{
      scope: 'member',
      limit_usd: 50,
      spend_usd: 40,
      remaining_usd: 10,
      reset_interval: 'weekly',
      resets_at: '2026-10-12T00:00:00.000Z',
      include_byok: false,
    }],
    effective_budget: {
      scope: 'member',
      limit_usd: 50,
      spend_usd: 40,
      remaining_usd: 10,
      reset_interval: 'weekly',
      resets_at: '2026-10-12T00:00:00.000Z',
      include_byok: false,
    },
    expires_at: '2027-12-31T23:59:59Z',
  },
};

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('ADAPTER declares the OpenRouter identity and a distinct official host', () => {
  assert.ok(Object.isFrozen(ADAPTER));
  assert.equal(ADAPTER.id, 'openrouter');
  assert.equal(OPENROUTER_PROVIDER, 'openrouter');
  assert.deepEqual(ADAPTER.hosts, ['openrouter.ai']);
  assert.equal(ADAPTER.metric, 'usage windows');
  assert.equal(typeof ADAPTER.accepts, 'function');
  assert.equal(typeof ADAPTER.request, 'function');
});

test('accepts pins the official inference base and returns the key endpoint', () => {
  for (const baseUrl of [
    'https://openrouter.ai/api/v1',
    'https://openrouter.ai/api/v1/',
    'https://openrouter.ai:443/api/v1',
  ]) {
    assert.deepEqual(ADAPTER.accepts({ baseUrl }), ENDPOINTS, baseUrl);
  }
});

test('accepts fails closed on proxies, ports, userinfo and foreign paths', () => {
  for (const baseUrl of [
    null,
    undefined,
    '',
    'http://openrouter.ai/api/v1',
    'https://openrouter.ai:8443/api/v1',
    'https://user:pass@openrouter.ai/api/v1',
    'https://openrouter.ai.evil/api/v1',
    'https://api.openrouter.ai/api/v1',
    'https://proxy.example/api/v1',
    'https://openrouter.ai/api/v1?debug=1',
    'https://openrouter.ai/api/v1#fragment',
    'https://openrouter.ai/',
    'https://openrouter.ai/api/v1/chat/completions',
    'https://openrouter.ai/api/v2',
  ]) {
    assert.equal(ADAPTER.accepts({ baseUrl }), null, String(baseUrl));
  }
});

test('parseOpenRouterKey maps the monthly key cap as a used ratio without a reset instant', () => {
  assert.deepEqual(parseOpenRouterKey(MONTHLY_CAP_RESPONSE), {
    kind: 'windows',
    label: 'OpenRouter',
    windows: [{ label: 'mo', usedRatio: 0, resetAt: null }],
  });
});

test('parseOpenRouterKey derives the used amount from usage when remaining is absent', () => {
  assert.deepEqual(parseOpenRouterKey(SIMPLE_CAP_RESPONSE), {
    kind: 'windows',
    label: 'OpenRouter',
    windows: [{ label: 'life', usedRatio: 0.25, resetAt: null }],
  });
  const clamped = parseOpenRouterKey({ data: { limit: 10, usage: 25, limit_reset: 'daily' } });
  assert.equal(clamped.windows[0].usedRatio, 1);
  const negativeRemaining = parseOpenRouterKey({
    data: { limit: 10, limit_remaining: -5, limit_reset: 'weekly' },
  });
  assert.equal(negativeRemaining.windows[0].usedRatio, 1);
  const overRemaining = parseOpenRouterKey({
    data: { limit: 10, limit_remaining: 25, limit_reset: 'weekly' },
  });
  assert.equal(overRemaining.windows[0].usedRatio, 0);
});

test('parseOpenRouterKey prefers the effective budget and its real reset time', () => {
  assert.deepEqual(parseOpenRouterKey(DOCUMENTED_RESPONSE), {
    kind: 'windows',
    label: 'OpenRouter',
    windows: [{ label: '7d', usedRatio: 0.8, resetAt: '2026-10-12T00:00:00.000Z' }],
  });
});

test('parseOpenRouterKey collects every budget entry when no effective budget exists', () => {
  const parsed = parseOpenRouterKey({
    data: {
      limit: null,
      budgets: [
        { scope: 'key', limit_usd: 10, spend_usd: 5, reset_interval: 'daily' },
        { scope: 'member', limit_usd: 100, remaining_usd: 25, reset_interval: 'monthly' },
        { scope: 'org', limit_usd: 1000, spend_usd: 10, reset_interval: 'monthly' },
        { scope: 'legacy', limit_usd: 20, spend_usd: 2, reset_interval: null },
      ],
    },
  });
  assert.deepEqual(parsed.windows, [
    { label: '1d', usedRatio: 0.5, resetAt: null },
    { label: 'mo', usedRatio: 0.75, resetAt: null },
    { label: 'life', usedRatio: 0.1, resetAt: null },
  ]);
});

test('parseOpenRouterKey skips unusable budgets and falls back to the key cap', () => {
  const parsed = parseOpenRouterKey({
    data: {
      limit: 40,
      limit_remaining: 10,
      limit_reset: 'monthly',
      budgets: [
        { limit_usd: 0, spend_usd: 1, reset_interval: 'daily' },
        { limit_usd: 10, spend_usd: 1, reset_interval: 'hourly' },
        { limit_usd: 'nope', spend_usd: 1, reset_interval: 'weekly' },
        { limit_usd: 10, spend_usd: '2', reset_interval: 'weekly' },
      ],
    },
  });
  assert.deepEqual(parsed.windows, [{ label: '7d', usedRatio: 0.2, resetAt: null }]);
  const fallback = parseOpenRouterKey({
    data: {
      limit: 40,
      limit_remaining: 10,
      limit_reset: 'monthly',
      budgets: [{ limit_usd: 0, spend_usd: 1, reset_interval: 'daily' }],
    },
  });
  assert.deepEqual(fallback.windows, [{ label: 'mo', usedRatio: 0.75, resetAt: null }]);
  // An unknown interval that leaves nothing usable never invents a window.
  assert.equal(parseOpenRouterKey({
    data: { limit: 10, usage: 1, limit_reset: 'fortnightly' },
  }), null);
});

test('parseOpenRouterKey ignores unparsable reset stamps and free-model traffic', () => {
  const parsed = parseOpenRouterKey({
    data: {
      budgets: [{
        limit_usd: 10,
        spend_usd: 1,
        reset_interval: 'monthly',
        resets_at: 'not-a-date',
      }],
      free_model_daily_requests: { used: 500, limit: 1000, remaining: 500 },
    },
  });
  assert.deepEqual(parsed.windows, [{ label: 'mo', usedRatio: 0.1, resetAt: null }]);
});

test('parseOpenRouterKey hides a key with no cap instead of reporting 0%', () => {
  assert.equal(parseOpenRouterKey(NO_CAP_RESPONSE), null);
  assert.equal(parseOpenRouterKey({ data: { limit: 30, limit_remaining: 30, limit_reset: null } }).windows[0].label, 'life');
  assert.equal(parseOpenRouterKey({ data: { budgets: [] } }), null);
});

test('parseOpenRouterKey rejects malformed envelopes and never throws', () => {
  for (const body of [
    null,
    undefined,
    'text',
    42,
    [],
    {},
    { data: null },
    { data: [] },
    { data: 'x' },
    { error: { message: 'Management key required' } },
  ]) {
    assert.equal(parseOpenRouterKey(body), null, JSON.stringify(body));
  }
});

test('parsed windows pass the shared normalizer unchanged', () => {
  for (const body of [MONTHLY_CAP_RESPONSE, SIMPLE_CAP_RESPONSE, DOCUMENTED_RESPONSE]) {
    const parsed = parseOpenRouterKey(body);
    assert.deepEqual(normalizeUsage(parsed), parsed);
    assert.doesNotMatch(JSON.stringify(parsed), /sk-or-v1|890/);
  }
});

test('requestOpenRouterUsage fetches the pinned key URL with the provider key', async () => {
  const calls = [];
  const result = await requestOpenRouterUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => DOCUMENTED_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed.windows, [
    { label: '7d', usedRatio: 0.8, resetAt: '2026-10-12T00:00:00.000Z' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OPENROUTER_KEY_URL);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.deepEqual(calls[0].options.headers, {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
  });
});

test('requestOpenRouterUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    { usageUrl: 'https://proxy.example/api/v1/key', balanceUrl: null },
    { usageUrl: 'http://openrouter.ai/api/v1/key', balanceUrl: null },
    { usageUrl: 'https://openrouter.ai.evil/api/v1/key', balanceUrl: null },
    { usageUrl: 'https://openrouter.ai/api/v1/credits', balanceUrl: null },
    { usageUrl: 'https://openrouter.ai/api/v1/key?x=1', balanceUrl: null },
    { usageUrl: 'https://openrouter.ai/api/v1/key#fragment', balanceUrl: null },
    { usageUrl: 'https://user:pass@openrouter.ai/api/v1/key', balanceUrl: null },
  ]) {
    const result = await requestOpenRouterUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, endpoints.usageUrl);
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  const missingKey = await requestOpenRouterUsage({ apiKey: '', endpoints: ENDPOINTS, fetchImpl });
  assert.equal(missingKey.status, PROVIDER_USAGE_RESULT.INVALID);
  const nonStringKey = await requestOpenRouterUsage({ apiKey: 42, endpoints: ENDPOINTS, fetchImpl });
  assert.equal(nonStringKey.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(called, false);
});

test('requestOpenRouterUsage defaults to the pinned URL and hides a cap-less key', async () => {
  const urls = [];
  const result = await requestOpenRouterUsage({
    apiKey: API_KEY,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => NO_CAP_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  assert.deepEqual(urls, [OPENROUTER_KEY_URL]);
});

test('requestOpenRouterUsage dispatches HTTP failures into the four states', async () => {
  const cases = [
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.RATE_LIMITED],
    [500, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [503, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [402, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [404, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expected, category] of cases) {
    const result = await requestOpenRouterUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal(result.status, expected, `HTTP ${status}`);
    assert.equal(result.category, category, `HTTP ${status}`);
  }
});

test('requestOpenRouterUsage keeps Retry-After on rate limits and network errors transient', async () => {
  const limited = await requestOpenRouterUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? '5' : null) },
    }),
  });
  assert.equal(limited.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(limited.retryAfterSeen, true);
  assert.equal(limited.retryAfterMs, 5000);

  const offline = await requestOpenRouterUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);
});

test('requestOpenRouterUsage classifies a 200 error envelope without trusting its code', async () => {
  const management = await requestOpenRouterUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse({ error: { message: 'Management key required' } }),
  });
  assert.equal(management.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(management.category, REQUEST_CATEGORY.INVALID_FORMAT);

  const unauthorized = await requestOpenRouterUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse({ error: { code: 401, message: 'invalid_api_key' } }),
  });
  assert.equal(unauthorized.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);
  assert.equal(unauthorized.category, REQUEST_CATEGORY.AUTH);

  const forbidden = await requestOpenRouterUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: jsonResponse({ error: { code: 403, message: 'Management key required' } }),
  });
  assert.equal(forbidden.status, PROVIDER_USAGE_RESULT.UNAUTHORIZED);

  const malformed = await requestOpenRouterUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => 'not-an-object' }),
  });
  assert.equal(malformed.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(malformed.category, REQUEST_CATEGORY.INVALID_FORMAT);
});
