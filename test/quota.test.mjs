import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { REQUEST_CATEGORY, shortDigest, readRefreshState, recordRefreshFailure } from '../src/request-guard.mjs';
import {
  parseQuotaPayload,
  deriveWindowLabel,
  readQuotaCache,
  isQuotaStale,
  quotaAge,
  QUOTA_AGE,
  writeQuotaCache,
  ensureFreshQuota,
  acquireQuotaLock,
  releaseQuotaLock,
  requestQuota,
  refreshQuota,
  resolveQuotaEndpoints,
  resolveQuotaContextKey,
  quotaContextKeyFor,
  quotaCacheMatchesContext,
  credentialFileFingerprint,
  CREDENTIAL_FINGERPRINT_ABSENT,
  QUOTA_RESULT,
  QUOTA_TTL_MS,
  QUOTA_CACHE_VERSION,
  QUOTA_STALE_MAX_MS,
  QUOTA_CLOCK_SKEW_MS,
  LOCK_STALE_MS,
  USAGES_URL,
  GLOBAL_USAGES_URL,
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

// Any valid 16-hex tag works for shape-level tests.
const DUMMY_CONTEXT_KEY = '0123456789abcdef';

// The mainland default slot for a temp kimi-home, keyed the same way the
// resolver keys it: credential path + endpoint + content fingerprint (the
// sentinel when the file is absent), so seeded caches share one attributable
// context with the refresh flows under test.
function mainlandContextKey(kimiHome) {
  const credentialsPath = path.join(kimiHome, 'credentials', 'kimi-code.json');
  return quotaContextKeyFor(
    credentialsPath,
    USAGES_URL,
    credentialFileFingerprint(credentialsPath),
  );
}

/** Seed a schema-v2 cache tagged for the temp kimi-home's mainland slot. */
function seedCache(kimiHome, cachePath, parsed = parseQuotaPayload(REAL_RESPONSE)) {
  return writeQuotaCache(parsed, cachePath, {
    contextKey: mainlandContextKey(kimiHome),
  });
}

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

test('parseQuotaPayload treats a JSON-null used as unset and derives it from remaining', () => {
  // The review's synthetic shape: used is present-but-null. Number(null)
  // would coerce it to a fabricated 0; with remaining reported the intended
  // fallback derives 100 - 20 = 80 instead. Upstream documents used as an
  // always-present decimal string, so this pins local tolerance, not a
  // server contract.
  const q = parseQuotaPayload({
    usage: { limit: 100, used: null, remaining: 20, resetTime: '2026-08-08T09:33:39Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: 100, used: null, remaining: 20, resetTime: '2026-08-01T14:33:39Z' },
      },
    ],
  });
  assert.deepEqual(q.weekly, { used: 80, limit: 100, resetAt: '2026-08-08T09:33:39Z' });
  assert.deepEqual(q.windows[0], {
    label: '5h', used: 80, limit: 100, resetAt: '2026-08-01T14:33:39Z',
  });
});

test('parseQuotaPayload fails closed when used is null and no remaining is reported', () => {
  // Without remaining there is no way to recover a real used value; the row
  // is dropped rather than shown as a fabricated zero.
  assert.equal(parseQuotaPayload({ usage: { limit: 100, used: null } }), null);
  assert.equal(
    parseQuotaPayload({
      usage: { limit: 100, used: '0' }, // an explicit zero still parses
    }).weekly.used,
    0,
  );
  // Empty/whitespace string used is likewise "not reported".
  const q = parseQuotaPayload({
    usage: { limit: 100, used: '  ', remaining: 25, resetTime: '2026-08-08T09:33:39Z' },
  });
  assert.deepEqual(q.weekly, { used: 75, limit: 100, resetAt: '2026-08-08T09:33:39Z' });
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

  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath, {
    contextKey: DUMMY_CONTEXT_KEY,
  });
  const cache = readQuotaCache(cachePath);
  assert.equal(cache.version, QUOTA_CACHE_VERSION);
  assert.equal(cache.contextKey, DUMMY_CONTEXT_KEY);
  assert.equal(cache.weekly.used, 29);
  assert.equal(cache.windows[0].label, '5h');
  assert.equal(typeof cache.fetchedAt, 'number');
  assert.equal(isQuotaStale(cache, cache.fetchedAt + QUOTA_TTL_MS - 1), false);
  assert.equal(isQuotaStale(cache, cache.fetchedAt + QUOTA_TTL_MS + 1), true);
});

test('quotaAge draws the fresh/stale/expired boundaries exactly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-age-'));
  const cachePath = path.join(dir, 'quota.json');
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath, {
    now: 100_000,
    contextKey: DUMMY_CONTEXT_KEY,
  });
  const cache = readQuotaCache(cachePath);
  // fresh: up to and including the TTL.
  assert.equal(quotaAge(cache, 100_000 + QUOTA_TTL_MS).state, QUOTA_AGE.FRESH);
  // stale: past the TTL, up to and including the one-week ceiling.
  assert.equal(quotaAge(cache, 100_000 + QUOTA_TTL_MS + 1).state, QUOTA_AGE.STALE);
  assert.equal(quotaAge(cache, 100_000 + QUOTA_STALE_MAX_MS).state, QUOTA_AGE.STALE);
  // expired: past the ceiling, and for absent/invalid caches.
  assert.equal(quotaAge(cache, 100_000 + QUOTA_STALE_MAX_MS + 1).state, QUOTA_AGE.EXPIRED);
  assert.equal(quotaAge(null).state, QUOTA_AGE.EXPIRED);
  assert.equal(quotaAge({ fetchedAt: 'nope' }).state, QUOTA_AGE.EXPIRED);
});

test('quotaAge treats near-future stamps as fresh and far-future as expired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-future-'));
  const cachePath = path.join(dir, 'quota.json');
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath, {
    now: 100_000,
    contextKey: DUMMY_CONTEXT_KEY,
  });
  const cache = readQuotaCache(cachePath);
  // A clock step forward inside the skew allowance does not hide the cache.
  assert.equal(quotaAge(cache, 100_000 - QUOTA_CLOCK_SKEW_MS).state, QUOTA_AGE.FRESH);
  assert.equal(isQuotaStale(cache, 100_000 - QUOTA_CLOCK_SKEW_MS), false);
  // A stamp further in the future (clock rolled back) is untrusted: expired
  // for display and stale for the scheduler so a refresh re-stamps it.
  assert.equal(quotaAge(cache, 100_000 - QUOTA_CLOCK_SKEW_MS - 1).state, QUOTA_AGE.EXPIRED);
  assert.equal(isQuotaStale(cache, 100_000 - QUOTA_CLOCK_SKEW_MS - 1), true);
});

