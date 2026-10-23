import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { PROVIDER_USAGE_RESULT, normalizeUsage } from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  SYNTHETIC_PROVIDER,
  SYNTHETIC_USAGE_URL,
  parseSyntheticQuotas,
  requestSyntheticUsage,
} from '../src/provider-usage/synthetic.mjs';

const API_KEY = 'test-key';

// CodexBar's own Synthetic fixture: weekly token bucket plus the hourly search
// bucket, with the dollar-credit rows the HUD must not show.
const CODEXBAR_RESPONSE = {
  weeklyTokenLimit: {
    nextRegenAt: '2026-04-17T05:19:30.000Z',
    percentRemaining: 98.0,
    maxCredits: '$36.00',
    remainingCredits: '$35.30',
    nextRegenCredits: '$0.72',
  },
  search: {
    hourly: {
      limit: 250,
      requests: 2,
      renewsAt: '2026-04-17T04:30:01.494Z',
    },
  },
};

// The live shape third-party clients observed: all three enhanced buckets plus
// the free tool-call buckets and the legacy subscription block.
const FULL_RESPONSE = {
  rollingFiveHourLimit: {
    nextTickAt: '2026-04-17T02:55:00.000Z',
    tickPercent: 5,
    remaining: 345,
    max: 500,
    limited: false,
  },
  weeklyTokenLimit: {
    nextRegenAt: '2026-04-17T05:19:30.000Z',
    percentRemaining: 98.0,
    maxCredits: '$36.00',
    remainingCredits: '$35.30',
    nextRegenCredits: '$0.72',
  },
  search: {
    hourly: { limit: 250, requests: 2, renewsAt: '2026-04-17T04:30:01.494Z' },
  },
  freeToolCalls: { limit: 100, requests: 3, renewsAt: '2026-04-17T04:30:01.494Z' },
  toolCallDiscounts: { limit: 0, requests: 0, renewsAt: '2026-04-17T04:30:01.494Z' },
  subscription: { limit: 135, requests: 0, renewsAt: '2025-09-21T14:36:14.288Z' },
};

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('parseSyntheticQuotas maps the rolling, weekly and hourly search windows', () => {
  const parsed = parseSyntheticQuotas(FULL_RESPONSE);
  assert.deepEqual(parsed, {
    kind: 'windows',
    label: 'Synthetic',
    windows: [
      { label: '5h', usedRatio: 0.31, resetAt: null },
      { label: '7d', usedRatio: 0.02, resetAt: null },
      { label: '1h', usedRatio: 0.008, resetAt: '2026-04-17T04:30:01.494Z' },
    ],
  });
  assert.deepEqual(normalizeUsage(parsed), parsed);
});

test('parseSyntheticQuotas reads percentRemaining as a remaining share', () => {
  const parsed = parseSyntheticQuotas(CODEXBAR_RESPONSE);
  assert.deepEqual(parsed.windows, [
    { label: '7d', usedRatio: 0.02, resetAt: null },
    { label: '1h', usedRatio: 0.008, resetAt: '2026-04-17T04:30:01.494Z' },
  ]);
  // The dollar credit rows belong to one bucket allowance, not a balance.
  assert.equal(parsed.kind, 'windows');
  assert.equal(Object.hasOwn(parsed, 'balances'), false);
});

test('parseSyntheticQuotas reads the slots from a data wrapper', () => {
  const wrapped = parseSyntheticQuotas({ data: CODEXBAR_RESPONSE });
  assert.deepEqual(wrapped.windows.map((window) => window.label), ['7d', '1h']);
  // A root that already carries a slot wins over the wrapper.
  const precedence = parseSyntheticQuotas({
    weeklyTokenLimit: { percentRemaining: 50 },
    data: { search: { hourly: { limit: 10, requests: 1, renewsAt: null } } },
  });
  assert.deepEqual(precedence.windows, [{ label: '7d', usedRatio: 0.5, resetAt: null }]);
  const emptyData = parseSyntheticQuotas({ data: null });
  assert.equal(emptyData, null);
});

