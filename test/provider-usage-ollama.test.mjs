import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_CATEGORY } from '../src/request-guard.mjs';
import { normalizeUsage } from '../src/provider-usage/common.mjs';
import {
  ADAPTER,
  OLLAMA_BALANCE_URL,
  OLLAMA_PROVIDER,
  parseOllamaUsage,
  requestOllamaUsage,
} from '../src/provider-usage/ollama.mjs';

const API_KEY = 'test-key';

// CodexBar's OllamaAPIBalanceTests fixture (synthetic values).
const CREDIT_FIXTURE = {
  included: {
    balance_usd: '52.50',
    allowance_usd: 60,
    period: { from: '2026-09-30T15:14:29Z', until: '2026-10-30T15:14:29Z' },
  },
  purchased: { balance_usd: '18.25' },
};

// The official Balance documentation sample.
const OFFICIAL_SAMPLE = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' },
  },
  purchased: { balance_usd: 25 },
};

const LEGACY_FIXTURE = {
  included: {
    session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
    weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' },
  },
  purchased: { balance_usd: 0 },
};

function response(status, body = null, headers = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
  };
}

function retryAfterHeaders(value) {
  return { get: (name) => (name.toLowerCase() === 'retry-after' ? value : null) };
}

test('parseOllamaUsage maps a credit plan to one monthly window', () => {
  const parsed = parseOllamaUsage(CREDIT_FIXTURE);
  assert.deepEqual(parsed, {
    kind: 'windows',
    label: 'Ollama',
    windows: [{
      label: 'mo',
      usedRatio: 0.125,
      resetAt: '2026-10-30T15:14:29.000Z',
    }],
  });
  assert.deepEqual(normalizeUsage(parsed), parsed);
});

test('parseOllamaUsage maps the official documentation sample', () => {
  const parsed = parseOllamaUsage(OFFICIAL_SAMPLE);
  assert.equal(parsed.kind, 'windows');
  assert.deepEqual(parsed.windows, [{
    label: 'mo',
    usedRatio: 0.275,
    resetAt: '2026-10-15T09:30:00.000Z',
  }]);
});

test('parseOllamaUsage accepts decimal strings and numbers alike', () => {
  const parsed = parseOllamaUsage({
    included: { allowance_usd: '60', balance_usd: 45 },
  });
  assert.equal(parsed.windows[0].usedRatio, 0.25);
  const integers = parseOllamaUsage({
    included: { allowance_usd: 60, balance_usd: '0' },
  });
  assert.equal(integers.windows[0].usedRatio, 1);
});

test('parseOllamaUsage rejects non-decimal amounts instead of coercing them', () => {
  for (const bad of [true, false, null, '', '0x10', 'NaN', '1e3', 1e999, {}, []]) {
    assert.equal(
      parseOllamaUsage({ included: { allowance_usd: 60, balance_usd: bad } }),
      null,
      String(bad),
    );
    assert.equal(
      parseOllamaUsage({ included: {}, purchased: { balance_usd: bad } }),
      null,
      String(bad),
    );
  }
});

test('parseOllamaUsage clamps the monthly ratio and drops zero allowances', () => {
  const overdrawn = parseOllamaUsage({
    included: { allowance_usd: 60, balance_usd: -2.5 },
  });
  assert.equal(overdrawn.windows[0].usedRatio, 1);
  const untouched = parseOllamaUsage({
    included: { allowance_usd: 60, balance_usd: 70 },
  });
  assert.equal(untouched.windows[0].usedRatio, 0);
  assert.deepEqual(parseOllamaUsage({
    included: { allowance_usd: 0, balance_usd: '0' },
  }), {
    kind: 'balance',
    label: 'Ollama',
    available: true,
    balances: [{ currency: 'USD', total: 0, granted: 0, toppedUp: null }],
  });
});

test('parseOllamaUsage flips legacy remaining percentages into used windows', () => {
  const parsed = parseOllamaUsage(LEGACY_FIXTURE);
  assert.deepEqual(parsed, {
    kind: 'windows',
    label: 'Ollama',
    windows: [
      { label: '5h', usedRatio: 0.25, resetAt: '2026-10-01T07:00:00.000Z' },
      { label: '7d', usedRatio: 0.6, resetAt: '2026-10-05T00:00:00.000Z' },
    ],
  });
});