test('readQuotaCache ignores legacy and untagged caches until a refresh re-tags them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-legacy-'));
  const cachePath = path.join(dir, 'quota.json');
  // Pre-H02 schema: fetchedAt only, no version, no contextKey.
  fs.writeFileSync(cachePath, JSON.stringify({
    fetchedAt: Date.now(),
    weekly: parseQuotaPayload(REAL_RESPONSE).weekly,
    windows: parseQuotaPayload(REAL_RESPONSE).windows,
  }));
  assert.equal(readQuotaCache(cachePath), null); // not current quota
  assert.equal(isQuotaStale(null), true);

  for (const body of [
    { version: QUOTA_CACHE_VERSION, fetchedAt: 1, weekly: null, windows: [] }, // no tag
    { version: QUOTA_CACHE_VERSION, contextKey: 'NOT_HEX', fetchedAt: 1 },
    { version: 1, contextKey: DUMMY_CONTEXT_KEY, fetchedAt: 1 },
  ]) {
    fs.writeFileSync(cachePath, JSON.stringify(body));
    assert.equal(readQuotaCache(cachePath), null, JSON.stringify(body));
  }
});

test('writeQuotaCache refuses to persist an unattributed cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-tag-'));
  const cachePath = path.join(dir, 'quota.json');
  assert.equal(writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath), false);
  assert.equal(writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath, {
    contextKey: 'xyz',
  }), false);
  assert.equal(fs.existsSync(cachePath), false);
  assert.equal(writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath, {
    contextKey: DUMMY_CONTEXT_KEY,
  }), true);
  assert.notEqual(readQuotaCache(cachePath), null);
});

test('context tag and match helpers isolate credential slot and region', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-ctx-'));
  const cachePath = path.join(dir, 'quota.json');
  const mainland = resolveQuotaContextKey({ env: {}, configText: '', kimiHome: dir });
  assert.match(mainland, /^[0-9a-f]{16}$/);
  const globalKey = resolveQuotaContextKey({
    env: {},
    configText: globalConfigText(scopedOAuthKey(GLOBAL_OAUTH_HOST, GLOBAL_BASE_URL)),
    kimiHome: dir,
  });
  assert.notEqual(globalKey, mainland);

  const cache = parseQuotaPayload(REAL_RESPONSE);
  writeQuotaCache(cache, cachePath, { contextKey: mainland });
  const stored = readQuotaCache(cachePath);
  assert.equal(quotaCacheMatchesContext(stored, mainland), true);
  assert.equal(quotaCacheMatchesContext(stored, globalKey), false);
  assert.equal(quotaCacheMatchesContext(null, mainland), false);
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
  const kimiHome = makeKimiHome(dir);
  seedCache(kimiHome, cachePath);

  const ok = await refreshQuota({
    credentialsPath: path.join(kimiHome, 'credentials', 'kimi-code.json'),
    url: USAGES_URL,
    cachePath,
    lockPath,
    env: {},
    configText: '',
    kimiHome,
  });
  assert.equal(ok, false);
  assert.equal(fs.existsSync(cachePath), false);
  assert.equal(fs.existsSync(lockPath), false); // lock always released
});

test('refreshQuota drops the stale cache when the token is missing or corrupt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-'));
  const cachePath = path.join(dir, 'quota.json');
  const lockPath = path.join(dir, 'refresh.lock');
  const kimiHome = makeKimiHome(dir);
  const credentialsPath = path.join(kimiHome, 'credentials', 'kimi-code.json');

  for (const body of [JSON.stringify({ refresh_token: 'x' }), '{broken']) {
    fs.writeFileSync(credentialsPath, body);
    seedCache(kimiHome, cachePath);
    const ok = await refreshQuota({
      credentialsPath,
      url: USAGES_URL,
      cachePath,
      lockPath,
      env: {},
      configText: '',
      kimiHome,
    });
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
    const env = failureEnv(dir); // access_token only: the /logout shape
    seedCache(env.kimiHome, env.cachePath);
    const ok = await refreshQuota({
      ...env,
      fetchImpl: async () => response(status),
    });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(env.cachePath), false);
  }
});

test('refreshQuota keeps the stale cache on 401/403 while a refresh_token remains', async () => {
  // An idle session's on-disk access_token is often expired (the CLI refreshes
  // lazily), which earns the same 401 as /logout. With a refresh_token present
  // the account is still logged in, so the last good cache must survive.
  for (const status of [401, 403]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-expired-'));
    const env = failureEnv(dir, { refreshToken: 'redacted' });
    seedCache(env.kimiHome, env.cachePath);
    const ok = await refreshQuota({
      ...env,
      fetchImpl: async () => response(status),
    });
    assert.equal(ok, false);
    assert.notEqual(readQuotaCache(env.cachePath), null);
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
    const env = failureEnv(dir);
    seedCache(env.kimiHome, env.cachePath);
    const ok = await refreshQuota({ ...env, fetchImpl });
    assert.equal(ok, false);
    assert.notEqual(readQuotaCache(env.cachePath), null);
  }
});

test('refreshQuota preserves stale cache when the request times out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-timeout-'));
  const env = failureEnv(dir);
  seedCache(env.kimiHome, env.cachePath);
  const fetchImpl = async () => new Promise(() => {});
  const ok = await refreshQuota({ ...env, timeoutMs: 5, fetchImpl });
  assert.equal(ok, false);
  assert.notEqual(readQuotaCache(env.cachePath), null);
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

// --- Dual-region (0.38.0) endpoint resolution -------------------------------

// Upstream scoped-slot derivation (packages/oauth/src/managed-kimi-code.ts):
// sha256(JSON.stringify({ oauthHost, baseUrl })) first 16 hex chars.
function scopedOAuthKey(oauthHost, baseUrl) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ oauthHost, baseUrl }))
    .digest('hex')
    .slice(0, 16);
  return `oauth/kimi-code-env-${digest}`;
}

const GLOBAL_OAUTH_HOST = 'https://auth.kimi.ai';
const GLOBAL_BASE_URL = 'https://api.kimi.ai/coding/v1';

function globalConfigText(key) {
  return `[providers."managed:kimi-code"]\n`
    + `type = "kimi"\n`
    + `base_url = "${GLOBAL_BASE_URL}"\n`
    + `api_key = ""\n`
    + `\n[providers."managed:kimi-code".oauth]\n`
    + `storage = "file"\n`
    + `key = "${key}"\n`
    + `oauth_host = "${GLOBAL_OAUTH_HOST}"\n`;
}

function makeKimiHome(dir) {
  const kimiHome = path.join(dir, 'kimi-home');
  fs.mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
  return kimiHome;
}

