import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseQuotaPayload,
  deriveWindowLabel,
  readQuotaCache,
  isQuotaStale,
  writeQuotaCache,
  ensureFreshQuota,
  acquireQuotaLock,
  releaseQuotaLock,
  requestQuota,
  refreshQuota,
  QUOTA_RESULT,
  QUOTA_TTL_MS,
  LOCK_STALE_MS,
} from '../src/quota.mjs';

// Real response captured from GET https://api.kimi.com/coding/v1/usages
const REAL_RESPONSE = {
  usage: { limit: '100', used: '29', remaining: '71', resetTime: '2026-08-03T04:34:50Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', used: '8', remaining: '92', resetTime: '2026-07-30T12:34:50Z' },
    },
  ],
};

test('parseQuotaPayload parses the real /usages response (string numbers)', () => {
  const q = parseQuotaPayload(REAL_RESPONSE);
  assert.deepEqual(q.weekly, { used: 29, limit: 100, resetAt: '2026-08-03T04:34:50Z' });
  assert.equal(q.windows.length, 1);
  assert.deepEqual(q.windows[0], {
    label: '5h', used: 8, limit: 100, resetAt: '2026-07-30T12:34:50Z',
  });
});

test('parseQuotaPayload restores zero usage when the API omits default used fields', () => {
  const q = parseQuotaPayload({
    usage: { limit: '100', remaining: '100', resetTime: '2026-08-08T09:33:39Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', remaining: '100', resetTime: '2026-08-01T14:33:39Z' },
      },
    ],
  });
  assert.deepEqual(q.weekly, { used: 0, limit: 100, resetAt: '2026-08-08T09:33:39Z' });
  assert.deepEqual(q.windows[0], {
    label: '5h', used: 0, limit: 100, resetAt: '2026-08-01T14:33:39Z',
  });
});

test('parseQuotaPayload is lenient about detail placement', () => {
  const q = parseQuotaPayload({
    limits: [{ window: { duration: 6, timeUnit: 'TIME_UNIT_HOUR' }, used: 3, limit: 50, resetTime: 'x' }],
  });
  assert.equal(q.weekly, null);
  assert.equal(q.windows[0].label, '6h');
  assert.equal(q.windows[0].used, 3);
});

test('parseQuotaPayload rejects unusable payloads', () => {
  assert.equal(parseQuotaPayload(null), null);
  assert.equal(parseQuotaPayload({}), null);
  assert.equal(parseQuotaPayload({ usage: { used: 'abc', limit: '0' } }), null);
});

test('deriveWindowLabel maps units to short labels', () => {
  assert.equal(deriveWindowLabel({ duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }), '5h');
  assert.equal(deriveWindowLabel({ duration: 90, timeUnit: 'TIME_UNIT_MINUTE' }), '90m');
  assert.equal(deriveWindowLabel({ duration: 5, timeUnit: 'TIME_UNIT_HOUR' }), '5h');
  assert.equal(deriveWindowLabel({ duration: 48, timeUnit: 'TIME_UNIT_HOUR' }), '2d');
  assert.equal(deriveWindowLabel({ duration: 7, timeUnit: 'TIME_UNIT_DAY' }), '7d');
  assert.equal(deriveWindowLabel({ duration: 0, timeUnit: 'TIME_UNIT_DAY' }), null);
  assert.equal(deriveWindowLabel(null), null);
});

test('cache round-trip and staleness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-'));
  const cachePath = path.join(dir, 'quota.json');
  assert.equal(readQuotaCache(cachePath), null);
  assert.equal(isQuotaStale(null), true);

  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath);
  const cache = readQuotaCache(cachePath);
  assert.equal(cache.weekly.used, 29);
  assert.equal(cache.windows[0].label, '5h');
  assert.equal(typeof cache.fetchedAt, 'number');
  assert.equal(isQuotaStale(cache, cache.fetchedAt + QUOTA_TTL_MS - 1), false);
  assert.equal(isQuotaStale(cache, cache.fetchedAt + QUOTA_TTL_MS + 1), true);
});

test('readQuotaCache tolerates corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-'));
  const cachePath = path.join(dir, 'quota.json');
  fs.writeFileSync(cachePath, '{broken');
  assert.equal(readQuotaCache(cachePath), null);
});

