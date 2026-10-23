import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { PROVIDER_USAGE_RESULT } from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  VERCEL_AI_GATEWAY_CREDITS_URL,
  parseVercelCredits,
  requestVercelAiGatewayUsage,
} from '../src/provider-usage/vercel-ai-gateway.mjs';

const API_KEY = 'test-key';
const ENDPOINTS = Object.freeze({ usageUrl: VERCEL_AI_GATEWAY_CREDITS_URL });

// Official REST sample, also used by CodexBar's vercel fixture.
const CREDITS_RESPONSE = { balance: '95.50', total_used: '4.50' };

const EXPECTED = Object.freeze({
  kind: 'balance',
  label: 'Vercel AI Gateway',
  available: true,
  balances: [{ currency: 'USD', total: 95.5, granted: null, toppedUp: null }],
});

function jsonResponse(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('ADAPTER exposes the frozen balance contract', () => {
  assert.equal(ADAPTER.id, 'vercel-ai-gateway');
  assert.deepEqual(ADAPTER.hosts, ['ai-gateway.vercel.sh']);
  assert.equal(ADAPTER.metric, 'balance');
  assert.equal(Object.isFrozen(ADAPTER), true);
  assert.equal(VERCEL_AI_GATEWAY_CREDITS_URL, 'https://ai-gateway.vercel.sh/v1/credits');
  assert.deepEqual(ADAPTER.accepts({ baseUrl: 'https://ai-gateway.vercel.sh/v1' }), {
    usageUrl: VERCEL_AI_GATEWAY_CREDITS_URL,
  });
});

test('parseVercelCredits maps the official fixture to a USD balance', () => {
  assert.deepEqual(parseVercelCredits(CREDITS_RESPONSE), EXPECTED);
});

test('parseVercelCredits accepts numeric fields, keeps zero and clamps negative balances', () => {
  assert.deepEqual(parseVercelCredits({ balance: 95.5, total_used: 4.5 }), EXPECTED);
  assert.equal(parseVercelCredits({ balance: 3, total_used: '0' }).balances[0].total, 3);
  // An empty team reports 200 with zeros and must stay visible, not hidden.
  assert.deepEqual(parseVercelCredits({ balance: '0.00', total_used: '0.00' }), {
    kind: 'balance',
    label: 'Vercel AI Gateway',
    available: true,
    balances: [{ currency: 'USD', total: 0, granted: null, toppedUp: null }],
  });
  // The service can report debt; the balance model has no slot for it.
  const negative = parseVercelCredits({ balance: '-1.25', total_used: '9.00' });
  assert.equal(negative.balances[0].total, 0);
  // Lifetime spend is not a grant split and never leaks into those fields.
  assert.equal(negative.balances[0].granted, null);
  assert.equal(negative.balances[0].toppedUp, null);
});

test('parseVercelCredits refuses unusable payloads instead of reading them as zero', () => {
  for (const payload of [
    null,
    undefined,
    'ok',
    [],
    {},
    { balance: '95.50' },
    { balance: '95.50', total_used: '' },
    { balance: '', total_used: '4.50' },
    { balance: '1,000.00', total_used: '4.50' },
    { balance: 'abc', total_used: '4.50' },
    { balance: '0x10', total_used: '4.50' },
    { balance: NaN, total_used: '4.50' },
    { balance: null, total_used: '4.50' },
    { balance: '95.50', total_used: null },
    { balance: '95.50', total_used: '-4.50' },
    { balance: '95.50', total_used: 'spent' },
    { balance: { amount: '95.50' }, total_used: '4.50' },
  ]) {
    assert.equal(parseVercelCredits(payload), null, JSON.stringify(payload));
  }
});

test('accepts honors the documented gateway entry points and fails closed elsewhere', () => {
  for (const baseUrl of [
    'https://ai-gateway.vercel.sh',
    'https://ai-gateway.vercel.sh/',
    'https://ai-gateway.vercel.sh/v1',
    'https://ai-gateway.vercel.sh/v1/',
    'https://ai-gateway.vercel.sh/coding-agent/v1',
    'https://ai-gateway.vercel.sh/codex/v1',
    'https://ai-gateway.vercel.sh/cursor/v1',
    'https://ai-gateway.vercel.sh/claude-code',
    'https://ai-gateway.vercel.sh/claude-code/',
    'https://ai-gateway.vercel.sh:443/v1',
  ]) {
    assert.deepEqual(ADAPTER.accepts({ baseUrl }), {
      usageUrl: VERCEL_AI_GATEWAY_CREDITS_URL,
    }, baseUrl);
  }
  for (const baseUrl of [
    'https://ai-gateway.vercel.sh.evil/v1',
    'https://gateway.vercel.sh/v1',
    'https://ai-gateway.vercel.ai/v1',
    'https://proxy.example/v1',
    'http://ai-gateway.vercel.sh/v1',
    'https://ai-gateway.vercel.sh:8443/v1',
    'https://user:pass@ai-gateway.vercel.sh/v1',
    'https://ai-gateway.vercel.sh/v1?team=acme',
    'https://ai-gateway.vercel.sh/v1#frag',
    'https://ai-gateway.vercel.sh/v2',
    'https://ai-gateway.vercel.sh/api/paas/v4',
    'not a url',
    '',
    undefined,
  ]) {
    assert.equal(ADAPTER.accepts({ baseUrl }), null, String(baseUrl));
  }
});

test('requestVercelAiGatewayUsage calls the pinned credits endpoint with the key', async () => {
  const calls = [];
  const result = await requestVercelAiGatewayUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => CREDITS_RESPONSE };
    },
  });
  assert.equal(result.status, PROVIDER_USAGE_RESULT.SUCCESS);
  assert.deepEqual(result.parsed, EXPECTED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ai-gateway.vercel.sh/v1/credits');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});

test('requestVercelAiGatewayUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const endpoints of [
    null,
    {},
    { usageUrl: 'https://proxy.example/v1/credits' },
    { usageUrl: 'https://ai-gateway.vercel.sh.evil/v1/credits' },
    { usageUrl: 'http://ai-gateway.vercel.sh/v1/credits' },
    { usageUrl: 'https://ai-gateway.vercel.sh:8443/v1/credits' },
    { usageUrl: 'https://user:pass@ai-gateway.vercel.sh/v1/credits' },
    { usageUrl: 'https://ai-gateway.vercel.sh/v2/credits' },
    { usageUrl: 'https://ai-gateway.vercel.sh/v1/credits?team=acme' },
    { usageUrl: 'https://ai-gateway.vercel.sh/v1/credits#frag' },
  ]) {
    const result = await requestVercelAiGatewayUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID, String(endpoints?.usageUrl));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  for (const apiKey of ['', null, undefined, 42]) {
    const result = await requestVercelAiGatewayUsage({ apiKey, endpoints: ENDPOINTS, fetchImpl });
    assert.equal(result.status, PROVIDER_USAGE_RESULT.INVALID);
  }
  assert.equal(called, false);
});