test('global-region login resolves to api.kimi.ai with its scoped credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-global-'));
  const kimiHome = makeKimiHome(dir);
  const key = scopedOAuthKey(GLOBAL_OAUTH_HOST, GLOBAL_BASE_URL);
  const scopedPath = path.join(kimiHome, 'credentials', `${key.slice('oauth/'.length)}.json`);
  fs.writeFileSync(scopedPath, JSON.stringify({
    access_token: 'fake-global-access-token',
    refresh_token: 'fake-global-refresh-token',
  }));

  const endpoints = resolveQuotaEndpoints({ env: {}, configText: globalConfigText(key), kimiHome });
  assert.equal(endpoints.url, GLOBAL_USAGES_URL);
  assert.equal(endpoints.credentialsPath, scopedPath);

  const calls = [];
  const cachePath = path.join(dir, 'quota.json');
  const ok = await refreshQuota({
    ...endpoints,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
    env: {},
    configText: globalConfigText(key),
    kimiHome,
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return response(200, REAL_RESPONSE);
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ url: GLOBAL_USAGES_URL, auth: 'Bearer fake-global-access-token' }]);
  const cache = readQuotaCache(cachePath);
  assert.equal(cache.weekly.used, 29);
  assert.equal(
    cache.contextKey,
    quotaContextKeyFor(scopedPath, GLOBAL_USAGES_URL, credentialFileFingerprint(scopedPath)),
  );
});

test('a managed provider without an oauth table keeps the mainland default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-default-'));
  const kimiHome = makeKimiHome(dir);
  const defaultPath = path.join(kimiHome, 'credentials', 'kimi-code.json');
  fs.writeFileSync(defaultPath, JSON.stringify({ access_token: 'fake-access-token' }));
  const configText = `[providers."managed:kimi-code"]\n`
    + `type = "kimi"\n`
    + `base_url = "https://api.kimi.com/coding/v1"\n`;

  const endpoints = resolveQuotaEndpoints({ env: {}, configText, kimiHome });
  assert.equal(endpoints.url, USAGES_URL);
  assert.equal(endpoints.credentialsPath, defaultPath);

  const calls = [];
  const ok = await refreshQuota({
    ...endpoints,
    cachePath: path.join(dir, 'quota.json'),
    lockPath: path.join(dir, 'refresh.lock'),
    env: {},
    configText,
    kimiHome,
    fetchImpl: async (url) => { calls.push(url); return response(200, REAL_RESPONSE); },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [USAGES_URL]);
});

test('a persisted mainland login (default key, no oauth_host) stays on the default slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-mainland-'));
  const kimiHome = makeKimiHome(dir);
  const configText = `[providers."managed:kimi-code"]\n`
    + `base_url = "https://api.kimi.com/coding/v1"\n`
    + `\n[providers."managed:kimi-code".oauth]\n`
    + `storage = "file"\n`
    + `key = "oauth/kimi-code"\n`;
  const endpoints = resolveQuotaEndpoints({ env: {}, configText, kimiHome });
  assert.equal(endpoints.url, USAGES_URL);
  assert.equal(endpoints.credentialsPath, path.join(kimiHome, 'credentials', 'kimi-code.json'));
});

test('resolveQuotaEndpoints defaults to mainland when config.toml is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-noconfig-'));
  const kimiHome = makeKimiHome(dir);
  const endpoints = resolveQuotaEndpoints({
    env: {},
    configPath: path.join(dir, 'missing-config.toml'),
    kimiHome,
  });
  assert.equal(endpoints.url, USAGES_URL);
  assert.equal(endpoints.credentialsPath, path.join(kimiHome, 'credentials', 'kimi-code.json'));
});

test('custom or unknown hosts and base URLs fail closed to the mainland default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-failclosed-'));
  const kimiHome = makeKimiHome(dir);
  const fallback = {
    credentialsPath: path.join(kimiHome, 'credentials', 'kimi-code.json'),
    url: USAGES_URL,
  };
  const evilConfigs = [
    `[providers."managed:kimi-code"]\nbase_url = "https://evil.example.com/coding/v1"\n`,
    `[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.com.evil.com/coding/v1"\n`,
    `[providers."managed:kimi-code"]\nbase_url = "http://api.kimi.ai/coding/v1"\n`,
    globalConfigText('oauth/kimi-code-env-0123456789abcdef')
      .replace(GLOBAL_OAUTH_HOST, 'https://auth.evil.example.com'),
    // Contradictory hand config: global oauth_host with a mainland base_url.
    `[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.com/coding/v1"\n`
      + `\n[providers."managed:kimi-code".oauth]\n`
      + `key = "oauth/kimi-code"\n`
      + `oauth_host = "${GLOBAL_OAUTH_HOST}"\n`,
  ];
  for (const configText of evilConfigs) {
    assert.deepEqual(resolveQuotaEndpoints({ env: {}, configText, kimiHome }), fallback);
  }
  assert.deepEqual(
    resolveQuotaEndpoints({
      env: { KIMI_CODE_OAUTH_HOST: 'https://auth.evil.example.com' },
      configText: '',
      kimiHome,
    }),
    fallback,
  );
});

test('an evil base_url never receives a token; the fallback only calls the official URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-evil-'));
  const kimiHome = makeKimiHome(dir);
  fs.writeFileSync(
    path.join(kimiHome, 'credentials', 'kimi-code.json'),
    JSON.stringify({ access_token: 'fake-access-token' }),
  );
  const configText = `[providers."managed:kimi-code"]\nbase_url = "https://evil.example.com/coding/v1"\n`;
  const endpoints = resolveQuotaEndpoints({ env: {}, configText, kimiHome });
  const calls = [];
  const ok = await refreshQuota({
    ...endpoints,
    cachePath: path.join(dir, 'quota.json'),
    lockPath: path.join(dir, 'refresh.lock'),
    env: {},
    configText,
    kimiHome,
    fetchImpl: async (url) => { calls.push(url); return response(200, REAL_RESPONSE); },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [USAGES_URL]); // never https://evil.example.com/...
});

test('an evil config without fallback credentials performs no request and writes no cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-evil-nocreds-'));
  const kimiHome = makeKimiHome(dir);
  const configText = `[providers."managed:kimi-code"]\nbase_url = "https://evil.example.com/coding/v1"\n`;
  const endpoints = resolveQuotaEndpoints({ env: {}, configText, kimiHome });
  let called = false;
  const cachePath = path.join(dir, 'quota.json');
  const ok = await refreshQuota({
    ...endpoints,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
    env: {},
    configText,
    kimiHome,
    fetchImpl: async () => { called = true; return response(200, REAL_RESPONSE); },
  });
  assert.equal(ok, false);
  assert.equal(called, false);
  assert.equal(fs.existsSync(cachePath), false);
});