test('refreshQuota drops the stale cache when credentials are gone (/logout)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-'));
  const cachePath = path.join(dir, 'quota.json');
  const lockPath = path.join(dir, 'refresh.lock');
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath);

  const ok = await refreshQuota({
    credentialsPath: path.join(dir, 'missing-credentials.json'),
    cachePath,
    lockPath,
  });
  assert.equal(ok, false);
  assert.equal(fs.existsSync(cachePath), false);
  assert.equal(fs.existsSync(lockPath), false); // lock always released
});

test('refreshQuota drops the stale cache when the token is missing or corrupt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-'));
  const cachePath = path.join(dir, 'quota.json');
  const lockPath = path.join(dir, 'refresh.lock');
  const credentialsPath = path.join(dir, 'creds.json');

  for (const body of [JSON.stringify({ refresh_token: 'x' }), '{broken']) {
    fs.writeFileSync(credentialsPath, body);
    writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath);
    const ok = await refreshQuota({ credentialsPath, cachePath, lockPath });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(cachePath), false);
  }
});

function response(status, body = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('refreshQuota clears stale cache on 401 and 403 once the refresh_token is gone', async () => {
  for (const status of [401, 403]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-auth-'));
    const credentialsPath = path.join(dir, 'credentials.json');
    const cachePath = path.join(dir, 'quota.json');
    // No refresh_token: the /logout shape, so the cache must go too.
    fs.writeFileSync(credentialsPath, JSON.stringify({ access_token: 'redacted' }));
    writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath);
    const ok = await refreshQuota({
      credentialsPath,
      cachePath,
      lockPath: path.join(dir, 'refresh.lock'),
      fetchImpl: async () => response(status),
    });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(cachePath), false);
  }
});

test('refreshQuota keeps the stale cache on 401/403 while a refresh_token remains', async () => {
  // An idle session's on-disk access_token is often expired (the CLI refreshes
  // lazily), which earns the same 401 as /logout. With a refresh_token present
  // the account is still logged in, so the last good cache must survive.
  for (const status of [401, 403]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-expired-'));
    const credentialsPath = path.join(dir, 'credentials.json');
    const cachePath = path.join(dir, 'quota.json');
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({ access_token: 'redacted', refresh_token: 'redacted' }),
    );
    writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath);
    const ok = await refreshQuota({
      credentialsPath,
      cachePath,
      lockPath: path.join(dir, 'refresh.lock'),
      fetchImpl: async () => response(status),
    });
    assert.equal(ok, false);
    assert.notEqual(readQuotaCache(cachePath), null);
  }
});

test('refreshQuota preserves stale cache for transient failures', async () => {
  const cases = [
    async () => response(429),
    async () => response(503),
    async () => { throw new Error('network down'); },
  ];
  for (const fetchImpl of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-transient-'));
    const credentialsPath = path.join(dir, 'credentials.json');
    const cachePath = path.join(dir, 'quota.json');
    fs.writeFileSync(credentialsPath, JSON.stringify({ access_token: 'redacted' }));
    writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath);
    const ok = await refreshQuota({
      credentialsPath,
      cachePath,
      lockPath: path.join(dir, 'refresh.lock'),
      fetchImpl,
    });
    assert.equal(ok, false);
    assert.notEqual(readQuotaCache(cachePath), null);
  }
});

test('refreshQuota preserves stale cache when the request times out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-timeout-'));
  const credentialsPath = path.join(dir, 'credentials.json');
  const cachePath = path.join(dir, 'quota.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({ access_token: 'redacted' }));
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath);
  const fetchImpl = async () => new Promise(() => {});
  const ok = await refreshQuota({
    credentialsPath,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
    timeoutMs: 5,
    fetchImpl,
  });
  assert.equal(ok, false);
  assert.notEqual(readQuotaCache(cachePath), null);
});

test('requestQuota classifies success and refuses non-official credential targets', async () => {
  const success = await requestQuota({
    token: 'redacted',
    fetchImpl: async () => response(200, REAL_RESPONSE),
  });
  assert.equal(success.status, QUOTA_RESULT.SUCCESS);
  assert.equal(success.parsed.weekly.used, 29);

  let called = false;
  const invalid = await requestQuota({
    token: 'redacted',
    url: 'https://example.com/coding/v1/usages',
    fetchImpl: async () => { called = true; return response(200, REAL_RESPONSE); },
  });
  assert.equal(invalid.status, QUOTA_RESULT.INVALID);
  assert.equal(called, false);
});

