import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { normalizeUsage } from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  CHUTES_REQUEST_TIMEOUT_MS,
  CHUTES_SUBSCRIPTION_USAGE_URL,
  parseChutesSubscriptionUsage,
  requestChutesUsage,
} from '../src/provider-usage/chutes.mjs';

const API_KEY = 'test-key';
const ENDPOINTS = Object.freeze({ usageUrl: CHUTES_SUBSCRIPTION_USAGE_URL });
const WINDOW_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9.]{0,15}$/;

// The field shape third-party clients observe on the live service; the
// numbers match the Plus/Pro listing ($100 monthly cap, $8.3333 4h cap,
// 5,000 daily requests).
const NESTED_USAGE = {
  billing_cycle_cap: {
    used: 55.339, limit: 100, remaining: 44.661, label: 'Billing Cycle Cap',
  },
  four_hour_window: {
    used: 0, limit: 8.3333, remaining: 8.3333, label: '4-Hour Window',
  },
  daily_quota_usage: {
    used: 0, limit: 5000, remaining: 5000, label: 'Quota Usage',
  },
  plan: {
    name: 'Pro',
    monthly_cap_usd: 100,
    four_hour_cap_usd: 8.3333,
    daily_request_limit: 5000,
    payg_discount_percent: 10,
  },
};

function jsonResponse(body, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/** A response whose body is raw text, served as a byte stream like a real one. */
function textResponse(text, { status = 200 } = {}) {
  const bytes = new TextEncoder().encode(text);
  let read = false;
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () => {
          if (read) return { done: true };
          read = true;
          return { done: false, value: bytes };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  });
}

function headersResponse(status, headers) {
  return async () => ({
    ok: false,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  });
}

test('parseChutesSubscriptionUsage maps the nested four-hour, daily and billing-cycle windows', () => {
  const parsed = parseChutesSubscriptionUsage(NESTED_USAGE);
  assert.deepEqual(parsed, {
    kind: 'windows',
    label: 'Chutes Pro',
    windows: [
      { label: '4h', usedRatio: 0, resetAt: null },
      { label: '1d', usedRatio: 0, resetAt: null },
      { label: 'mo', usedRatio: 55.339 / 100, resetAt: null },
    ],
  });
  for (const window of parsed.windows) assert.match(window.label, WINDOW_LABEL_RE);
});

test('parseChutesSubscriptionUsage reads the flat field variant and plan_name', () => {
  const parsed = parseChutesSubscriptionUsage({
    billing_cycle_used: 25,
    billing_cycle_limit: 100,
    billing_cycle_remaining: 75,
    four_hour_used: 2,
    four_hour_limit: 8,
    four_hour_remaining: 6,
    daily_used: 500,
    daily_limit: 5000,
    daily_remaining: 4500,
    plan_name: 'Plus',
  });
  assert.deepEqual(parsed, {
    kind: 'windows',
    label: 'Chutes Plus',
    windows: [
      { label: '4h', usedRatio: 0.25, resetAt: null },
      { label: '1d', usedRatio: 0.1, resetAt: null },
      { label: 'mo', usedRatio: 0.25, resetAt: null },
    ],
  });
  // The nested object wins over flat fields describing the same window.
  const both = parseChutesSubscriptionUsage({
    billing_cycle_cap: { used: 10, limit: 100 },
    billing_cycle_used: 90,
    billing_cycle_limit: 100,
  });
  assert.equal(both.windows[0].usedRatio, 0.1);
});

test('parseChutesSubscriptionUsage derives the used share from remaining when used is absent', () => {
  const parsed = parseChutesSubscriptionUsage({
    four_hour_window: { limit: 10, remaining: 2.5 },
    daily_quota_usage: { used: 1, limit: 10, remaining: 1 },
    billing_cycle_cap: { limit: 100, remaining: 100 },
  });
  assert.deepEqual(parsed.windows.map((window) => window.usedRatio), [0.75, 0.1, 0]);
});