test('a scoped oauth key whose credential file is missing is treated as logged out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-scoped-missing-'));
  const kimiHome = makeKimiHome(dir);
  const key = scopedOAuthKey(GLOBAL_OAUTH_HOST, GLOBAL_BASE_URL);
  const configText = globalConfigText(key);
  const endpoints = resolveQuotaEndpoints({ env: {}, configText, kimiHome });
  assert.equal(endpoints.url, GLOBAL_USAGES_URL);

  let called = false;
  const cachePath = path.join(dir, 'quota.json');
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath, {
    contextKey: quotaContextKeyFor(endpoints.credentialsPath, endpoints.url),
  });
  const ok = await refreshQuota({
    ...endpoints,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
    env: {},
    configText,
    kimiHome,
    fetchImpl: async () => { called = true; return response(200, REAL_RESPONSE); },
  });
  assert.equal(ok, false);
  assert.equal(called, false);
  assert.equal(fs.existsSync(cachePath), false); // stale cache dropped
});

test('a malformed config.toml falls back to the default endpoints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-malformed-'));
  const kimiHome = makeKimiHome(dir);
  const fallback = {
    credentialsPath: path.join(kimiHome, 'credentials', 'kimi-code.json'),
    url: USAGES_URL,
  };
  const malformed = [
    '[providers."managed:kimi-code"\nbase_url = ',
    'not toml at all {{{',
    `[providers."managed:kimi-code"]\nbase_url = "unterminated`,
  ];
  for (const configText of malformed) {
    assert.deepEqual(resolveQuotaEndpoints({ env: {}, configText, kimiHome }), fallback);
  }
});

test('missing or abnormal oauth keys fall back to the default credential slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-keys-'));
  const kimiHome = makeKimiHome(dir);
  const defaultCreds = path.join(kimiHome, 'credentials', 'kimi-code.json');
  const abnormal = [
    'oauth/../../etc/passwd',
    'oauth/kimi-code-env-xyz',
    'oauth/kimi-code-env-0123456789ABCDEF', // upstream digests are lowercase
    'oauth/kimi-code.json',
    'kimi-code',
    'oauth/',
  ];
  for (const key of abnormal) {
    const configText = `[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "${key}"\n`;
    assert.equal(
      resolveQuotaEndpoints({ env: {}, configText, kimiHome }).credentialsPath,
      defaultCreds,
      key,
    );
  }
});

test('requestQuota only sends tokens to the two official usages URLs', async () => {
  const rejected = [
    'https://api.kimi.com.evil.com/coding/v1/usages',
    'https://sub.api.kimi.com/coding/v1/usages',
    'https://evil.example.com/coding/v1/usages',
    'http://api.kimi.ai/coding/v1/usages',
    'https://user:pass@api.kimi.ai/coding/v1/usages',
    'https://api.kimi.ai@evil.example.com/coding/v1/usages',
    'https://api.kimi.com:8443/coding/v1/usages',
    'https://api.kimi.com/coding/v1/usages/extra',
  ];
  for (const url of rejected) {
    let called = false;
    const result = await requestQuota({
      token: 'fake-access-token',
      url,
      fetchImpl: async () => { called = true; return response(200, REAL_RESPONSE); },
    });
    assert.equal(result.status, QUOTA_RESULT.INVALID, url);
    assert.equal(called, false, url);
  }
  for (const url of [USAGES_URL, GLOBAL_USAGES_URL]) {
    let seen = null;
    const result = await requestQuota({
      token: 'fake-access-token',
      url,
      fetchImpl: async (u) => { seen = u; return response(200, REAL_RESPONSE); },
    });
    assert.equal(result.status, QUOTA_RESULT.SUCCESS, url);
    assert.equal(seen, url);
  }
});

test('env KIMI_CODE_OAUTH_HOST / KIMI_OAUTH_HOST pin the global region without config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-env-'));
  const kimiHome = makeKimiHome(dir);
  const defaultCreds = path.join(kimiHome, 'credentials', 'kimi-code.json');
  for (const env of [
    { KIMI_CODE_OAUTH_HOST: GLOBAL_OAUTH_HOST },
    { KIMI_OAUTH_HOST: GLOBAL_OAUTH_HOST },
    { KIMI_CODE_OAUTH_HOST: `${GLOBAL_OAUTH_HOST}/` }, // trailing slash tolerated
  ]) {
    const endpoints = resolveQuotaEndpoints({ env, configText: '', kimiHome });
    assert.equal(endpoints.url, GLOBAL_USAGES_URL);
    assert.equal(endpoints.credentialsPath, defaultCreds);
  }
  // An env base-URL override is honored only when it is an official one.
  assert.equal(
    resolveQuotaEndpoints({
      env: { KIMI_CODE_BASE_URL: GLOBAL_BASE_URL },
      configText: '',
      kimiHome,
    }).url,
    GLOBAL_USAGES_URL,
  );
  assert.equal(
    resolveQuotaEndpoints({
      env: { KIMI_CODE_BASE_URL: 'https://evil.example.com/coding/v1' },
      configText: '',
      kimiHome,
    }).url,
    USAGES_URL,
  );
});

test('requestQuota keeps the deadline across a response body that never resolves', async () => {
  const started = performance.now();
  const result = await requestQuota({
    token: 'fake-access-token',
    timeoutMs: 20,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    }),
  });
  const elapsed = performance.now() - started;
  assert.equal(result.status, QUOTA_RESULT.TRANSIENT);
  assert.equal(result.category, REQUEST_CATEGORY.TIMEOUT);
  assert.ok(elapsed < 2000, `request settled in ${elapsed}ms`);
});

test('requestQuota cancels a real stream that exceeds the body ceiling', async () => {
  const cancelMarker = { cancelled: false };
  const result = await requestQuota({
    token: 'fake-access-token',
    maxBytes: 32,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        },
        cancel() { cancelMarker.cancelled = true; },
      }),
    }),
  });
  assert.equal(result.status, QUOTA_RESULT.INVALID);
  assert.equal(result.category, REQUEST_CATEGORY.BODY_LIMIT);
  assert.equal(cancelMarker.cancelled, true);
});

test('requestQuota surfaces Retry-After facts on 429 responses', async () => {
  const seconds = await requestQuota({
    token: 'fake-access-token',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? '120' : null) },
    }),
  });
  assert.equal(seconds.status, QUOTA_RESULT.TRANSIENT);
  assert.equal(seconds.category, REQUEST_CATEGORY.RATE_LIMITED);
  assert.equal(seconds.retryAfterSeen, true);
  assert.equal(seconds.retryAfterMs, 120_000);

  const invalid = await requestQuota({
    token: 'fake-access-token',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? 'soon' : null) },
    }),
  });
  assert.equal(invalid.retryAfterSeen, true);
  assert.equal(invalid.retryAfterMs, null);
});

