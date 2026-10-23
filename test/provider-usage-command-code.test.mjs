import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { PROVIDER_USAGE_RESULT, normalizeUsage } from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  COMMAND_CODE_CREDITS_URL,
  COMMAND_CODE_SUBSCRIPTIONS_URL,
  parseCommandCodeCredits,
  requestCommandCodeUsage,
} from '../src/provider-usage/command-code.mjs';

const API_KEY = 'test-key';
const ENDPOINTS = Object.freeze({
  creditsUrl: COMMAND_CODE_CREDITS_URL,
  subscriptionsUrl: COMMAND_CODE_SUBSCRIPTIONS_URL,
});

// Trimmed copy of the captured credits response: the 5h reset is epoch
// seconds, the weekly reset epoch milliseconds, and the monthly grant is the
// remaining-credit ceiling.
const CREDITS_RESPONSE = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 8.7784,
    purchasedCredits: 0,
    premiumMonthlyCredits: 0,
    opensourceMonthlyCredits: 8.7784,
    monthlyCreditsGranted: 10,
  },
  windowLimits: {
    fiveHour: { used: 1, cap: 4, resetAt: 1780200000 },
    weekly: { used: 4, cap: 20, resetAt: 1780300000000 },
  },
};

const SUBSCRIPTIONS_RESPONSE = {
  success: true,
  data: {
    planId: 'individual-go',
    status: 'active',
    currentPeriodStart: '2026-05-06T07:28:50.000Z',
    currentPeriodEnd: '2026-06-06T07:28:50.000Z',
    cancelAtPeriodEnd: false,
  },
};

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('parseCommandCodeCredits maps the captured snapshot into 5h, 7d and mo windows', () => {
  const parsed = parseCommandCodeCredits(CREDITS_RESPONSE, SUBSCRIPTIONS_RESPONSE);
  assert.equal(parsed.kind, 'windows');
  assert.equal(parsed.label, 'Command Code');
  assert.deepEqual(parsed.windows.map((window) => window.label), ['5h', '7d', 'mo']);
  assert.equal(parsed.windows[0].usedRatio, 0.25);
  assert.equal(parsed.windows[0].resetAt, '2026-05-31T04:00:00.000Z');
  assert.equal(parsed.windows[1].usedRatio, 0.2);
  assert.equal(parsed.windows[1].resetAt, '2026-06-01T07:46:40.000Z');
  // monthlyCredits is the remaining allowance: (10 - 8.7784) / 10.
  assert.ok(Math.abs(parsed.windows[2].usedRatio - 0.12216) < 1e-9);
  assert.equal(parsed.windows[2].resetAt, '2026-06-06T07:28:50.000Z');
});

test('parseCommandCodeCredits reads nested limits and normalizes mixed reset stamps', () => {
  const parsed = parseCommandCodeCredits({
    credits: {
      monthlyCredits: 5,
      monthlyCreditsGranted: 10,
      windowLimits: {
        fiveHour: { used: 3, cap: 4, resetAt: '1780200000' },
        weekly: { used: 5, cap: 10, resetAt: '2026-06-01T00:00:00.000Z' },
      },
    },
  });
  assert.deepEqual(parsed.windows, [
    { label: '5h', usedRatio: 0.75, resetAt: '2026-05-31T04:00:00.000Z' },
    { label: '7d', usedRatio: 0.5, resetAt: '2026-06-01T00:00:00.000Z' },
    { label: 'mo', usedRatio: 0.5, resetAt: null },
  ]);
  // A root windowLimits object without either window key does not hide the
  // nested copy.
  const nested = parseCommandCodeCredits({
    windowLimits: {},
    credits: {
      monthlyCredits: 0,
      windowLimits: { fiveHour: { used: 1, cap: 4, resetAt: 'soon' } },
    },
  });
  assert.equal(nested.windows.length, 1);
  assert.equal(nested.windows[0].label, '5h');
  assert.equal(nested.windows[0].resetAt, null);
});