test('parseSyntheticQuotas rejects payloads without a usable window', () => {
  for (const body of [
    null,
    undefined,
    42,
    'quota',
    [],
    {},
    { data: [] },
    { subscription: { limit: 135, requests: 0, renewsAt: '2025-09-21T14:36:14.288Z' } },
    { freeToolCalls: { limit: 100, requests: 3, renewsAt: '2026-04-17T04:30:01.494Z' } },
    { search: { hourly: { limit: 0, requests: 0, renewsAt: null } } },
    { search: { hourly: { limit: 250, requests: -1 } } },
    { rollingFiveHourLimit: { max: 0, remaining: 0, limited: false } },
    { rollingFiveHourLimit: { max: 500, limited: false } },
    { weeklyTokenLimit: { percentRemaining: 'not-a-number' } },
    { rollingFiveHourLimit: 'x', weeklyTokenLimit: [], search: 5 },
  ]) {
    assert.equal(parseSyntheticQuotas(body), null);
  }
});

test('parseSyntheticQuotas lets limited win and clamps every ratio', () => {
  const limited = parseSyntheticQuotas({
    rollingFiveHourLimit: { max: 500, remaining: 400, limited: true },
  });
  assert.equal(limited.windows[0].usedRatio, 1);
  const exhausted = parseSyntheticQuotas({
    rollingFiveHourLimit: { max: 500, remaining: 0, limited: false },
  });
  assert.equal(exhausted.windows[0].usedRatio, 1);
  const overdraw = parseSyntheticQuotas({
    rollingFiveHourLimit: { max: 500, remaining: -50 },
  });
  assert.equal(overdraw.windows[0].usedRatio, 1);
  for (const [percent, expected] of [[140, 0], [100, 0], [0, 1], [-5, 1], [7.5, 0.925]]) {
    const parsed = parseSyntheticQuotas({ weeklyTokenLimit: { percentRemaining: percent } });
    assert.equal(parsed.windows[0].usedRatio, expected, String(percent));
  }
  const stringCounters = parseSyntheticQuotas({
    search: { hourly: { limit: '250', requests: '5' } },
  });
  assert.equal(stringCounters.windows[0].usedRatio, 0.02);
  assert.equal(stringCounters.windows[0].resetAt, null);
});

test('parseSyntheticQuotas accepts epoch reset stamps as a fallback', () => {
  const millis = parseSyntheticQuotas({
    search: { hourly: { limit: 10, requests: 1, renewsAt: 1785816000000 } },
  });
  assert.equal(millis.windows[0].resetAt, '2026-08-04T04:00:00.000Z');
  const seconds = parseSyntheticQuotas({
    search: { hourly: { limit: 10, requests: 1, renewsAt: 1785816000 } },
  });
  assert.equal(seconds.windows[0].resetAt, '2026-08-04T04:00:00.000Z');
  const unusable = parseSyntheticQuotas({
    search: { hourly: { limit: 10, requests: 1, renewsAt: 'soon' } },
  });
  assert.equal(unusable.windows[0].resetAt, null);
});

test('the synthetic adapter contract is frozen and claims only its official host', () => {
  assert.equal(Object.isFrozen(ADAPTER), true);
  assert.equal(ADAPTER.id, 'synthetic');
  assert.equal(SYNTHETIC_PROVIDER, 'synthetic');
  assert.deepEqual(ADAPTER.hosts, ['api.synthetic.new']);
  assert.equal(ADAPTER.metric, 'usage windows');
  assert.equal(typeof ADAPTER.accepts, 'function');
  assert.equal(typeof ADAPTER.request, 'function');
  for (const claimed of [
    'api.deepseek.com',
    'opencode.ai',
    'open.bigmodel.cn',
    'api.z.ai',
  ]) {
    assert.equal(ADAPTER.hosts.includes(claimed), false, claimed);
  }
});

