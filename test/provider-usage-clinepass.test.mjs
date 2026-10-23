import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { normalizeUsage, PROVIDER_USAGE_RESULT } from '../src/provider-usage/common.mjs';
import { ADAPTER as deepSeekAdapter } from '../src/provider-usage/deepseek.mjs';
import { ADAPTER as openCodeGoAdapter } from '../src/provider-usage/opencode-go.mjs';
import { ADAPTER as zhipuAdapter } from '../src/provider-usage/zhipu.mjs';
import {
  ADAPTER,
  CLINEPASS_PROVIDER,
  CLINEPASS_USAGE_URL,
  parseClinePassUsage,
  requestClinePassUsage,
} from '../src/provider-usage/clinepass.mjs';

const API_KEY = 'test-key';
const ENDPOINTS = Object.freeze({ usageUrl: CLINEPASS_USAGE_URL });

// CodexBar's sanitized production golden fixture for the plan-limits route.
const USAGE_RESPONSE = {
  success: true,
  data: {
    limits: [
      { type: 'five_hour', percentUsed: 12.5, resetsAt: '2026-07-16T10:20:30Z' },
      { type: 'weekly', percentUsed: 34, resetsAt: '2026-07-20T00:00:00Z' },
      { type: 'monthly', percentUsed: 56.75, resetsAt: '2026-08-01T00:00:00Z' },
    ],
  },
};

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('ADAPTER exposes the clinepass identity and a host no other adapter claims', () => {
  assert.equal(CLINEPASS_PROVIDER, 'clinepass');
  assert.ok(Object.isFrozen(ADAPTER));
  assert.equal(ADAPTER.id, 'clinepass');
  assert.equal(ADAPTER.metric, 'usage windows');
  assert.deepEqual(ADAPTER.hosts, ['api.cline.bot']);
  const claimed = new Set([
    ...deepSeekAdapter.hosts,
    ...openCodeGoAdapter.hosts,
    ...zhipuAdapter.hosts,
  ]);
  for (const host of ADAPTER.hosts) {
    assert.equal(claimed.has(host), false, `${host} is already served by another adapter`);
  }
  assert.deepEqual(ADAPTER.accepts({ baseUrl: 'https://api.cline.bot/api/v1' }), {
    usageUrl: CLINEPASS_USAGE_URL,
  });
});

test('parseClinePassUsage maps the production fixture into 5h/7d/mo windows', () => {
  assert.deepEqual(parseClinePassUsage(USAGE_RESPONSE), {
    kind: 'windows',
    label: 'ClinePass',
    windows: [
      { label: '5h', usedRatio: 0.125, resetAt: '2026-07-16T10:20:30.000Z' },
      { label: '7d', usedRatio: 0.34, resetAt: '2026-07-20T00:00:00.000Z' },
      { label: 'mo', usedRatio: 0.5675, resetAt: '2026-08-01T00:00:00.000Z' },
    ],
  });
  // The parsed record is already in the shape the shared normalizer accepts,
  // so caching and re-normalization never change it.
  const parsed = parseClinePassUsage(USAGE_RESPONSE);
  assert.deepEqual(normalizeUsage(parsed), parsed);
});

test('parseClinePassUsage ignores unknown types and omits absent windows', () => {
  const withUnknown = parseClinePassUsage({
    success: true,
    data: {
      limits: [
        { type: 'experimental_pool', percentUsed: 99, resetsAt: null },
        { type: 'weekly', percentUsed: 10, resetsAt: null },
      ],
    },
  });
  assert.deepEqual(withUnknown.windows, [{ label: '7d', usedRatio: 0.1, resetAt: null }]);
  // Windows are emitted in ascending duration regardless of response order.
  const reordered = parseClinePassUsage({
    success: true,
    data: {
      limits: [
        { type: 'monthly', percentUsed: 1, resetsAt: null },
        { type: 'five_hour', percentUsed: 2, resetsAt: null },
        { type: 'weekly', percentUsed: 3, resetsAt: null },
      ],
    },
  });
  assert.deepEqual(reordered.windows.map((window) => window.label), ['5h', '7d', 'mo']);
  // No windows at all is not a usable record: a non-subscriber account must
  // degrade rather than show an invented zero.
  assert.equal(parseClinePassUsage({ success: true, data: { limits: [] } }), null);
  assert.equal(parseClinePassUsage({
    success: true,
    data: { limits: [{ type: 'experimental_pool', percentUsed: 1 }] },
  }), null);
});

test('parseClinePassUsage refuses unusable envelopes', () => {
  for (const body of [
    null,
    undefined,
    [],
    'success',
    { data: { limits: [] } },
    { success: false, data: { limits: [] } },
    { success: 'true', data: { limits: [] } },
    { success: true, data: null },
    { success: true, data: [] },
    { success: true, data: {} },
    { success: true, data: { limits: null } },
    { success: true, data: { limits: {} } },
    { success: true, data: { limits: [null, 7, 'five_hour'] } },
  ]) {
    assert.equal(parseClinePassUsage(body), null);
  }
});

test('parseClinePassUsage clamps the used ratio and fails a malformed known window', () => {
  const ratioOf = (percentUsed) => parseClinePassUsage({
    success: true,
    data: { limits: [{ type: 'five_hour', percentUsed, resetsAt: null }] },
  }).windows[0].usedRatio;
  assert.equal(ratioOf(0), 0);
  assert.equal(ratioOf(140), 1);
  assert.equal(ratioOf(-5), 0);
  for (const percentUsed of ['12.5', null, undefined, Number.NaN, Infinity]) {
    assert.equal(parseClinePassUsage({
      success: true,
      data: { limits: [{ type: 'five_hour', percentUsed, resetsAt: null }] },
    }), null, String(percentUsed));
  }
  // One unreadable known window fails the whole answer instead of silently
  // shrinking it; unknown types are the only entries that may be skipped.
  assert.equal(parseClinePassUsage({
    success: true,
    data: {
      limits: [
        { type: 'five_hour', percentUsed: 10, resetsAt: null },
        { type: 'weekly', percentUsed: '10', resetsAt: null },
      ],
    },
  }), null);
});