test('parseCommandCodeCredits clamps used shares and skips unusable window entries', () => {
  const clamped = parseCommandCodeCredits({
    credits: { monthlyCredits: 0 },
    windowLimits: { fiveHour: { used: 9, cap: 4, resetAt: null } },
  });
  assert.deepEqual(clamped.windows, [{ label: '5h', usedRatio: 1, resetAt: null }]);
  for (const window of [
    { used: 1, cap: 0 },
    { used: 0, cap: 0 },
    { used: -1, cap: 4 },
    { used: 'x', cap: 4 },
    { used: 1 },
    { cap: 4 },
    null,
    [],
  ]) {
    const parsed = parseCommandCodeCredits({
      credits: { monthlyCredits: 0 },
      windowLimits: { fiveHour: window },
    });
    assert.equal(parsed.kind, 'balance', JSON.stringify(window));
    assert.equal(parsed.balances[0].total, 0);
  }
});

test('parseCommandCodeCredits builds the monthly window only from a known grant', () => {
  const catalog = parseCommandCodeCredits(
    { credits: { monthlyCredits: 4 } },
    { success: true, data: { planId: 'individual-go', currentPeriodEnd: '2026-06-06T07:28:50.000Z' } },
  );
  assert.deepEqual(catalog.windows, [{
    label: 'mo',
    usedRatio: 0.6,
    resetAt: '2026-06-06T07:28:50.000Z',
  }]);
  // An unlisted plan id without monthlyCreditsGranted leaves the monthly
  // window out instead of inventing a cap.
  const unknownPlan = parseCommandCodeCredits(
    { credits: { monthlyCredits: 4 } },
    { success: true, data: { planId: 'individual-ultra' } },
  );
  assert.equal(unknownPlan.kind, 'balance');
  assert.equal(unknownPlan.balances[0].granted, null);
  // Remaining credits above the grant clamp to 0% used.
  const overGrant = parseCommandCodeCredits({ credits: { monthlyCredits: 12, monthlyCreditsGranted: 10 } });
  assert.equal(overGrant.windows[0].label, 'mo');
  assert.equal(overGrant.windows[0].usedRatio, 0);
});

test('parseCommandCodeCredits ignores unusable subscription envelopes', () => {
  for (const plan of [
    null,
    {},
    { success: false, data: { planId: 'individual-go', currentPeriodEnd: '2027-01-01T00:00:00.000Z' } },
    { success: true, data: null },
    { success: true, data: [] },
  ]) {
    const parsed = parseCommandCodeCredits(
      { credits: { monthlyCredits: 10, monthlyCreditsGranted: 10 } },
      plan,
    );
    assert.equal(parsed.kind, 'windows');
    assert.equal(parsed.windows[0].label, 'mo');
    assert.equal(parsed.windows[0].usedRatio, 0);
    assert.equal(parsed.windows[0].resetAt, null, JSON.stringify(plan));
  }
});

test('parseCommandCodeCredits degrades to the remaining USD credit balance', () => {
  // No window limits and no known monthly grant: the only fact left is the
  // remaining credit balance.
  const parsed = parseCommandCodeCredits({
    credits: {
      monthlyCredits: 8.7784,
      purchasedCredits: 2,
      freeCredits: 1,
      premiumMonthlyCredits: 0,
      opensourceMonthlyCredits: 8.7784,
    },
  });
  assert.equal(parsed.kind, 'balance');
  assert.equal(parsed.label, 'Command Code');
  assert.equal(parsed.available, true);
  assert.equal(parsed.balances[0].currency, 'USD');
  // monthly + purchased + free; the category views are not addable balances.
  assert.ok(Math.abs(parsed.balances[0].total - 11.7784) < 1e-9);
  assert.equal(parsed.balances[0].granted, null);
  assert.equal(parsed.balances[0].toppedUp, 2);
  // Free tier: a $0 remaining balance, not 0% used.
  const free = parseCommandCodeCredits({ credits: { monthlyCredits: 0 } });
  assert.deepEqual(free.balances, [{ currency: 'USD', total: 0, granted: null, toppedUp: null }]);
});