test('parseChutesSubscriptionUsage clamps over-limit usage and drops empty 0/0 quotas', () => {
  const over = parseChutesSubscriptionUsage({
    four_hour_window: { used: 20, limit: 8 },
  });
  assert.equal(over.windows[0].usedRatio, 1);
  // A brand-new account reports real 0/0 quotas: no window, not a 0% reading.
  for (const payload of [
    {
      four_hour_window: { used: 0, limit: 0 },
      daily_quota_usage: { used: 0, limit: 0 },
      billing_cycle_cap: { used: 0, limit: 0 },
    },
    {
      four_hour_window: { used: 0 },
      daily_quota_usage: { limit: -1, used: 0 },
      billing_cycle_cap: { limit: 'n/a', used: 1 },
    },
  ]) {
    assert.equal(parseChutesSubscriptionUsage(payload), null);
  }
  // Unusable windows are skipped while the clean ones survive.
  const partial = parseChutesSubscriptionUsage({
    four_hour_window: { used: 1, limit: 0 },
    daily_quota_usage: { used: -5, limit: 100 },
    billing_cycle_cap: { used: 40, limit: 100 },
  });
  assert.deepEqual(partial.windows, [{ label: 'mo', usedRatio: 0.4, resetAt: null }]);
});

test('parseChutesSubscriptionUsage refuses payloads with no clean window instead of guessing', () => {
  for (const payload of [
    null,
    undefined,
    'usage',
    [],
    {},
    { subscription: { active: false, status: 'free' } },
    { monthly: { used: 250, limit: 1000, unit: 'credits' } },
    { rolling_window: { requests: 40, limit: 100, window_minutes: 240 } },
    { four_hour_window: { limit: 'not-a-number', used: 1 } },
    { four_hour_window: 'full' },
  ]) {
    assert.equal(parseChutesSubscriptionUsage(payload), null);
  }
});

test('parseChutesSubscriptionUsage normalizes ISO text and epoch reset stamps', () => {
  const parsed = parseChutesSubscriptionUsage({
    four_hour_window: { used: 1, limit: 8, reset_at: '2026-06-13T18:00:00Z' },
    daily_quota_usage: { used: 1, limit: 100, resets_at: 1782000000 },
    billing_cycle_cap: { used: 1, limit: 100, reset_at: 1782000000000, reset_label: 'July 1' },
  });
  assert.deepEqual(parsed.windows.map((window) => window.resetAt), [
    '2026-06-13T18:00:00.000Z',
    '2026-06-21T00:00:00.000Z',
    '2026-06-21T00:00:00.000Z',
  ]);
  const unusable = parseChutesSubscriptionUsage({
    four_hour_window: { used: 1, limit: 8, reset_at: 'not-a-date' },
    daily_quota_usage: { used: 1, limit: 100, resets_at: 0 },
    billing_cycle_cap: { used: 1, limit: 100, reset_at: 2026, reset_label: 'soon' },
  });
  assert.deepEqual(unusable.windows.map((window) => window.resetAt), [null, null, null]);
  // A numeric string is still a timestamp; a reset_label alone never is.
  const numericText = parseChutesSubscriptionUsage({
    four_hour_window: { used: 1, limit: 8, reset_at: '1782000000' },
    daily_quota_usage: { used: 1, limit: 100, reset_label: '2h' },
  });
  assert.equal(numericText.windows[0].resetAt, '2026-06-21T00:00:00.000Z');
  assert.equal(numericText.windows[1].resetAt, null);
});

