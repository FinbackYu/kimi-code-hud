import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
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
  resolveQuotaEndpoints,
  QUOTA_RESULT,
  QUOTA_TTL_MS,
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
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return response(200, REAL_RESPONSE);
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ url: GLOBAL_USAGES_URL, auth: 'Bearer fake-global-access-token' }]);
  assert.equal(readQuotaCache(cachePath).weekly.used, 29);
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
  const endpoints = resolveQuotaEndpoints({
    env: {},
    configText: `[providers."managed:kimi-code"]\nbase_url = "https://evil.example.com/coding/v1"\n`,
    kimiHome,
  });
  const calls = [];
  const ok = await refreshQuota({
    ...endpoints,
    cachePath: path.join(dir, 'quota.json'),
    lockPath: path.join(dir, 'refresh.lock'),
    fetchImpl: async (url) => { calls.push(url); return response(200, REAL_RESPONSE); },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [USAGES_URL]); // never https://evil.example.com/...
});

test('an evil config without fallback credentials performs no request and writes no cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-quota-evil-nocreds-'));
  const kimiHome = makeKimiHome(dir);
  const endpoints = resolveQuotaEndpoints({
    env: {},
    configText: `[providers."managed:kimi-code"]\nbase_url = "https://evil.example.com/coding/v1"\n`,
    kimiHome,
  });
  let called = false;
  const cachePath = path.join(dir, 'quota.json');
  const ok = await refreshQuota({
    ...endpoints,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
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
  const endpoints = resolveQuotaEndpoints({ env: {}, configText: globalConfigText(key), kimiHome });
  assert.equal(endpoints.url, GLOBAL_USAGES_URL);

  let called = false;
  const cachePath = path.join(dir, 'quota.json');
  writeQuotaCache(parseQuotaPayload(REAL_RESPONSE), cachePath);
  const ok = await refreshQuota({
    ...endpoints,
    cachePath,
    lockPath: path.join(dir, 'refresh.lock'),
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