test('requestQuota releases the connection for non-2xx error bodies', async () => {
  const cancelMarker = { cancelled: false };
  const result = await requestQuota({
    token: 'fake-access-token',
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('busy')); },
        cancel() { cancelMarker.cancelled = true; },
      }),
    }),
  });
  assert.equal(result.status, QUOTA_RESULT.TRANSIENT);
  assert.equal(result.category, REQUEST_CATEGORY.SERVER);
  assert.equal(cancelMarker.cancelled, true);
});

// --- Failure backoff (H04) ---------------------------------------------------

/**
 * A hermetic mainland-default refresh context: a temp kimi-home holding
 * `credentials/kimi-code.json`, an empty config text (which re-resolves to
 * that same default slot and `api.kimi.com`), and per-call cache / lock /
 * backoff-state files. The request context and the write-time revalidation
 * context therefore always agree.
 */
function failureEnv(dir, { token = 'fake-access-token', refreshToken = null } = {}) {
  const kimiHome = makeKimiHome(dir);
  const credentialsPath = path.join(kimiHome, 'credentials', 'kimi-code.json');
  const body = { access_token: token };
  if (refreshToken !== null) body.refresh_token = refreshToken;
  fs.writeFileSync(credentialsPath, JSON.stringify(body));
  return {
    env: {},
    kimiHome,
    configText: '',
    credentialsPath,
    url: USAGES_URL,
    cachePath: path.join(dir, 'quota.json'),
    lockPath: path.join(dir, 'refresh.lock'),
    statePath: path.join(dir, 'quota-refresh-state.json'),
  };
}

const statusResponse = (status, headers) => ({
  ok: status >= 200 && status < 300,
  status,
  ...(headers ? { headers } : {}),
});

test('refreshQuota persists 429 backoff with Retry-After honored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-backoff-'));
  const env = failureEnv(dir);
  const ok = await refreshQuota({
    ...env,
    now: 50_000,
    clock: () => 50_000, // instantaneous failure: the clock never advances
    jitter: () => 0,
    fetchImpl: async () => statusResponse(429, {
      get: (name) => (name === 'retry-after' ? '120' : null),
    }),
  });
  assert.equal(ok, false);
  assert.equal(fs.existsSync(env.lockPath), false); // lock released even on failure

  const state = readRefreshState(env.statePath);
  assert.equal(state.version, 1);
  assert.equal(state.category, 'rate_limited');
  assert.equal(state.failures, 1);
  assert.equal(state.nextAttemptAt, 170_000); // 50s + honored 120s Retry-After
  assert.deepEqual(Object.keys(state).sort(), [
    'category', 'contextKey', 'failures', 'nextAttemptAt', 'updatedAt', 'version',
  ]);
  assert.match(state.contextKey, /^[0-9a-f]{16}$/);
});

test('refreshQuota grows the backoff across consecutive network failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-backoff-net-'));
  const env = failureEnv(dir);
  const offline = async () => { throw new Error('offline'); };
  await refreshQuota({
    ...env, now: 1_000, clock: () => 1_000, jitter: () => 0, fetchImpl: offline,
  });
  await refreshQuota({
    ...env, now: 2_000, clock: () => 2_000, jitter: () => 0, fetchImpl: offline,
  });
  const state = readRefreshState(env.statePath);
  assert.equal(state.failures, 2);
  assert.equal(state.category, 'network');
  assert.equal(state.nextAttemptAt, 6_000); // 2s + 4s exponential, jitter-free
});

test('refreshQuota clears the backoff on success and keeps the cache format', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-backoff-ok-'));
  const env = failureEnv(dir);
  await refreshQuota({
    ...env,
    now: 1_000,
    jitter: () => 0,
    fetchImpl: async () => statusResponse(503),
  });
  assert.notEqual(readRefreshState(env.statePath), null);

  const ok = await refreshQuota({
    ...env,
    now: 2_000,
    fetchImpl: async () => response(200, REAL_RESPONSE),
  });
  assert.equal(ok, true);
  assert.equal(fs.existsSync(env.statePath), false);
  const cache = readQuotaCache(env.cachePath);
  assert.equal(cache.version, QUOTA_CACHE_VERSION);
  assert.equal(cache.weekly.used, 29);
  assert.equal(cache.fetchedAt, 2_000); // virtual clock honored, not Date.now()
  // The cache is tagged with the same non-reversible context key the refresh
  // backoff used — credential path + endpoint + content fingerprint — so
  // attribution and lockout isolation always agree.
  assert.equal(
    cache.contextKey,
    quotaContextKeyFor(
      env.credentialsPath,
      env.url,
      credentialFileFingerprint(env.credentialsPath),
    ),
  );
  assert.deepEqual(Object.keys(cache).sort(), [
    'contextKey', 'fetchedAt', 'version', 'weekly', 'windows',
  ]);
  // The cache carries only numbers, a reset time, and the context digest —
  // never the token the request was authorized with.
  const rawCache = fs.readFileSync(env.cachePath, 'utf8');
  assert.doesNotMatch(rawCache, /fake-access-token|Bearer/i);
});

test('ensureFreshQuota stays quiet inside the backoff window and spawns after it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-gate-'));
  const env = failureEnv(dir);
  const state = recordRefreshFailure({
    statePath: env.statePath, category: 'network', now: 1_000, jitter: () => 0,
  });
  assert.equal(state.nextAttemptAt, 3_000);

  let spawns = 0;
  const spawnImpl = () => {
    spawns += 1;
    return { once() {}, unref() {} };
  };
  const opts = (now) => ({
    ...env,
    scriptPath: '/tmp/fake-kimi-hud.mjs',
    now,
    spawnImpl,
    tokenFactory: () => 'fixed',
  });
  // Consecutive frames inside the window never spawn.
  assert.equal(ensureFreshQuota(opts(1_100)), false);
  assert.equal(ensureFreshQuota(opts(1_500)), false);
  assert.equal(ensureFreshQuota(opts(2_999)), false);
  assert.equal(spawns, 0);
  // The first frame past the window refreshes, later frames hit the lock.
  assert.equal(ensureFreshQuota(opts(3_000)), true);
  assert.equal(ensureFreshQuota(opts(3_001)), false);
  assert.equal(spawns, 1);
});

test('ensureFreshQuota ignores corrupt backoff state instead of blocking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-gate-bad-'));
  const env = failureEnv(dir);
  fs.writeFileSync(env.statePath, '{broken');
  let spawns = 0;
  const ok = ensureFreshQuota({
    ...env,
    scriptPath: '/tmp/fake-kimi-hud.mjs',
    now: 10,
    spawnImpl: () => { spawns += 1; return { once() {}, unref() {} }; },
    tokenFactory: () => 'fixed',
  });
  assert.equal(ok, true);
  assert.equal(spawns, 1);
});