test('parseChutesSubscriptionUsage sanitizes the plan name into the display label', () => {
  const labelFor = (payload) => parseChutesSubscriptionUsage({
    four_hour_window: { used: 1, limit: 8 },
    ...payload,
  }).label;
  assert.equal(labelFor({ plan: { name: 'Pro Max' } }), 'Chutes Pro Max');
  assert.equal(labelFor({ plan: { name: 'Pro' }, plan_name: 'Plus' }), 'Chutes Pro');
  assert.equal(labelFor({ plan: 'Pro', plan_name: 'Plus' }), 'Chutes Plus');
  assert.equal(labelFor({ plan: { name: 'GLM │ forged' } }), 'Chutes');
  assert.equal(labelFor({ plan: { name: '专业版' } }), 'Chutes');
  assert.equal(labelFor({ plan: { name: '' } }), 'Chutes');
  assert.equal(labelFor({}), 'Chutes');
  const longName = 'A'.repeat(25);
  assert.equal(labelFor({ plan: { name: longName } }), `Chutes ${longName}`);
  assert.equal(labelFor({ plan: { name: 'A'.repeat(26) } }), 'Chutes');
});

test('parseChutesSubscriptionUsage output always passes the shared normalizer', () => {
  for (const payload of [
    NESTED_USAGE,
    {
      four_hour_used: 4,
      four_hour_limit: 8,
      four_hour_resets_at: '2026-06-13T18:00:00Z',
      daily_used: 1,
      daily_limit: 10,
      billing_cycle_used: 1,
      billing_cycle_limit: 10,
      plan_name: 'Pro',
    },
  ]) {
    const parsed = parseChutesSubscriptionUsage(payload);
    assert.deepEqual(normalizeUsage(parsed), parsed);
    for (const window of parsed.windows) {
      assert.ok(window.usedRatio >= 0 && window.usedRatio <= 1);
    }
  }
});

test('accepts pins the official Chutes hosts and fails closed elsewhere', () => {
  for (const baseUrl of [
    'https://llm.chutes.ai',
    'https://llm.chutes.ai/v1',
    'https://LLM.CHUTES.AI/v1',
    'https://llm.chutes.ai:443/v1',
    'https://api.chutes.ai',
    'https://api.chutes.ai/v1',
    'https://alice-my-chute.chutes.ai/v1',
  ]) {
    assert.deepEqual(ADAPTER.accepts({ baseUrl }), ENDPOINTS, baseUrl);
  }
  for (const baseUrl of [
    'https://chutes.ai/v1',
    'https://llm.chutes.ai.evil/v1',
    'https://chutes.ai.evil/v1',
    'https://evil-chutes.ai/v1',
    'https://alice.chutes.ai.evil/v1',
    'https://a.b.chutes.ai/v1',
    'https://proxy.example/v1',
    'http://llm.chutes.ai/v1',
    'https://llm.chutes.ai:8443/v1',
    'https://user:pass@llm.chutes.ai/v1',
    'not a url',
    '',
  ]) {
    assert.equal(ADAPTER.accepts({ baseUrl }), null, baseUrl);
  }
  assert.equal(ADAPTER.accepts({}), null);
  assert.equal(ADAPTER.accepts({ baseUrl: null }), null);
  assert.equal(ADAPTER.accepts(null), null);
});

test('ADAPTER advertises the chutes registry identity without host overlap', () => {
  assert.ok(Object.isFrozen(ADAPTER));
  assert.equal(ADAPTER.id, 'chutes');
  assert.equal(ADAPTER.metric, 'usage windows');
  assert.deepEqual(ADAPTER.hosts, ['llm.chutes.ai', 'api.chutes.ai']);
  assert.ok(Object.isFrozen(ADAPTER.hosts));
  assert.equal(typeof ADAPTER.accepts, 'function');
  assert.equal(typeof ADAPTER.request, 'function');
  for (const taken of ['api.deepseek.com', 'opencode.ai', 'open.bigmodel.cn', 'api.z.ai']) {
    assert.equal(ADAPTER.hosts.includes(taken), false, taken);
  }
  assert.equal(CHUTES_REQUEST_TIMEOUT_MS, 15_000);
  assert.equal(CHUTES_SUBSCRIPTION_USAGE_URL, 'https://api.chutes.ai/users/me/subscription_usage');
});

test('requestChutesUsage sends the dashboard key to the pinned endpoint', async () => {
  const calls = [];
  const result = await requestChutesUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => NESTED_USAGE };
    },
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.parsed, parseChutesSubscriptionUsage(NESTED_USAGE));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CHUTES_SUBSCRIPTION_USAGE_URL);
  assert.deepEqual(calls[0].options.headers, {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
  });
  assert.ok(calls[0].options.signal);
});