test('parseClinePassUsage keeps only parseable ISO resets and first duplicates', () => {
  const resetOf = (resetsAt) => parseClinePassUsage({
    success: true,
    data: { limits: [{ type: 'monthly', percentUsed: 5, resetsAt }] },
  })?.windows[0].resetAt;
  assert.equal(resetOf(null), null);
  assert.equal(resetOf(undefined), null);
  assert.equal(resetOf('2026-08-01T00:00:00.000Z'), '2026-08-01T00:00:00.000Z');
  assert.equal(resetOf('2026-08-01T08:00:00+08:00'), '2026-08-01T00:00:00.000Z');
  // Epoch numbers and free text are format failures, not missing resets.
  for (const resetsAt of [1785542400000, 'not-a-date', '']) {
    assert.equal(parseClinePassUsage({
      success: true,
      data: { limits: [{ type: 'monthly', percentUsed: 5, resetsAt }] },
    }), null, String(resetsAt));
  }
  const duplicate = parseClinePassUsage({
    success: true,
    data: {
      limits: [
        { type: 'weekly', percentUsed: 10, resetsAt: null },
        { type: 'weekly', percentUsed: 90, resetsAt: null },
      ],
    },
  });
  assert.deepEqual(duplicate.windows, [{ label: '7d', usedRatio: 0.1, resetAt: null }]);
});

test('clinepass accepts only the official host and its two documented base paths', () => {
  for (const baseUrl of [
    'https://api.cline.bot',
    'https://api.cline.bot/',
    'https://api.cline.bot/api/v1',
    'https://api.cline.bot/api/v1/',
  ]) {
    assert.ok(ADAPTER.accepts({ baseUrl }), baseUrl);
  }
  for (const baseUrl of [
    null,
    undefined,
    '',
    'http://api.cline.bot/api/v1',
    'https://api.cline.bot.evil/api/v1',
    'https://proxy.example/api/v1',
    'https://api.cline.bot:8443/api/v1',
    'https://user:pass@api.cline.bot/api/v1',
    'https://api.cline.bot/api/v1/chat/completions',
    'https://api.cline.bot/api/v2',
    'https://api.cline.bot/api/v1?beta=1',
    'https://api.cline.bot/api/v1#fragment',
  ]) {
    assert.equal(ADAPTER.accepts({ baseUrl }), null, String(baseUrl));
  }
  assert.equal(ADAPTER.accepts(null), null);
});

test('requestClinePassUsage pins the endpoint and sends the provider key', async () => {
  const calls = [];
  // The endpoints come from accepts(), so the two halves of the adapter are
  // exercised as the facade would wire them.
  const endpoints = ADAPTER.accepts({ baseUrl: 'https://api.cline.bot/api/v1' });
  const result = await requestClinePassUsage({
    apiKey: API_KEY,
    endpoints,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(USAGE_RESPONSE)();
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed.windows.map((window) => window.label), ['5h', '7d', 'mo']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLINEPASS_USAGE_URL);
  assert.deepEqual(calls[0].options.headers, {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
  });
});

test('requestClinePassUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    null,
    undefined,
    {},
    { usageUrl: 'https://proxy.example/api/v1/users/me/plan/usage-limits' },
    { usageUrl: 'http://api.cline.bot/api/v1/users/me/plan/usage-limits' },
    { usageUrl: 'https://api.cline.bot/api/v1/users/me/plan' },
    { usageUrl: 'https://api.cline.bot/api/v1/users/me/plan/usage-limits?x=1' },
    { usageUrl: 'https://api.cline.bot:8443/api/v1/users/me/plan/usage-limits' },
  ]) {
    const result = await requestClinePassUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  for (const apiKey of ['', null, undefined, 42]) {
    const result = await requestClinePassUsage({ apiKey, endpoints: ENDPOINTS, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  }
  assert.equal(called, false);
});

test('requestClinePassUsage maps HTTP failures onto the four states', async () => {
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
    const result = await requestClinePassUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal(result.status, expected, `HTTP ${status}`);
    assert.equal(result.category, category, `HTTP ${status}`);
  }
  // A 429 keeps the Retry-After discipline of the shared request guard.
  const limited = await requestClinePassUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '120' } }),
  });
  assert.equal(limited.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(limited.retryAfterSeen, true);
  assert.equal(limited.retryAfterMs, 120_000);
});

test('requestClinePassUsage maps transport and payload problems without throwing', async () => {
  const offline = await requestClinePassUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);

  const unreadable = await requestClinePassUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  });
  assert.equal(unreadable.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(unreadable.category, REQUEST_CATEGORY.NETWORK);

  const timedOut = await requestClinePassUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    timeoutMs: 20,
    fetchImpl: async () => new Promise(() => {}),
  });
  assert.equal(timedOut.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(timedOut.category, REQUEST_CATEGORY.TIMEOUT);

  for (const body of [
    { success: false, data: { limits: [] } },
    { success: false, error: { code: 'unauthorized' } },
    { success: true, data: { limits: [] } },
    { success: true, data: { limits: [{ type: 'five_hour', percentUsed: '12.5' }] } },
    [],
    null,
  ]) {
    const result = await requestClinePassUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: jsonResponse(body),
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(body));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
});
