import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  REFRESH_STATE_VERSION,
  REQUEST_CATEGORY,
  REQUEST_RESULT,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_MAX_MS,
  RETRY_MAX_DELAY_MS,
  clearRefreshState,
  isRefreshBlocked,
  parseRetryAfter,
  recordRefreshFailure,
  readRefreshState,
  refreshDelayMs,
  requestJsonWithLimits,
} from '../src/request-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    const sockets = new Set();
    let lastClosed = null;
    server.on('connection', (socket) => {
      sockets.add(socket);
      lastClosed = new Promise((resolveClosed) => socket.once('close', resolveClosed));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        sockets,
        connectionClosed: () => lastClosed,
        close: async () => {
          for (const socket of sockets) {
            try { socket.destroy(); } catch { /* already gone */ }
          }
          await new Promise((resolveClose) => {
            try { server.close(resolveClose); } catch { resolveClose(); }
          });
        },
      });
    });
  });
}

async function withServer(handler, run) {
  const instance = await startServer(handler);
  try {
    return await run(instance);
  } finally {
    await instance.close();
  }
}

function stringStream(text, { onCancel } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
    },
    cancel() {
      if (onCancel) onCancel.cancelled = true;
    },
  });
}

test('requestJsonWithLimits defaults expose the fixed whole-request budget and body cap', () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 8000);
  assert.equal(MAX_RESPONSE_BYTES, 1024 * 1024);
});

test('requestJsonWithLimits reads a real streamed 2xx body to the end', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ok":');
    setTimeout(() => {
      res.write('true}');
      res.end();
    }, 20);
  }, async ({ url }) => {
    const result = await requestJsonWithLimits({
      url,
      headers: { Accept: 'application/json' },
      timeoutMs: 2000,
      parse: (json) => (json && json.ok === true ? json : null),
    });
    assert.equal(result.status, REQUEST_RESULT.SUCCESS);
    assert.deepEqual(result.parsed, { ok: true });
  });
});

test('a real response whose body never ends is aborted at the deadline', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"usage":'); // headers are fast, the body never finishes
  }, async ({ url, connectionClosed }) => {
    const started = performance.now();
    const result = await requestJsonWithLimits({
      url,
      headers: { Accept: 'application/json' },
      timeoutMs: 250,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.status, REQUEST_RESULT.TRANSIENT);
    assert.equal(result.category, REQUEST_CATEGORY.TIMEOUT);
    assert.ok(elapsed < 4000, `request settled in ${elapsed}ms`);
    // The abort must tear down the real socket, not leave it pending.
    const closed = await Promise.race([
      connectionClosed().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still-open'), 2000)),
    ]);
    assert.equal(closed, 'closed');
  });
});

test('a real body cut mid-stream classifies as a network error', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"usage":');
    setTimeout(() => res.destroy(), 20);
  }, async ({ url }) => {
    const result = await requestJsonWithLimits({
      url,
      headers: { Accept: 'application/json' },
      timeoutMs: 2000,
    });
    assert.equal(result.status, REQUEST_RESULT.TRANSIENT);
    assert.equal(result.category, REQUEST_CATEGORY.NETWORK);
  });
});

test('a real body beyond the byte ceiling ends with body_limit and cancels the stream', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('x'.repeat(4096));
  }, async ({ url }) => {
    const result = await requestJsonWithLimits({
      url,
      headers: { Accept: 'application/json' },
      timeoutMs: 2000,
      maxBytes: 64,
    });
    assert.equal(result.status, REQUEST_RESULT.INVALID);
    assert.equal(result.category, REQUEST_CATEGORY.BODY_LIMIT);
  });
});

test('a real malformed JSON body is invalid, not transient', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not-json{{{');
  }, async ({ url }) => {
    const result = await requestJsonWithLimits({
      url,
      headers: { Accept: 'application/json' },
      timeoutMs: 2000,
    });
    assert.equal(result.status, REQUEST_RESULT.INVALID);
    assert.equal(result.category, REQUEST_CATEGORY.INVALID_FORMAT);
  });
});

test('a refused connection is transient network and settles quickly', async () => {
  const port = await withServer((req, res) => res.end(), async (instance) => {
    const { port: used } = instance.server.address();
    return used;
  });
  const started = performance.now();
  const result = await requestJsonWithLimits({
    url: `http://127.0.0.1:${port}/`,
    headers: {},
    timeoutMs: 2000,
  });
  assert.equal(result.status, REQUEST_RESULT.TRANSIENT);
  assert.equal(result.category, REQUEST_CATEGORY.NETWORK);
  assert.ok(performance.now() - started < 4000);
});