test('requestChutesUsage refuses non-official endpoints and a missing key before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    null,
    {},
    { usageUrl: 'https://proxy.example/users/me/subscription_usage' },
    { usageUrl: 'https://api.chutes.ai/users/me' },
    { usageUrl: 'https://api.chutes.ai/users/me/subscription_usage?all=1' },
    { usageUrl: 'https://api.chutes.ai/users/me/subscription_usage#frag' },
    { usageUrl: 'https://llm.chutes.ai/users/me/subscription_usage' },
    { usageUrl: 'https://api.chutes.ai:8443/users/me/subscription_usage' },
    { usageUrl: 'http://api.chutes.ai/users/me/subscription_usage' },
    { usageUrl: 'https://user:pass@api.chutes.ai/users/me/subscription_usage' },
  ]) {
    const result = await requestChutesUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, 'invalid', JSON.stringify(endpoints));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  const missingKey = await requestChutesUsage({ apiKey: '', endpoints: ENDPOINTS, fetchImpl });
  assert.equal(missingKey.status, 'invalid');
  assert.equal(missingKey.category, REQUEST_CATEGORY.INVALID_FORMAT);
  const noKey = await requestChutesUsage({ endpoints: ENDPOINTS, fetchImpl });
  assert.equal(noKey.status, 'invalid');
  assert.equal(called, false);
});

test('requestChutesUsage dispatches HTTP failures into the four result states', async () => {
  const cases = [
    [401, 'unauthorized', REQUEST_CATEGORY.AUTH],
    [403, 'unauthorized', REQUEST_CATEGORY.AUTH],
    [429, 'transient', REQUEST_CATEGORY.RATE_LIMITED],
    [500, 'transient', REQUEST_CATEGORY.SERVER],
    [503, 'transient', REQUEST_CATEGORY.SERVER],
    [402, 'invalid', REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [404, 'invalid', REQUEST_CATEGORY.UNEXPECTED_STATUS],
    [422, 'invalid', REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expected, category] of cases) {
    const urls = [];
    const result = await requestChutesUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: false, status };
      },
    });
    assert.equal(result.status, expected, `HTTP ${status}`);
    assert.equal(result.category, category, `HTTP ${status}`);
    // One request per refresh: no retry is attempted inside the adapter.
    assert.deepEqual(urls, [CHUTES_SUBSCRIPTION_USAGE_URL]);
  }

  const rateLimited = await requestChutesUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: headersResponse(429, { 'retry-after': '60' }),
  });
  assert.equal(rateLimited.status, 'transient');
  assert.equal(rateLimited.retryAfterSeen, true);
  assert.equal(rateLimited.retryAfterMs, 60_000);

  const noHeader = await requestChutesUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: headersResponse(429, {}),
  });
  assert.equal(noHeader.retryAfterSeen, false);
  assert.equal(noHeader.retryAfterMs, null);

  const offline = await requestChutesUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, 'transient');
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);

  const slow = await requestChutesUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(slow.status, 'transient');
  assert.equal(slow.category, REQUEST_CATEGORY.TIMEOUT);
});

test('requestChutesUsage reports invalid when the body carries no clean window', async () => {
  const cases = [
    jsonResponse({ subscription: { active: false, status: 'free' } }),
    jsonResponse(null),
    jsonResponse({ billing_cycle_cap: { used: 1, limit: 0 } }),
    textResponse('oops'),
  ];
  for (const fetchImpl of cases) {
    const urls = [];
    const result = await requestChutesUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async (url, options) => {
        urls.push(url);
        return fetchImpl(url, options);
      },
    });
    assert.equal(result.status, 'invalid');
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
    // No balance fallback: exactly one call to the subscription endpoint.
    assert.deepEqual(urls, [CHUTES_SUBSCRIPTION_USAGE_URL]);
  }
});