test('concurrent refresh processes share one backoff schedule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-concurrent-'));
  const env = failureEnv(dir);
  let spawns = 0;
  const spawnImpl = () => {
    spawns += 1;
    return { once() {}, unref() {} };
  };

  // Process A wins the lock and spawns; process B is repelled by the lock.
  assert.equal(ensureFreshQuota({
    ...env, scriptPath: 'x', now: 1_000, spawnImpl, tokenFactory: () => 'a',
  }), true);
  assert.equal(ensureFreshQuota({
    ...env, scriptPath: 'x', now: 1_001, spawnImpl, tokenFactory: () => 'b',
  }), false);
  assert.equal(spawns, 1);

  // A's child fails with 429 and releases the lock, recording backoff.
  const lock = JSON.parse(fs.readFileSync(env.lockPath, 'utf8'));
  const refreshed = await refreshQuota({
    ...env,
    lockToken: lock.token,
    now: 1_002,
    clock: () => 1_002, // instantaneous failure
    jitter: () => 0,
    fetchImpl: async () => statusResponse(429),
  });
  assert.equal(refreshed, false);
  assert.equal(fs.existsSync(env.lockPath), false);

  // B's next frames are now throttled by the shared backoff, not just the lock.
  assert.equal(ensureFreshQuota({
    ...env, scriptPath: 'x', now: 1_003, spawnImpl, tokenFactory: () => 'b',
  }), false);
  assert.equal(ensureFreshQuota({
    ...env, scriptPath: 'x', now: 2_900, spawnImpl, tokenFactory: () => 'b',
  }), false);
  assert.equal(spawns, 1);
  assert.equal(readRefreshState(env.statePath).failures, 1);
});

test('a crashed child is recovered via stale lock once the backoff expires', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-crash-'));
  const env = failureEnv(dir);
  // One failed refresh leaves backoff; a then-crashed child leaves its lock.
  await refreshQuota({
    ...env,
    now: 1_000,
    clock: () => 1_000,
    jitter: () => 0,
    fetchImpl: async () => statusResponse(500),
  });
  fs.writeFileSync(env.lockPath, JSON.stringify({ pid: 1, at: 1_000, token: 'crashed' }));

  let spawns = 0;
  const spawnImpl = () => { spawns += 1; return { once() {}, unref() {} }; };
  // While the lock is fresh the frame declines.
  assert.equal(ensureFreshQuota({
    ...env, scriptPath: 'x', now: 1_100, spawnImpl, tokenFactory: () => 'next',
  }), false);
  // Once lock and backoff are both expired the refresh proceeds.
  const recoveredAt = 1_000 + LOCK_STALE_MS + 1;
  assert.equal(ensureFreshQuota({
    ...env, scriptPath: 'x', now: recoveredAt, spawnImpl, tokenFactory: () => 'next',
  }), true);
  assert.equal(spawns, 1);
});

test('a stale-context failure records nothing; the live context starts fresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-switch-'));
  const envA = failureEnv(dir);
  await refreshQuota({
    ...envA,
    now: 1_000,
    clock: () => 1_000,
    jitter: () => 0,
    fetchImpl: async () => statusResponse(500),
  });
  await refreshQuota({
    ...envA,
    now: 2_000,
    clock: () => 2_000,
    jitter: () => 0,
    fetchImpl: async () => statusResponse(500),
  });
  const stateA = readRefreshState(envA.statePath);
  assert.equal(stateA.failures, 2);
  assert.match(stateA.contextKey, /^[0-9a-f]{16}$/);

  // A request that lost currency mid-flight — the live config no longer
  // resolves to the credential slot it used — records nothing: its failure
  // belongs to a dead context and must not clobber or lock out the live one.
  const staleCredentials = path.join(dir, 'stale-account.json');
  fs.writeFileSync(staleCredentials, JSON.stringify({ access_token: 'fake-stale-token' }));
  const stale = await refreshQuota({
    ...envA,
    credentialsPath: staleCredentials,
    now: 3_000,
    clock: () => 3_000,
    jitter: () => 0,
    fetchImpl: async () => statusResponse(500),
  });
  assert.equal(stale, false);
  assert.deepEqual(readRefreshState(envA.statePath), stateA);

  // The live context keeps its own, freshly counted backoff instead of
  // inheriting the previous context's failure count.
  const kimiHomeB = makeKimiHome(path.join(dir, 'home-b'));
  const credentialsB = path.join(kimiHomeB, 'credentials', 'kimi-code.json');
  fs.writeFileSync(credentialsB, JSON.stringify({ access_token: 'fake-access-token-b' }));
  await refreshQuota({
    ...envA,
    credentialsPath: credentialsB,
    kimiHome: kimiHomeB,
    now: 4_000,
    clock: () => 4_000,
    jitter: () => 0,
    fetchImpl: async () => statusResponse(500),
  });
  const stateB = readRefreshState(envA.statePath);
  assert.equal(stateB.failures, 1); // restarted instead of inheriting 2 failures
  assert.equal(stateB.nextAttemptAt, 6_000);
  assert.notEqual(stateB.contextKey, stateA.contextKey);
});

test('failure refreshes print nothing and persist no token material', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-silent-'));
  const env = failureEnv(dir, { token: 'fake-access-token-SECRET-9f8e7d6c' });
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await refreshQuota({
      ...env,
      now: 1_000,
      jitter: () => 0,
      fetchImpl: async () => statusResponse(503),
    });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.deepEqual(chunks, []);
  const raw = fs.readFileSync(env.statePath, 'utf8');
  assert.doesNotMatch(raw, /SECRET-9f8e7d6c/);
  assert.doesNotMatch(raw, /Bearer/i);
});

test('auth failures back off while the refresh_token keeps the cache alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-auth-backoff-'));
  const env = failureEnv(dir, { refreshToken: 'fake-refresh-token' });
  seedCache(env.kimiHome, env.cachePath);
  await refreshQuota({
    ...env,
    now: 1_000,
    jitter: () => 0,
    fetchImpl: async () => statusResponse(401),
  });
  assert.notEqual(readQuotaCache(env.cachePath), null);
  const state = readRefreshState(env.statePath);
  assert.equal(state.category, 'auth');
  assert.equal(state.failures, 1);
});