test('a mock json() that never resolves no longer stretches past the deadline', async () => {
  const started = performance.now();
  const result = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: {},
    timeoutMs: 20,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    }),
  });
  assert.equal(result.status, REQUEST_RESULT.TRANSIENT);
  assert.equal(result.category, REQUEST_CATEGORY.TIMEOUT);
  assert.ok(performance.now() - started < 2000);
});

test('a mock stream beyond the byte limit is cancelled proactively', async () => {
  const cancelMarker = { cancelled: false };
  const result = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: {},
    timeoutMs: 2000,
    maxBytes: 32,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: stringStream('y'.repeat(1024), { onCancel: cancelMarker }),
    }),
  });
  assert.equal(result.status, REQUEST_RESULT.INVALID);
  assert.equal(result.category, REQUEST_CATEGORY.BODY_LIMIT);
  assert.equal(cancelMarker.cancelled, true);
});

test('error, null and malformed responses are classified without leaking rejections', async () => {
  const nullResponse = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: {},
    timeoutMs: 500,
    fetchImpl: async () => null,
  });
  assert.equal(nullResponse.status, REQUEST_RESULT.INVALID);
  assert.equal(nullResponse.category, REQUEST_CATEGORY.INVALID_FORMAT);

  const throwingFetch = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: {},
    timeoutMs: 500,
    fetchImpl: () => { throw new Error('offline'); },
  });
  assert.equal(throwingFetch.status, REQUEST_RESULT.TRANSIENT);
  assert.equal(throwingFetch.category, REQUEST_CATEGORY.NETWORK);

  const throwingBody = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: {},
    timeoutMs: 500,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('truncated body'); },
    }),
  });
  assert.equal(throwingBody.status, REQUEST_RESULT.TRANSIENT);
  assert.equal(throwingBody.category, REQUEST_CATEGORY.NETWORK);
});

test('non-2xx statuses map to auth, rate_limited, server and unexpected categories', async () => {
  const cases = [
    [401, REQUEST_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [403, REQUEST_RESULT.UNAUTHORIZED, REQUEST_CATEGORY.AUTH],
    [429, REQUEST_RESULT.TRANSIENT, REQUEST_CATEGORY.RATE_LIMITED],
    [500, REQUEST_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [503, REQUEST_RESULT.TRANSIENT, REQUEST_CATEGORY.SERVER],
    [404, REQUEST_RESULT.INVALID, REQUEST_CATEGORY.UNEXPECTED_STATUS],
  ];
  for (const [status, expectedStatus, expectedCategory] of cases) {
    const result = await requestJsonWithLimits({
      url: 'https://api.kimi.com/coding/v1/usages',
      headers: {},
      timeoutMs: 500,
      fetchImpl: async () => ({ ok: status >= 200 && status < 300, status }),
    });
    assert.equal(result.status, expectedStatus, String(status));
    assert.equal(result.category, expectedCategory, String(status));
  }
});

test('Retry-After classification honors seconds, HTTP dates and invalid values', async () => {
  const NOW = 1_800_000_000_000;
  const mockResponse = (status, headerValue) => ({
    ok: false,
    status,
    headers: { get: (name) => (name === 'retry-after' ? headerValue : null) },
  });
  const seconds = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    now: NOW,
    timeoutMs: 500,
    fetchImpl: async () => mockResponse(429, '120'),
  });
  assert.equal(seconds.retryAfterSeen, true);
  assert.equal(seconds.retryAfterMs, 120_000);

  const httpDate = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    now: NOW,
    timeoutMs: 500,
    fetchImpl: async () => mockResponse(503, new Date(NOW + 60_000).toUTCString()),
  });
  assert.equal(httpDate.retryAfterSeen, true);
  assert.ok(httpDate.retryAfterMs >= 59_000 && httpDate.retryAfterMs <= 61_000);

  const invalid = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    now: NOW,
    timeoutMs: 500,
    fetchImpl: async () => mockResponse(429, 'soon'),
  });
  assert.equal(invalid.retryAfterSeen, true);
  assert.equal(invalid.retryAfterMs, null);

  const absent = await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: {},
    timeoutMs: 500,
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(absent.retryAfterSeen, false);
  assert.equal(absent.retryAfterMs, null);
});