test('parseCommandCodeCredits refuses responses without the credit figures', () => {
  for (const body of [
    null,
    [],
    'nope',
    {},
    { credits: null },
    { credits: [] },
    { credits: {} },
    { credits: { monthlyCredits: null } },
    { credits: { monthlyCredits: '' } },
    { credits: { monthlyCredits: 'abc' } },
    { credits: { monthlyCredits: -0.5 } },
  ]) {
    assert.equal(parseCommandCodeCredits(body), null, JSON.stringify(body));
  }
  // A broken limits block still leaves the usable monthly balance behind.
  assert.equal(parseCommandCodeCredits({
    credits: { monthlyCredits: 0 },
    windowLimits: 'nope',
  }).kind, 'balance');
  // The credit figures alone decide usability; a missing plan never does.
  for (const plan of [null, {}, { success: true, data: null }]) {
    assert.equal(parseCommandCodeCredits({ credits: { monthlyCredits: 1 } }, plan).kind, 'balance');
  }
});

test('the adapter accepts only provider inference bases on api.commandcode.ai', () => {
  for (const baseUrl of [
    'https://api.commandcode.ai',
    'https://api.commandcode.ai/',
    'https://api.commandcode.ai:443/provider/v1',
    'https://api.commandcode.ai/provider',
    'https://api.commandcode.ai/provider/',
    'https://api.commandcode.ai/provider/v1',
    'https://api.commandcode.ai/provider/v1/',
  ]) {
    assert.deepEqual(ADAPTER.accepts({ baseUrl }), ENDPOINTS, baseUrl);
  }
  for (const config of [
    null,
    {},
    { baseUrl: null },
    { baseUrl: 'https://api.commandcode.ai.evil/provider/v1' },
    { baseUrl: 'https://proxy.example/provider/v1' },
    { baseUrl: 'http://api.commandcode.ai/provider/v1' },
    { baseUrl: 'https://api.commandcode.ai:8443/provider/v1' },
    { baseUrl: 'https://user:pass@api.commandcode.ai/provider/v1' },
    { baseUrl: 'https://api.commandcode.ai/provider/v1?x=1' },
    { baseUrl: 'https://api.commandcode.ai/provider/v1#x' },
    { baseUrl: 'https://api.commandcode.ai/provider/v1/chat/completions' },
    { baseUrl: 'https://api.commandcode.ai/beta/v1' },
    { baseUrl: 'https://www.commandcode.ai/provider/v1' },
    { baseUrl: 'https://commandcode.ai/provider/v1' },
  ]) {
    assert.equal(ADAPTER.accepts(config), null, JSON.stringify(config));
  }
});

test('the adapter publishes its identity and claims no host another adapter owns', () => {
  assert.equal(ADAPTER.id, 'command-code');
  assert.deepEqual(ADAPTER.hosts, ['api.commandcode.ai']);
  assert.equal(ADAPTER.metric, 'usage windows');
  assert.equal(ADAPTER.request, requestCommandCodeUsage);
  assert.equal(Object.isFrozen(ADAPTER), true);
  assert.equal(Object.isFrozen(ADAPTER.hosts), true);
  for (const host of ['api.deepseek.com', 'opencode.ai', 'open.bigmodel.cn', 'api.z.ai']) {
    assert.equal(ADAPTER.hosts.includes(host), false, host);
  }
});

test('requestCommandCodeUsage calls the credit snapshot then the plan with the provider key', async () => {
  const calls = [];
  const result = await requestCommandCodeUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => (url === COMMAND_CODE_CREDITS_URL ? CREDITS_RESPONSE : SUBSCRIPTIONS_RESPONSE),
      };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed.windows.map((window) => window.label), ['5h', '7d', 'mo']);
  assert.equal(result.parsed.windows[2].resetAt, '2026-06-06T07:28:50.000Z');
  assert.deepEqual(calls.map((call) => call.url), [COMMAND_CODE_CREDITS_URL, COMMAND_CODE_SUBSCRIPTIONS_URL]);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(call.options.headers.Accept, 'application/json');
  }

  // Without a plan endpoint only the credit snapshot is requested; the
  // monthly window keeps its grant but loses the cycle end.
  const singleCalls = [];
  const solo = await requestCommandCodeUsage({
    apiKey: API_KEY,
    endpoints: { creditsUrl: COMMAND_CODE_CREDITS_URL, subscriptionsUrl: null },
    fetchImpl: async (url) => {
      singleCalls.push(url);
      return { ok: true, status: 200, json: async () => CREDITS_RESPONSE };
    },
  });
  assert.equal(solo.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.equal(solo.parsed.windows[2].label, 'mo');
  assert.equal(solo.parsed.windows[2].resetAt, null);
  assert.deepEqual(singleCalls, [COMMAND_CODE_CREDITS_URL]);
});