test('parseOllamaUsage skips legacy windows outside 0-100 instead of clamping', () => {
  assert.equal(parseOllamaUsage({
    included: { session: { remaining_percent: 140 } },
  }), null);
  assert.equal(parseOllamaUsage({
    included: { session: { remaining_percent: -1 } },
  }), null);
  const partial = parseOllamaUsage({
    included: {
      session: { remaining_percent: '0' },
      weekly: { remaining_percent: 150 },
    },
  });
  assert.deepEqual(partial.windows, [{ label: '5h', usedRatio: 1, resetAt: null }]);
});

test('parseOllamaUsage keeps unparsable or missing reset stamps out of the window', () => {
  const parsed = parseOllamaUsage({
    included: {
      allowance_usd: 10,
      balance_usd: 5,
      period: { until: 'not-a-date' },
      session: { remaining_percent: 50, resets_at: 1234 },
    },
  });
  assert.deepEqual(parsed.windows, [
    { label: 'mo', usedRatio: 0.5, resetAt: null },
    { label: '5h', usedRatio: 0.5, resetAt: null },
  ]);
});

test('parseOllamaUsage falls back to a USD balance when no window is derivable', () => {
  assert.deepEqual(parseOllamaUsage({ purchased: { balance_usd: '18.25' } }), {
    kind: 'balance',
    label: 'Ollama',
    available: true,
    balances: [{ currency: 'USD', total: 18.25, granted: null, toppedUp: 18.25 }],
  });
  assert.deepEqual(parseOllamaUsage({
    included: { balance_usd: 5, allowance_usd: 0 },
    purchased: { balance_usd: '3' },
  }), {
    kind: 'balance',
    label: 'Ollama',
    available: true,
    balances: [{ currency: 'USD', total: 8, granted: 5, toppedUp: 3 }],
  });
  // An overdrawn included balance is not attributed and floors the total at 0.
  assert.deepEqual(parseOllamaUsage({
    included: { balance_usd: -2.5 },
    purchased: { balance_usd: 18.25 },
  }), {
    kind: 'balance',
    label: 'Ollama',
    available: true,
    balances: [{ currency: 'USD', total: 15.75, granted: null, toppedUp: 18.25 }],
  });
  assert.deepEqual(parseOllamaUsage({ included: { balance_usd: -2.5 } }), {
    kind: 'balance',
    label: 'Ollama',
    available: true,
    balances: [{ currency: 'USD', total: 0, granted: null, toppedUp: null }],
  });
});

test('parseOllamaUsage returns null for unrecognized bodies without throwing', () => {
  const bodies = [
    null,
    undefined,
    0,
    1,
    true,
    '',
    'text',
    [],
    [1],
    {},
    { error: 'invalid credentials' },
    { included: [] },
    { included: 'x' },
    { purchased: 5 },
    { included: { session: [] } },
    { included: { session: { remaining_percent: {} } } },
    { included: { allowance_usd: { value: 60 } } },
    Object.create(null),
  ];
  for (const body of bodies) {
    let parsed;
    assert.doesNotThrow(() => { parsed = parseOllamaUsage(body); });
    assert.equal(parsed, null);
  }
});

test('ADAPTER identity, hosts and metric follow the adapter contract', () => {
  assert.equal(Object.isFrozen(ADAPTER), true);
  assert.equal(ADAPTER.id, OLLAMA_PROVIDER);
  assert.equal(ADAPTER.id, 'ollama');
  assert.equal(ADAPTER.metric, 'usage windows');
  assert.deepEqual(ADAPTER.hosts, ['ollama.com', 'www.ollama.com', 'api.ollama.com']);
  assert.equal(ADAPTER.request, requestOllamaUsage);
  // Hosts already claimed by other adapters, plus the local Ollama service,
  // must never fall into this adapter.
  const taken = ['api.deepseek.com', 'opencode.ai', 'open.bigmodel.cn', 'api.z.ai'];
  for (const host of [...taken, 'localhost', '127.0.0.1']) {
    assert.equal(ADAPTER.hosts.includes(host), false, host);
  }
});