test('the abort signal reaches the underlying fetch implementation', async () => {
  let seenSignal = null;
  await requestJsonWithLimits({
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: {},
    timeoutMs: 500,
    fetchImpl: async (_url, init) => {
      seenSignal = init.signal;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal.aborted, false);
});

test('parseRetryAfter accepts delay-seconds and HTTP dates only', () => {
  const NOW = 1_800_000_000_000;
  assert.equal(parseRetryAfter('120', NOW), 120_000);
  assert.equal(parseRetryAfter(' 30 ', NOW), 30_000);
  assert.equal(parseRetryAfter('0', NOW), 0);
  assert.equal(parseRetryAfter(new Date(NOW + 45_000).toUTCString(), NOW), 45_000);
  assert.equal(parseRetryAfter(new Date(NOW - 45_000).toUTCString(), NOW), 0);
  assert.equal(parseRetryAfter('-5', NOW), null);
  assert.equal(parseRetryAfter('1.5', NOW), null);
  assert.equal(parseRetryAfter('', NOW), null);
  assert.equal(parseRetryAfter('   ', NOW), null);
  assert.equal(parseRetryAfter(null, NOW), null);
  assert.equal(parseRetryAfter(undefined, NOW), null);
  assert.equal(parseRetryAfter('soon', NOW), null);
  assert.equal(parseRetryAfter('not a date at all', NOW), null);
  assert.equal(parseRetryAfter('9'.repeat(400), NOW), null);
});

test('refreshDelayMs doubles from the fixed base with bounded jitter and cap', () => {
  const noJitter = { jitter: () => 0 };
  assert.equal(refreshDelayMs({ failures: 1, ...noJitter }), 2_000);
  assert.equal(refreshDelayMs({ failures: 2, ...noJitter }), 4_000);
  assert.equal(refreshDelayMs({ failures: 3, ...noJitter }), 8_000);
  assert.equal(refreshDelayMs({ failures: 4, ...noJitter }), 16_000);
  assert.equal(refreshDelayMs({ failures: 30, ...noJitter }), RETRY_MAX_DELAY_MS);
  assert.equal(refreshDelayMs({ failures: 30, jitter: () => 1 }), RETRY_MAX_DELAY_MS);
  assert.equal(refreshDelayMs({ failures: 1, jitter: () => 1 }), 3_000);
  assert.equal(RETRY_JITTER_MAX_MS, 1_000);
  // Non-numeric or non-positive failure counts restart at the base.
  assert.equal(refreshDelayMs({ failures: 0, ...noJitter }), RETRY_BASE_DELAY_MS);
  assert.equal(refreshDelayMs({ failures: NaN, ...noJitter }), RETRY_BASE_DELAY_MS);
});

test('a seen Retry-After wins over the exponential schedule and is clamped', () => {
  const noJitter = { jitter: () => 0 };
  assert.equal(refreshDelayMs({ failures: 5, retryAfterSeen: true, retryAfterMs: 120_000, ...noJitter }), 120_000);
  assert.equal(refreshDelayMs({ failures: 5, retryAfterSeen: true, retryAfterMs: 0, ...noJitter }), RETRY_BASE_DELAY_MS);
  assert.equal(refreshDelayMs({ failures: 1, retryAfterSeen: true, retryAfterMs: 500, ...noJitter }), RETRY_BASE_DELAY_MS);
  assert.equal(refreshDelayMs({ failures: 1, retryAfterSeen: true, retryAfterMs: 10 ** 12, ...noJitter }), RETRY_MAX_DELAY_MS);
  // Invalid value despite a seen header falls back to the conservative base.
  assert.equal(refreshDelayMs({ failures: 5, retryAfterSeen: true, retryAfterMs: null, ...noJitter }), RETRY_BASE_DELAY_MS);
  // Without a seen header the exponential schedule applies.
  assert.equal(refreshDelayMs({ failures: 5, retryAfterSeen: false, retryAfterMs: 120_000, ...noJitter }), 32_000);
});

function tempStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-guard-state-')), 'state.json');
}

test('refresh failure state round-trips with only category, counts and times', () => {
  const statePath = tempStatePath();
  assert.equal(readRefreshState(statePath), null);
  assert.equal(isRefreshBlocked(statePath, 1_000), false);

  const recorded = recordRefreshFailure({
    statePath,
    category: REQUEST_CATEGORY.RATE_LIMITED,
    retryAfterSeen: true,
    retryAfterMs: 120_000,
    now: 5_000,
    jitter: () => 0,
  });
  assert.equal(recorded.failures, 1);
  assert.equal(recorded.nextAttemptAt, 125_000);
  assert.deepEqual(readRefreshState(statePath), {
    version: REFRESH_STATE_VERSION,
    category: REQUEST_CATEGORY.RATE_LIMITED,
    failures: 1,
    nextAttemptAt: 125_000,
    updatedAt: 5_000,
  });
  assert.equal(isRefreshBlocked(statePath, 124_999), true);
  assert.equal(isRefreshBlocked(statePath, 125_000), false);

  assert.equal(clearRefreshState(statePath), true);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(isRefreshBlocked(statePath, 1_000), false);
});

test('corrupt or foreign refresh state fails open instead of blocking forever', () => {
  for (const body of ['{broken', JSON.stringify({ version: 99, category: 'network', failures: 1, nextAttemptAt: 9e15 }), JSON.stringify({ version: 1, category: 'made-up', failures: 1, nextAttemptAt: 9e15 }), JSON.stringify({ version: 1, category: 'network', failures: -3, nextAttemptAt: 9e15 }), '']) {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, body);
    assert.equal(readRefreshState(statePath), null, body);
    assert.equal(isRefreshBlocked(statePath, 0), false, body);
  }
  assert.equal(isRefreshBlocked(undefined, 0), false);
  assert.equal(isRefreshBlocked(null, 0), false);
});