test('requestCommandCodeUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  for (const endpoints of [
    null,
    { creditsUrl: 'https://proxy.example/alpha/billing/credits', subscriptionsUrl: null },
    { creditsUrl: COMMAND_CODE_CREDITS_URL, subscriptionsUrl: 'https://proxy.example/alpha/billing/subscriptions' },
    { creditsUrl: 'https://www.commandcode.ai/alpha/billing/credits', subscriptionsUrl: null },
    { creditsUrl: 'http://api.commandcode.ai/alpha/billing/credits', subscriptionsUrl: null },
    { creditsUrl: `${COMMAND_CODE_CREDITS_URL}?x=1`, subscriptionsUrl: null },
    { creditsUrl: `${COMMAND_CODE_CREDITS_URL}/`, subscriptionsUrl: null },
    { creditsUrl: 'https://api.commandcode.ai/alpha/billing/usage', subscriptionsUrl: null },
  ]) {
    const result = await requestCommandCodeUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(endpoints));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  const missingKey = await requestCommandCodeUsage({ apiKey: '', endpoints: ENDPOINTS, fetchImpl });
  assert.equal(missingKey.status, PROVIDER_USAGE_RESULT.INVALID);
  assert.equal(called, false);
});

test('requestCommandCodeUsage keeps the credit windows when the plan lookup fails', async () => {
  const planFailures = [
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: false, status: 401 }),
    async () => { throw new Error('offline'); },
    jsonResponse({ success: false, data: null }),
    jsonResponse({ success: true, data: null }),
    jsonResponse({ success: true, data: 'nope' }),
    jsonResponse(null),
  ];
  for (const planFetch of planFailures) {
    const urls = [];
    const result = await requestCommandCodeUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return url === COMMAND_CODE_CREDITS_URL
          ? { ok: true, status: 200, json: async () => CREDITS_RESPONSE }
          : planFetch();
      },
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
    assert.deepEqual(result.parsed.windows.map((window) => window.label), ['5h', '7d', 'mo']);
    assert.equal(result.parsed.windows[2].resetAt, null);
    assert.deepEqual(urls, [COMMAND_CODE_CREDITS_URL, COMMAND_CODE_SUBSCRIPTIONS_URL]);
  }
});

test('requestCommandCodeUsage maps credit failures to the four states without a plan request', async () => {
  const cases = [
    [500, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [429, PROVIDER_USAGE_RESULT.TRANSIENT, REQUEST_CATEGORY.RATE_LIMITED],
    [401, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, PROVIDER_USAGE_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [404, PROVIDER_USAGE_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expectedStatus, category] of cases) {
    const urls = [];
    const result = await requestCommandCodeUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: false, status };
      },
    });
    assert.equal(result.status, expectedStatus, `HTTP ${status}`);
    assert.equal(result.category, category, `HTTP ${status}`);
    assert.deepEqual(urls, [COMMAND_CODE_CREDITS_URL]);
  }
  const offline = await requestCommandCodeUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);

  const timedOut = await requestCommandCodeUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    timeoutMs: 10,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(timedOut.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(timedOut.category, REQUEST_CATEGORY.TIMEOUT);
});

test('requestCommandCodeUsage fails closed on an unusable credit body without a plan request', async () => {
  for (const body of [null, [], 'nope', {}, { credits: {} }, { credits: { monthlyCredits: 'x' } }]) {
    const urls = [];
    const result = await requestCommandCodeUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => body };
      },
    });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, JSON.stringify(body));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
    assert.deepEqual(urls, [COMMAND_CODE_CREDITS_URL]);
  }
});

test('the parsed record passes the shared normalizer unchanged', () => {
  const windows = parseCommandCodeCredits(CREDITS_RESPONSE, SUBSCRIPTIONS_RESPONSE);
  assert.deepEqual(normalizeUsage(windows), windows);
  const balance = parseCommandCodeCredits({ credits: { monthlyCredits: 1.5, purchasedCredits: 0.5 } });
  assert.deepEqual(normalizeUsage(balance), balance);
});