test('requestVercelAiGatewayUsage maps HTTP and transport failures onto the four states', async () => {
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
    const result = await requestVercelAiGatewayUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal(result.status, expectedStatus, `HTTP ${status}`);
    assert.equal(result.category, expectedCategory, `HTTP ${status}`);
  }
  const rateLimited = await requestVercelAiGatewayUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '60' : null) },
    }),
  });
  assert.equal(rateLimited.retryAfterSeen, true);
  assert.equal(rateLimited.retryAfterMs, 60_000);

  const offline = await requestVercelAiGatewayUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);

  const timedOut = await requestVercelAiGatewayUsage({
    apiKey: API_KEY,
    endpoints: ENDPOINTS,
    timeoutMs: 10,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(timedOut.status, PROVIDER_USAGE_RESULT.TRANSIENT);
  assert.equal(timedOut.category, REQUEST_CATEGORY.TIMEOUT);
});

test('requestVercelAiGatewayUsage treats an unusable 200 body as invalid format', async () => {
  for (const body of [
    {},
    { balance: null, total_used: null },
    { balance: '95.50', total_used: '' },
    { error: { message: 'Invalid request body', type: 'invalid_request_error' } },
    { balance: '95.50', total_used: '4.50', extra: [] },
  ]) {
    const result = await requestVercelAiGatewayUsage({
      apiKey: API_KEY,
      endpoints: ENDPOINTS,
      fetchImpl: jsonResponse(body),
    });
    const usable = body.balance === '95.50' && body.total_used === '4.50';
    assert.equal(
      result.status,
      usable ? PROVIDER_USAGE_RESULT.SUCCESS : PROVIDER_USAGE_RESULT.INVALID,
      JSON.stringify(body),
    );
    if (!usable) assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
});