test('a context switch restarts the failure count instead of inheriting lockout', () => {
  const statePath = tempStatePath();
  recordRefreshFailure({
    statePath,
    category: REQUEST_CATEGORY.SERVER,
    now: 1_000,
    jitter: () => 0,
    contextKey: 'account-a',
  });
  const second = recordRefreshFailure({
    statePath,
    category: REQUEST_CATEGORY.SERVER,
    now: 2_000,
    jitter: () => 0,
    contextKey: 'account-a',
  });
  assert.equal(second.failures, 2);
  assert.equal(second.nextAttemptAt, 2_000 + 4_000);

  const switched = recordRefreshFailure({
    statePath,
    category: REQUEST_CATEGORY.NETWORK,
    now: 3_000,
    jitter: () => 0,
    contextKey: 'account-b',
  });
  assert.equal(switched.failures, 1);
  assert.equal(switched.nextAttemptAt, 3_000 + 2_000);
  assert.equal(switched.contextKey, 'account-b');
});

test('a foreign context lockout never blocks an attributed caller', () => {
  const statePath = tempStatePath();
  recordRefreshFailure({
    statePath,
    category: REQUEST_CATEGORY.NETWORK,
    now: 1_000,
    jitter: () => 0,
    contextKey: 'account-a',
  });
  // The scheduler compares ownership: inside A's window, account B — a
  // different credential slot or region — still refreshes.
  assert.equal(isRefreshBlocked(statePath, 1_100, 'account-b'), false);
  // The owning context honours its own window, expiring exactly on time.
  assert.equal(isRefreshBlocked(statePath, 2_999, 'account-a'), true);
  assert.equal(isRefreshBlocked(statePath, 3_000, 'account-a'), false);
  // A caller that cannot attribute itself keeps the conservative legacy gate.
  assert.equal(isRefreshBlocked(statePath, 1_100), true);
  // A legacy state file carries no context key: unprovable as foreign, so an
  // attributed caller still honours it until it expires.
  const legacyPath = tempStatePath();
  recordRefreshFailure({
    statePath: legacyPath,
    category: REQUEST_CATEGORY.NETWORK,
    now: 1_000,
    jitter: () => 0,
  });
  assert.equal(isRefreshBlocked(legacyPath, 1_100, 'account-a'), true);
});

test('a refresh state with a malformed context key reads as absent', () => {
  for (const contextKey of [42, '', null]) {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({
      version: REFRESH_STATE_VERSION,
      category: 'network',
      failures: 1,
      nextAttemptAt: 9e15,
      contextKey,
    }));
    assert.equal(readRefreshState(statePath), null, String(contextKey));
    assert.equal(isRefreshBlocked(statePath, 0, 'account-a'), false, String(contextKey));
  }
});

test('recording failures without a statePath is a no-op', () => {
  assert.equal(recordRefreshFailure({ statePath: null, now: 1 }), null);
  assert.equal(clearRefreshState(null), false);
});