test('atomic quota lock allows only one detached refresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-lock-'));
  const lockPath = path.join(dir, 'refresh.lock');
  let spawned = 0;
  const spawnImpl = () => {
    spawned += 1;
    return { once() {}, unref() {} };
  };
  const opts = {
    cachePath: path.join(dir, 'missing-cache.json'),
    lockPath,
    scriptPath: '/tmp/fake-kimi-hud.mjs',
    now: 1000,
    spawnImpl,
    tokenFactory: () => 'fixed',
  };
  assert.equal(ensureFreshQuota(opts), true);
  assert.equal(ensureFreshQuota(opts), false);
  assert.equal(spawned, 1);
});

test('quota lock cleanup is ownership-safe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-owner-'));
  const lockPath = path.join(dir, 'refresh.lock');
  const token = acquireQuotaLock({ lockPath, now: 1000, token: 'new-owner' });
  assert.equal(token, 'new-owner');
  assert.equal(releaseQuotaLock(lockPath, 'old-owner'), false);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(releaseQuotaLock(lockPath, 'new-owner'), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('parseQuotaPayload clamps bonus quota (remaining > limit) to zero usage', () => {
  const q = parseQuotaPayload({
    usage: { limit: '100', remaining: '150', resetTime: '2026-08-08T09:33:39Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', remaining: '120', resetTime: '2026-08-01T14:33:39Z' },
      },
    ],
  });
  assert.deepEqual(q.weekly, { used: 0, limit: 100, resetAt: '2026-08-08T09:33:39Z' });
  assert.deepEqual(q.windows[0], {
    label: '5h', used: 0, limit: 100, resetAt: '2026-08-01T14:33:39Z',
  });
});

test('parseQuotaPayload still rejects negative remaining (fail-closed)', () => {
  assert.equal(parseQuotaPayload({ usage: { limit: '100', remaining: '-5' } }), null);
  assert.equal(parseQuotaPayload({
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, remaining: -1 } }],
  }), null);
});

test('acquireQuotaLock collects a stale lock and re-acquires atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-stale-'));
  const lockPath = path.join(dir, 'refresh.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, at: 1000, token: 'old-owner' }));
  const now = 1000 + LOCK_STALE_MS + 1;
  assert.equal(acquireQuotaLock({ lockPath, now, token: 'new-owner' }), 'new-owner');
  // Stale lock was renamed aside and unlinked: no leftovers, lock content
  // appears complete and owned by the new token.
  assert.deepEqual(fs.readdirSync(dir), ['refresh.lock']);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), {
    pid: process.pid, at: now, token: 'new-owner',
  });
});

test('acquireQuotaLock collects a corrupt lock and re-acquires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-corrupt-'));
  const lockPath = path.join(dir, 'refresh.lock');
  fs.writeFileSync(lockPath, '{broken');
  assert.equal(acquireQuotaLock({ lockPath, now: 1000, token: 'new-owner' }), 'new-owner');
  assert.deepEqual(fs.readdirSync(dir), ['refresh.lock']);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'new-owner');
});

test('acquireQuotaLock fails closed when the stale-lock rename loses the race', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-rename-'));
  const lockPath = path.join(dir, 'refresh.lock');
  const staleBody = JSON.stringify({ pid: 1, at: 1000, token: 'old-owner' });
  fs.writeFileSync(lockPath, staleBody);
  // A non-empty directory at the rename target makes renameSync throw,
  // simulating a competing process that is still handling the stale lock.
  const blocker = `${lockPath}.stale-blocked`;
  fs.mkdirSync(blocker);
  fs.writeFileSync(path.join(blocker, 'held'), 'x');
  const now = 1000 + LOCK_STALE_MS + 1;
  assert.equal(acquireQuotaLock({ lockPath, now, token: 'blocked' }), null);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), staleBody); // stale lock untouched
  fs.rmSync(blocker, { recursive: true });
  assert.equal(acquireQuotaLock({ lockPath, now, token: 'winner' }), 'winner');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'winner');
});