test('accepts takes every documented base_url on the official host and nothing else', () => {
  for (const baseUrl of [
    'https://api.synthetic.new/v1',
    'https://api.synthetic.new/openai/v1',
    'https://api.synthetic.new/anthropic',
    'https://api.synthetic.new/v1/',
    'https://api.synthetic.new',
  ]) {
    assert.deepEqual(ADAPTER.accepts({ baseUrl }), {
      usageUrl: SYNTHETIC_USAGE_URL,
      balanceUrl: null,
    }, baseUrl);
  }
  for (const baseUrl of [
    'https://api.synthetic.new.evil/v1',
    'https://proxy.example/v1',
    'http://api.synthetic.new/v1',
    'https://api.synthetic.new:8443/v1',
    'https://user:pass@api.synthetic.new/v1',
    'https://api.synthetic.com/v1',
    'https://www.synthetic.new/v1',
    'https://api.deepseek.com/v1',
    '',
  ]) {
    assert.equal(ADAPTER.accepts({ baseUrl }), null, baseUrl);
  }
  assert.equal(ADAPTER.accepts({}), null);
  assert.equal(ADAPTER.accepts(null), null);
});

test('requestSyntheticUsage calls the quota endpoint with the provider key', async () => {
  const calls = [];
  const result = await requestSyntheticUsage({
    apiKey: API_KEY,
    endpoints: ADAPTER.accepts({ baseUrl: 'https://api.synthetic.new/v1' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => FULL_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed.windows.map((window) => window.label), ['5h', '7d', '1h']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.synthetic.new/v2/quotas');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});

test('requestSyntheticUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const options of [
    { apiKey: API_KEY, endpoints: null, url: 'https://proxy.example/v2/quotas' },
    { apiKey: API_KEY, endpoints: { usageUrl: 'https://proxy.example/v2/quotas', balanceUrl: null } },
    { apiKey: API_KEY, url: 'https://api.synthetic.new/v2/quotas?key=1' },
    { apiKey: API_KEY, url: 'https://api.synthetic.new/v2/quotas#x' },
    { apiKey: API_KEY, url: 'http://api.synthetic.new/v2/quotas' },
    { apiKey: API_KEY, url: 'https://api.synthetic.new/v1/quotas' },
    { apiKey: API_KEY, endpoints: { usageUrl: 'https://proxy.example/v2/quotas' } },
    { apiKey: '', endpoints: null },
    { endpoints: null },
  ]) {
    const result = await requestSyntheticUsage({ ...options, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(options));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  assert.equal(called, false);
});

test('requestSyntheticUsage classifies HTTP and payload failures', async () => {
  const cases = [
    [500, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [503, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.RATE_LIMITED],
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [404, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expected, category] of cases) {
    const result = await requestSyntheticUsage({
      apiKey: API_KEY,
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal(result.status, expected, `HTTP ${status}`);
    assert.equal(result.category, category, `HTTP ${status}`);
  }
  const offline = await requestSyntheticUsage({
    apiKey: API_KEY,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);
  const timedOut = await requestSyntheticUsage({
    apiKey: API_KEY,
    timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  });
  assert.equal(timedOut.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(timedOut.category, REQUEST_CATEGORY.TIMEOUT);
});

test('requestSyntheticUsage honors Retry-After and hides empty accounts', async () => {
  const throttled = await requestSyntheticUsage({
    apiKey: API_KEY,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '30']]),
    }),
  });
  assert.equal(throttled.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(throttled.retryAfterSeen, true);
  assert.equal(throttled.retryAfterMs, 30_000);

  for (const body of [
    {},
    { data: {} },
    { subscription: { limit: 135, requests: 0, renewsAt: '2025-09-21T14:36:14.288Z' } },
  ]) {
    const empty = await requestSyntheticUsage({ apiKey: API_KEY, fetchImpl: jsonResponse(body) });
    assert.equal(empty.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(body));
    assert.equal(empty.category, REQUEST_CATEGORY.INVALID_FORMAT);
    assert.equal(Object.hasOwn(empty, 'parsed'), false);
  }

  const success = await requestSyntheticUsage({
    apiKey: API_KEY,
    fetchImpl: jsonResponse(CODEXBAR_RESPONSE),
  });
  assert.equal(success.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(success.parsed.windows.map((window) => window.label), ['7d', '1h']);
});
