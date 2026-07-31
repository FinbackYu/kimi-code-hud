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
  refreshQuota,
  QUOTA_TTL_MS,
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