test('a /logout-shaped 401 drops the cache and still records the auth backoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-logout-'));
  const env = failureEnv(dir);
  seedCache(env.kimiHome, env.cachePath);
  await refreshQuota({
    ...env,
    now: 1_000,
    clock: () => 1_000,
    jitter: () => 0,
    fetchImpl: async () => statusResponse(401),
  });
  assert.equal(fs.existsSync(env.cachePath), false);
  assert.equal(readRefreshState(env.statePath).category, 'auth');
});

test('slow failures stamp the backoff from the post-failure clock, not the request start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-backoff-clock-'));
  const env = failureEnv(dir);
  let clockNow = 1_000;
  const ok = await refreshQuota({
    ...env,
    now: 1_000, // request start
    clock: () => clockNow, // re-read once the request settles
    jitter: () => 0,
    fetchImpl: async () => {
      clockNow = 9_000; // the request burns 8s before failing
      return statusResponse(500);
    },
  });
  assert.equal(ok, false);
  const state = readRefreshState(env.statePath);
  assert.equal(state.updatedAt, 9_000);
  // Entry-time stamping would have produced 3_000 — already expired at the
  // moment the failure actually happened.
  assert.equal(state.nextAttemptAt, 11_000);
  assert.equal(state.nextAttemptAt > clockNow, true);
});

test('a slow 429 stamps its honored Retry-After window from the failure time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-backoff-429-'));
  const env = failureEnv(dir);
  let clockNow = 50_000;
  await refreshQuota({
    ...env,
    now: 50_000,
    clock: () => clockNow,
    jitter: () => 0,
    fetchImpl: async () => {
      clockNow = 90_000;
      return statusResponse(429, {
        get: (name) => (name === 'retry-after' ? '120' : null),
      });
    },
  });
  const state = readRefreshState(env.statePath);
  assert.equal(state.updatedAt, 90_000);
  assert.equal(state.nextAttemptAt, 210_000); // 90s failure time + honored 120s
});

test('a slow auth failure backs off from the failure time too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-backoff-auth-'));
  const env = failureEnv(dir);
  let clockNow = 1_000;
  await refreshQuota({
    ...env,
    now: 1_000,
    clock: () => clockNow,
    jitter: () => 0,
    fetchImpl: async () => {
      clockNow = 9_000;
      return statusResponse(401);
    },
  });
  const state = readRefreshState(env.statePath);
  assert.equal(state.category, 'auth');
  assert.equal(state.nextAttemptAt, 11_000);
});

test('the scheduler does not inherit another context backoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-gate-ctx-'));
  const env = failureEnv(dir);
  recordRefreshFailure({
    statePath: env.statePath,
    category: 'network',
    now: 1_000,
    jitter: () => 0,
    contextKey: 'context-a',
  });
  let spawns = 0;
  const spawnImpl = () => { spawns += 1; return { once() {}, unref() {} }; };
  const opts = (contextKey, now) => ({
    ...env,
    scriptPath: '/tmp/fake-kimi-hud.mjs',
    contextKey,
    now,
    cachedQuota: null, // no usable cache: the stale check wants a refresh
    spawnImpl,
    tokenFactory: () => 'fixed',
  });
  // A foreign window with no usable cache never blocks the current context.
  assert.equal(ensureFreshQuota(opts('context-b', 1_100)), true);
  assert.equal(spawns, 1);
  // The recorded context itself stays quiet inside its own window.
  assert.equal(ensureFreshQuota(opts('context-a', 1_500)), false);
  // The fresh context's next frame hits the lock, not the foreign backoff.
  assert.equal(ensureFreshQuota(opts('context-b', 1_101)), false);
  assert.equal(spawns, 1);
  // Past window and lock the owner proceeds as usual.
  assert.equal(ensureFreshQuota(opts('context-a', 31_101)), true);
  assert.equal(spawns, 2);
});

// --- H02: context isolation of cache writes ---------------------------------

test('a refresh begun before a region switch cannot overwrite the new context cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-writeguard-'));
  const kimiHome = makeKimiHome(dir);
  const key = scopedOAuthKey(GLOBAL_OAUTH_HOST, GLOBAL_BASE_URL);
  const globalConfig = globalConfigText(key);
  const scopedPath = path.join(kimiHome, 'credentials', `${key.slice('oauth/'.length)}.json`);
  const defaultPath = path.join(kimiHome, 'credentials', 'kimi-code.json');
  // Both accounts exist on disk; the config has just switched to global.
  fs.writeFileSync(scopedPath, JSON.stringify({ access_token: 'current-global-token' }));
  fs.writeFileSync(defaultPath, JSON.stringify({ access_token: 'old-mainland-token' }));
  const cachePath = path.join(dir, 'quota.json');
  const globalKey = quotaContextKeyFor(
    scopedPath,
    GLOBAL_USAGES_URL,
    credentialFileFingerprint(scopedPath),
  );
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath, { contextKey: globalKey });

  // The stale mainland refresh (spawned before the switch) still completes...
  let called = false;
  const stale = await refreshQuota({
    credentialsPath: defaultPath,
    url: USAGES_URL,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
    env: {},
    configText: globalConfig,
    kimiHome,
    fetchImpl: async () => { called = true; return response(200, REAL_RESPONSE); },
  });
  // ...but its result is dropped: it must not overwrite the current context's
  // cache, must not clear its backoff, and returns false.
  assert.equal(called, true);
  assert.equal(stale, false);
  const cache = readQuotaCache(cachePath);
  assert.equal(cache.contextKey, globalKey);
  assert.equal(cache.weekly.used, 29);

  // A refresh for the current context proceeds normally.
  const fresh = await refreshQuota({
    credentialsPath: scopedPath,
    url: GLOBAL_USAGES_URL,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
    env: {},
    configText: globalConfig,
    kimiHome,
    fetchImpl: async () => response(200, REAL_RESPONSE),
  });
  assert.equal(fresh, true);
  assert.equal(readQuotaCache(cachePath).contextKey, globalKey);
});

test('a logout-shaped 401 from a stale context does not delete the current cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-logoutguard-'));
  const kimiHome = makeKimiHome(dir);
  const key = scopedOAuthKey(GLOBAL_OAUTH_HOST, GLOBAL_BASE_URL);
  const globalConfig = globalConfigText(key);
  const scopedPath = path.join(kimiHome, 'credentials', `${key.slice('oauth/'.length)}.json`);
  const defaultPath = path.join(kimiHome, 'credentials', 'kimi-code.json');
  // Current context (global) is logged in with a refresh token; the stale
  // mainland slot only carries an expired access_token (a /logout shape when
  // answered with 401 — but that answer belongs to the old context).
  fs.writeFileSync(scopedPath, JSON.stringify({
    access_token: 'current-global-token',
    refresh_token: 'current-global-refresh',
  }));
  fs.writeFileSync(defaultPath, JSON.stringify({ access_token: 'old-mainland-token' }));
  const cachePath = path.join(dir, 'quota.json');
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath, {
    contextKey: quotaContextKeyFor(
      scopedPath,
      GLOBAL_USAGES_URL,
      credentialFileFingerprint(scopedPath),
    ),
  });

  const stale = await refreshQuota({
    credentialsPath: defaultPath,
    url: USAGES_URL,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
    env: {},
    configText: globalConfig,
    kimiHome,
    fetchImpl: async () => response(401),
  });
  assert.equal(stale, false);
  assert.notEqual(readQuotaCache(cachePath), null); // current cache survives
});