test('ADAPTER.accepts serves the official Ollama Cloud hosts only', () => {
  for (const baseUrl of [
    'https://ollama.com',
    'https://ollama.com/',
    'https://ollama.com/api',
    'https://ollama.com/v1',
    'https://ollama.com:443/v1',
    'https://www.ollama.com/v1',
    'https://api.ollama.com/v1',
  ]) {
    assert.deepEqual(
      ADAPTER.accepts({ baseUrl }),
      { usageUrl: OLLAMA_BALANCE_URL },
      baseUrl,
    );
  }
  for (const baseUrl of [
    'http://ollama.com/v1',
    'https://ollama.com:8443/v1',
    'https://user:pass@ollama.com/v1',
    'https://user@ollama.com/v1',
    'https://ollama.com.evil/v1',
    'https://proxy.example/v1',
    'https://localhost/v1',
    'https://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'https://api.deepseek.com/v1',
    '',
  ]) {
    assert.equal(ADAPTER.accepts({ baseUrl }), null, baseUrl);
  }
  for (const config of [null, undefined, {}, { baseUrl: null }, { baseUrl: 123 }, { baseUrl: 'not a url' }]) {
    assert.doesNotThrow(() => assert.equal(ADAPTER.accepts(config), null));
  }
});

test('requestOllamaUsage performs one pinned GET with the provider key', async () => {
  const calls = [];
  const result = await requestOllamaUsage({
    apiKey: API_KEY,
    endpoints: ADAPTER.accepts({ baseUrl: 'https://ollama.com/v1' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, CREDIT_FIXTURE);
    },
  });
  assert.equal(result.status, 'success');
  assert.equal(result.parsed.windows[0].label, 'mo');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ollama.com/api/balance');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Cookie'), false);

  const defaults = [];
  await requestOllamaUsage({
    apiKey: API_KEY,
    fetchImpl: async (url) => {
      defaults.push(url);
      return response(200, CREDIT_FIXTURE);
    },
  });
  assert.deepEqual(defaults, [OLLAMA_BALANCE_URL]);
});

test('requestOllamaUsage refuses non-official endpoints before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return response(200, CREDIT_FIXTURE); };
  for (const endpoints of [
    { usageUrl: 'https://proxy.example/api/balance' },
    { usageUrl: 'https://ollama.com.evil/api/balance' },
    { usageUrl: 'http://ollama.com/api/balance' },
    { usageUrl: 'https://ollama.com:8443/api/balance' },
    { usageUrl: 'https://user:pass@ollama.com/api/balance' },
    { usageUrl: 'https://ollama.com/api/balance?x=1' },
    { usageUrl: 'https://ollama.com/api/balance#fragment' },
    { usageUrl: 'https://ollama.com/api/balance/' },
    { usageUrl: 'https://www.ollama.com/api/balance' },
    { usageUrl: 'https://api.ollama.com/api/balance' },
    { usageUrl: 'https://localhost:11434/api/balance' },
  ]) {
    const result = await requestOllamaUsage({ apiKey: API_KEY, endpoints, fetchImpl });
    assert.equal(result.status, 'invalid', JSON.stringify(endpoints));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
  const missingKey = await requestOllamaUsage({ apiKey: '', endpoints: null, fetchImpl });
  assert.equal(missingKey.status, 'invalid');
  assert.equal(called, false);
});

test('requestOllamaUsage dispatches HTTP failures into the four-state vocabulary', async () => {
  const cases = [
    [401, 'unauthorized', REQUEST_CATEGORY.AUTH],
    [403, 'unauthorized', REQUEST_CATEGORY.AUTH],
    [500, 'transient', REQUEST_CATEGORY.SERVER],
    [429, 'transient', REQUEST_CATEGORY.RATE_LIMITED],
    [400, 'invalid', REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expectedStatus, expectedCategory] of cases) {
    const result = await requestOllamaUsage({
      apiKey: API_KEY,
      fetchImpl: async () => response(status),
    });
    assert.equal(result.status, expectedStatus, `HTTP ${status}`);
    assert.equal(result.category, expectedCategory, `HTTP ${status}`);
  }
  const limited = await requestOllamaUsage({
    apiKey: API_KEY,
    fetchImpl: async () => response(429, null, retryAfterHeaders('2')),
  });
  assert.equal(limited.status, 'transient');
  assert.equal(limited.retryAfterSeen, true);
  assert.equal(limited.retryAfterMs, 2000);
  const offline = await requestOllamaUsage({
    apiKey: API_KEY,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(offline.status, 'transient');
  assert.equal(offline.category, REQUEST_CATEGORY.NETWORK);
});

test('requestOllamaUsage reports unusable 200 bodies as invalid payloads', async () => {
  for (const body of [{}, { error: 'invalid credentials' }, { included: {} }, null]) {
    const result = await requestOllamaUsage({
      apiKey: API_KEY,
      fetchImpl: async () => response(200, body),
    });
    assert.equal(result.status, 'invalid', JSON.stringify(body));
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  }
});