// --- H02 补齐: the credential content itself is part of the context ---------

test('the credential fingerprint is a stable content digest with an absent sentinel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-fp-'));
  const credPath = path.join(dir, 'kimi-code.json');
  // A missing or unreadable file has a deterministic sentinel of its own.
  assert.equal(credentialFileFingerprint(credPath), CREDENTIAL_FINGERPRINT_ABSENT);
  fs.writeFileSync(credPath, JSON.stringify({ access_token: 'token-a' }));
  const fingerprintA = credentialFileFingerprint(credPath);
  assert.match(fingerprintA, /^[0-9a-f]{16}$/);
  assert.equal(credentialFileFingerprint(credPath), fingerprintA);
  // A rewrite with byte-identical content keeps the fingerprint...
  fs.writeFileSync(credPath, JSON.stringify({ access_token: 'token-a' }));
  assert.equal(credentialFileFingerprint(credPath), fingerprintA);
  // ...while any content change (another account, a rotated token) moves it.
  fs.writeFileSync(credPath, JSON.stringify({ access_token: 'token-b' }));
  assert.notEqual(credentialFileFingerprint(credPath), fingerprintA);
});

test('the context key covers credential content, so a same-slot account switch changes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-same-slot-'));
  const credPath = path.join(dir, 'credentials', 'kimi-code.json');
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify({ access_token: 'account-a-access' }));
  const keyA = quotaContextKeyFor(credPath, USAGES_URL, credentialFileFingerprint(credPath));
  assert.equal(
    resolveQuotaContextKey({ env: {}, configText: '', kimiHome: dir }),
    keyA,
  );
  // Account B signs in over the same slot: same path, same endpoint, new context.
  fs.writeFileSync(credPath, JSON.stringify({ access_token: 'account-b-access' }));
  const keyB = quotaContextKeyFor(credPath, USAGES_URL, credentialFileFingerprint(credPath));
  assert.notEqual(keyB, keyA);
  assert.equal(
    resolveQuotaContextKey({ env: {}, configText: '', kimiHome: dir }),
    keyB,
  );
  // Omitting the fingerprint means "no credential content" (missing file) and
  // yields the same deterministic key the resolver computes for that state.
  fs.unlinkSync(credPath);
  assert.equal(
    quotaContextKeyFor(credPath, USAGES_URL),
    resolveQuotaContextKey({ env: {}, configText: '', kimiHome: dir }),
  );
});

test('a credential swapped into the same slot mid-flight drops the in-flight result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-swap-'));
  const env = failureEnv(dir, { token: 'account-a-access' });
  let deliver;
  const fetchImpl = () => new Promise((resolve) => { deliver = resolve; });
  const inFlight = refreshQuota({ ...env, fetchImpl, now: 1_000, jitter: () => 0 });
  assert.ok(deliver, 'the request must be in flight before the swap');
  // Account B replaces the very same credential file while A's request runs.
  fs.writeFileSync(env.credentialsPath, JSON.stringify({ access_token: 'account-b-access' }));
  deliver(response(200, REAL_RESPONSE));
  const ok = await inFlight;
  // A's figures must never land: no cache write, no backoff stamp for B.
  assert.equal(ok, false);
  assert.equal(fs.existsSync(env.cachePath), false);
  assert.equal(readRefreshState(env.statePath), null);
  // The next refresh for the current content succeeds and tags the cache with
  // a key derived from B's credential content.
  const okB = await refreshQuota({
    ...env,
    fetchImpl: async () => response(200, REAL_RESPONSE),
    now: 2_000,
  });
  assert.equal(okB, true);
  assert.equal(
    readQuotaCache(env.cachePath).contextKey,
    quotaContextKeyFor(
      env.credentialsPath,
      USAGES_URL,
      credentialFileFingerprint(env.credentialsPath),
    ),
  );
});

test('a token rotation escapes the rotated-away token auth backoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-rotate-'));
  const env = failureEnv(dir, { token: 'rotated-away-access' });
  const oldKey = quotaContextKeyFor(
    env.credentialsPath,
    USAGES_URL,
    credentialFileFingerprint(env.credentialsPath),
  );
  recordRefreshFailure({
    statePath: env.statePath,
    category: 'auth',
    now: 1_000,
    jitter: () => 0,
    contextKey: oldKey,
  });
  // The CLI refreshes the access token lazily, in place, same slot.
  fs.writeFileSync(env.credentialsPath, JSON.stringify({ access_token: 'fresh-access' }));
  const currentKey = quotaContextKeyFor(
    env.credentialsPath,
    USAGES_URL,
    credentialFileFingerprint(env.credentialsPath),
  );
  assert.notEqual(currentKey, oldKey);
  let spawns = 0;
  const ok = ensureFreshQuota({
    ...env,
    scriptPath: '/tmp/fake-kimi-hud.mjs',
    contextKey: currentKey,
    now: 1_100,
    cachedQuota: null,
    spawnImpl: () => { spawns += 1; return { once() {}, unref() {} }; },
    tokenFactory: () => 'fixed',
  });
  // The auth window belongs to the rotated-away content: the fresh token's
  // first attempt is not delayed by it.
  assert.equal(ok, true);
  assert.equal(spawns, 1);
});

test('a far-future cache stamp is treated as refresh-needing by the scheduler', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-future-sched-'));
  const env = failureEnv(dir);
  const future = 1_000 + QUOTA_CLOCK_SKEW_MS + 60_000;
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), env.cachePath, {
    now: future,
    contextKey: shortDigest(env.credentialsPath, env.url),
  });
  assert.notEqual(readQuotaCache(env.cachePath), null);
  assert.equal(isQuotaStale(readQuotaCache(env.cachePath), 1_000), true);
  let spawns = 0;
  const ok = ensureFreshQuota({
    ...env,
    scriptPath: '/tmp/fake-kimi-hud.mjs',
    now: 1_000,
    cachedQuota: readQuotaCache(env.cachePath),
    spawnImpl: () => { spawns += 1; return { once() {}, unref() {} }; },
    tokenFactory: () => 'fixed',
  });
  assert.equal(ok, true);
  assert.equal(spawns, 1);
});
