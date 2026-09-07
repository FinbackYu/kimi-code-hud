import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectDoctorReport,
  doctorExitCode,
  formatDoctorReport,
  formatDuration,
} from '../src/doctor.mjs';
import { nodeCommand } from '../src/command.mjs';
import {
  credentialFileFingerprint,
  parseQuotaPayload,
  quotaContextKeyFor,
  writeQuotaCache,
  USAGES_URL,
} from '../src/quota.mjs';
import { recordRefreshFailure } from '../src/request-guard.mjs';
import { resolveProviderUsageTarget } from '../src/provider-usage.mjs';
import { resolveRuntimePaths } from '../src/paths.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kimi-hud.mjs');
const SCRIPT = '/opt/hud/bin/kimi-hud.mjs';
const HOOK_BLOCK = [
  '# --- kimi-code-hud hooks START (managed, do not edit) ---',
  '[[hooks]]',
  'event = "SessionStart"',
  `command = "node ${SCRIPT.replace('bin', 'hooks')}/sync-status-line.mjs"`,
  'timeout = 5',
  '# --- kimi-code-hud hooks END ---',
].join('\n');

const QUOTA_PAYLOAD = parseQuotaPayload({
  usage: { limit: '100', used: '25', remaining: '75', resetTime: '2026-09-07T00:00:00Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '50', used: '10', remaining: '40', resetTime: '2026-09-06T12:00:00Z' },
    },
  ],
});

const NOW = Date.parse('2026-09-06T12:00:00Z');

/** Isolated kimi home + hud home with all path overrides pointed inside. */
function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-doctor-'));
  const kimiHome = path.join(root, 'kimi');
  const hudDir = path.join(root, 'hud');
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.mkdirSync(hudDir, { recursive: true });
  const paths = resolveRuntimePaths({
    env: {
      KIMI_CODE_HOME: kimiHome,
      KIMI_HUD_HOME: hudDir,
      KIMI_HUD_TUI_TOML: path.join(kimiHome, 'tui.toml'),
      KIMI_HUD_CONFIG_TOML: path.join(kimiHome, 'config.toml'),
    },
  });
  return { root, kimiHome, hudDir, paths };
}

function seedInstalledTui(paths, command = nodeCommand(SCRIPT)) {
  fs.writeFileSync(paths.tuiTomlPath, `[status_line]\ncommand = "${command}"\n`);
}

function seedConfigToml(paths, extra = '') {
  const body = [
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    '',
    '[models."kimi-code/k3"]',
    'provider = "managed:kimi-code"',
    'model = "k3"',
    '',
  ].join('\n');
  fs.writeFileSync(paths.configTomlPath, `${body}${extra}`);
}

function seedCredentials(kimiHome, values = {}) {
  const dir = path.join(kimiHome, 'credentials');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kimi-code.json'), JSON.stringify({
    access_token: 'sk-synthetic-access-token',
    refresh_token: 'rt-synthetic-refresh-token',
    ...values,
  }));
}

function currentContextKey(kimiHome) {
  const credentialsPath = path.join(kimiHome, 'credentials', 'kimi-code.json');
  return quotaContextKeyFor(
    credentialsPath,
    USAGES_URL,
    credentialFileFingerprint(credentialsPath),
  );
}

function seedQuotaCache(paths, kimiHome, { now = NOW, ageMs = 0, contextKey } = {}) {
  return writeQuotaCache(QUOTA_PAYLOAD, paths.quotaCachePath, {
    now: now - ageMs,
    contextKey: contextKey ?? currentContextKey(kimiHome),
  });
}

/** A report collector bound to one environment with a fixed clock. */
function collect(env, overrides = {}) {
  const report = collectDoctorReport({
    paths: env.paths,
    env: {},
    scriptPath: SCRIPT,
    now: NOW,
    ...overrides,
  });
  return { report, text: formatDoctorReport(report) };
}

function one(report, section, label) {
  const hits = report.checks.filter((c) => c.section === section && c.label === label);
  assert.equal(hits.length, 1, `expected exactly one check ${section}/${label}`);
  return hits[0];
}

test('formatDuration renders unit boundaries', () => {
  assert.equal(formatDuration(40_000), '40s');
  assert.equal(formatDuration(61_000), '1m 01s');
  assert.equal(formatDuration(3_661_000), '1h 01m');
  assert.equal(formatDuration(90_061_000), '1d 01h');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(Number.NaN), '0s');
});

test('doctorExitCode: notes never trip it, any warning does', () => {
  assert.equal(doctorExitCode({ checks: [
    { level: 'ok' }, { level: 'note' },
  ] }), 0);
  assert.equal(doctorExitCode({ checks: [
    { level: 'ok' }, { level: 'warn' },
  ] }), 1);
});

test('fresh environment without any cache: healthy exit 0 with actionable notes', () => {
  const env = makeEnv();
  const { report, text } = collect(env);
  assert.equal(doctorExitCode(report), 0);
  assert.equal(
    report.checks.some((c) => c.level === 'warn'),
    false,
    `unexpected warnings: ${text}`,
  );
  assert.match(one(report, 'install', 'status line').detail, /not installed/);
  assert.equal(one(report, 'install', 'status line').hint, 'run `kimi-code-hud --install` to register it');
  assert.match(one(report, 'quota', 'cache').detail, /no cache yet/);
  assert.match(one(report, 'quota', 'credentials').detail, /absent/);
  assert.match(one(report, 'sessions', 'session metrics').detail, /none yet/);
  assert.match(text, /result: healthy \(exit 0\)/);
});

test('healthy install: fresh attributed cache, credentials and hook are all ok', () => {
  const env = makeEnv();
  seedInstalledTui(env.paths);
  seedConfigToml(env.paths);
  fs.writeFileSync(env.paths.configTomlPath,
    `${fs.readFileSync(env.paths.configTomlPath, 'utf8')}\n${HOOK_BLOCK}\n`);
  seedCredentials(env.kimiHome);
  seedQuotaCache(env.paths, env.kimiHome, { now: NOW, ageMs: 10_000 });
  const { report, text } = collect(env);
  assert.equal(doctorExitCode(report), 0, text);
  assert.match(one(report, 'install', 'status line').detail, /installed \(this copy\)/);
  assert.equal(one(report, 'install', 'SessionStart hook').level, 'ok');
  assert.equal(one(report, 'install', 'plugin install').level, 'ok');
  assert.equal(one(report, 'install', 'on/off switch').level, 'ok');
  assert.match(one(report, 'quota', 'context').detail, new RegExp(`context ${currentContextKey(env.kimiHome)}`));
  assert.match(one(report, 'quota', 'context').detail, /endpoint api\.kimi\.com/);
  assert.match(one(report, 'quota', 'context').detail, /slot kimi-code\.json/);
  assert.match(one(report, 'quota', 'credentials').detail, /access token present/);
  const cache = one(report, 'quota', 'cache');
  assert.equal(cache.level, 'ok');
  assert.match(cache.detail, /fresh, age 10s/);
  assert.match(cache.detail, /context matches the current config/);
  assert.equal(one(report, 'quota', 'refresh state').detail, 'no failed refreshes recorded');
  assert.equal(one(report, 'quota', 'refresh lock').detail, 'idle');
});

test('stale and expired quota caches are categorized without warnings', () => {
  const stale = makeEnv();
  seedQuotaCache(stale.paths, stale.kimiHome, { ageMs: 2 * 60 * 60 * 1000 });
  const { report: staleReport } = collect(stale);
  const staleCheck = one(staleReport, 'quota', 'cache');
  assert.equal(staleCheck.level, 'note');
  assert.match(staleCheck.detail, /stale, age 2h 00m — rendered dimmed with a \[stale\] marker/);
  assert.equal(doctorExitCode(staleReport), 0);

  const expired = makeEnv();
  seedQuotaCache(expired.paths, expired.kimiHome, { ageMs: 8 * 24 * 60 * 60 * 1000 });
  const { report: expiredReport } = collect(expired);
  const expiredCheck = one(expiredReport, 'quota', 'cache');
  assert.equal(expiredCheck.level, 'note');
  assert.match(expiredCheck.detail, /expired — figures hidden/);
  assert.equal(doctorExitCode(expiredReport), 0);
});

test('a cache stamped far in the future is treated as expired', () => {
  const env = makeEnv();
  seedQuotaCache(env.paths, env.kimiHome, { ageMs: -30 * 60 * 1000 });
  const { report } = collect(env);
  const check = one(report, 'quota', 'cache');
  assert.equal(check.level, 'note');
  assert.match(check.detail, /timestamp ahead of the clock/);
});

test('a cache from another credential context warns: figures stay hidden', () => {
  const env = makeEnv();
  seedQuotaCache(env.paths, env.kimiHome, { contextKey: 'aaaaaaaaaaaaaaaa' });
  const { report, text } = collect(env);
  const check = one(report, 'quota', 'cache');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /context mismatch — figures hidden/);
  assert.equal(doctorExitCode(report), 1, text);
});

test('a legacy untagged quota cache warns until a refresh re-tags it', () => {
  const env = makeEnv();
  fs.writeFileSync(env.paths.quotaCachePath, JSON.stringify({
    version: 1, fetchedAt: NOW - 1000, weekly: { used: 1, limit: 2 }, windows: [],
  }));
  const { report } = collect(env);
  const check = one(report, 'quota', 'cache');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /untagged legacy cache/);
  assert.equal(doctorExitCode(report), 1);
});

test('corrupt JSON in quota cache, refresh state, git cache and HUD config all warn', () => {
  const env = makeEnv();
  fs.writeFileSync(env.paths.quotaCachePath, '{"version":2,"contextKey":"aaaaaaaa');
  fs.writeFileSync(env.paths.quotaRefreshStatePath, 'not json at all');
  fs.writeFileSync(env.paths.gitStatusCachePath, '[]');
  fs.writeFileSync(env.paths.configPath, '{oops');
  const { report, text } = collect(env);
  assert.match(one(report, 'quota', 'cache').detail, /corrupt JSON/);
  assert.match(one(report, 'quota', 'refresh state').detail, /corrupt refresh state/);
  assert.match(one(report, 'git status', 'cache').detail, /corrupt — ignored; rewritten automatically/);
  assert.match(one(report, 'environment', 'HUD config.json').detail, /corrupt — ignored, defaults in effect/);
  assert.equal(doctorExitCode(report), 1);
  for (const check of report.checks) {
    assert.ok(!text.includes('{"version":2'), 'raw file bodies must never be printed');
    assert.equal(check.detail.includes('not json at all'), false);
  }
});

test('backoff state reports the next attempt as a human-relative time', () => {
  const env = makeEnv();
  recordRefreshFailure({
    statePath: env.paths.quotaRefreshStatePath,
    category: 'rate_limited',
    now: NOW,
    jitter: () => 0,
    contextKey: currentContextKey(env.kimiHome),
  });
  const { report, text } = collect(env);
  const check = one(report, 'quota', 'refresh state');
  assert.equal(check.level, 'note');
  assert.match(check.detail, /backoff in effect after 1 failure\(s\) \(rate_limited\)/);
  assert.match(check.detail, /next attempt in 2s/);
  assert.match(check.hint, /retries automatically/);
  assert.equal(doctorExitCode(report), 0);
  assert.match(text, /next attempt in 2s/);
});

test('backoff recorded for another context is flagged, not inherited silently', () => {
  const env = makeEnv();
  recordRefreshFailure({
    statePath: env.paths.quotaRefreshStatePath,
    category: 'network',
    now: NOW,
    jitter: () => 0,
    contextKey: 'ffffffffffffffff',
  });
  const { report } = collect(env);
  const check = one(report, 'quota', 'refresh state');
  assert.match(check.detail, /state belongs to a different credential context/);
  // A foreign window never gates the current context's own refresh attempts.
  assert.match(check.detail, /does not gate the current context/);
  assert.doesNotMatch(check.detail, /may wait out/);
});

test('an expired retry window reads as "retry allowed now"', () => {
  const env = makeEnv();
  recordRefreshFailure({
    statePath: env.paths.quotaRefreshStatePath,
    category: 'timeout',
    now: NOW - 10 * 60 * 1000,
    jitter: () => 0,
    contextKey: currentContextKey(env.kimiHome),
  });
  const { report } = collect(env);
  assert.match(one(report, 'quota', 'refresh state').detail, /retry allowed now/);
});

test('unreadable config.toml warns and notes the fallback context', { skip: process.platform === 'win32' }, () => {
  const env = makeEnv();
  fs.writeFileSync(env.paths.configTomlPath, '[providers."managed:kimi-code"]');
  fs.chmodSync(env.paths.configTomlPath, 0o000);
  try {
    const { report } = collect(env);
    const check = one(report, 'environment', 'config.toml');
    assert.equal(check.level, 'warn');
    assert.match(check.detail, /cannot be read/);
    assert.equal(doctorExitCode(report), 1);
  } finally {
    fs.chmodSync(env.paths.configTomlPath, 0o644);
  }
});

test('a third-party status line occupying the slot warns with the takeover hint', () => {
  const env = makeEnv();
  seedInstalledTui(env.paths, 'bash /secret/path/other-hud.sh');
  const { report, text } = collect(env);
  const check = one(report, 'install', 'status line');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /third-party status line occupies the slot/);
  assert.match(check.hint, /--install/);
  assert.equal(doctorExitCode(report), 1);
  // The foreign command itself is never echoed (it can contain private paths).
  assert.equal(text.includes('other-hud.sh'), false);
});

test('unrecognized status_line syntax warns instead of guessing ownership', () => {
  const env = makeEnv();
  fs.writeFileSync(env.paths.tuiTomlPath, '[status_line]\ncommand = `backtick`\n');
  const { report } = collect(env);
  const check = one(report, 'install', 'status line');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /unrecognized/);
});

test('an installed command pointing at another copy is reported', () => {
  const env = makeEnv();
  seedInstalledTui(env.paths, 'node /somewhere/else/bin/kimi-hud.mjs');
  const { report } = collect(env);
  assert.match(one(report, 'install', 'status line').detail, /different kimi-hud copy/);
});

test('managed plugin states: disabled and missing record warn, enabled is ok', () => {
  const managedScript = (env) => path.join(env.kimiHome, 'plugins', 'managed', 'kimi-code-hud', 'bin', 'kimi-hud.mjs');
  const store = (env, data) => {
    fs.mkdirSync(path.join(env.kimiHome, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(env.kimiHome, 'plugins', 'installed.json'), JSON.stringify(data));
  };

  const enabled = makeEnv();
  store(enabled, { version: 1, plugins: [{ id: 'kimi-code-hud', root: enabled.kimiHome, enabled: true }] });
  assert.equal(one(collect(enabled, { scriptPath: managedScript(enabled) }).report,
    'install', 'plugin install').level, 'ok');

  const disabled = makeEnv();
  store(disabled, { version: 1, plugins: [{ id: 'kimi-code-hud', root: disabled.kimiHome, enabled: false }] });
  const disabledReport = collect(disabled, { scriptPath: managedScript(disabled) }).report;
  assert.match(one(disabledReport, 'install', 'plugin install').detail, /stays silent/);
  assert.equal(doctorExitCode(disabledReport), 1);

  const noRecord = makeEnv();
  store(noRecord, { version: 1, plugins: [] });
  const noRecordReport = collect(noRecord, { scriptPath: managedScript(noRecord) }).report;
  assert.match(one(noRecordReport, 'install', 'plugin install').detail, /install record is gone/);

  const storeGone = makeEnv();
  const storeGoneReport = collect(storeGone, { scriptPath: managedScript(storeGone) }).report;
  assert.match(one(storeGoneReport, 'install', 'plugin install').detail, /install record is gone/);
});

test('providers without a usage adapter are named without leaking model tables', () => {
  const env = makeEnv();
  seedConfigToml(env.paths, '\n[providers.anthropic]\ntype = "anthropic"\n');
  const { report, text } = collect(env);
  const check = one(report, 'providers', 'usage targets');
  assert.equal(check.level, 'note');
  assert.match(check.detail, /no usage adapter for: anthropic/);
  assert.equal(text.includes('k3'), false, 'model tables must not be echoed');
});

test('deepseek balance: official target with a fresh cache is ok; unusable config hides', () => {
  const withKey = makeEnv();
  seedConfigToml(withKey.paths, [
    '',
    '[providers.deepseek]',
    'type = "deepseek"',
    'base_url = "https://api.deepseek.com/v1"',
    'api_key = "sk-synth-deepseek-key"',
    '',
  ].join('\n'));
  const target = resolveProviderUsageTarget({
    provider: 'deepseek',
    configText: fs.readFileSync(withKey.paths.configTomlPath, 'utf8'),
    providerUsageDir: withKey.paths.providerUsageDir,
  });
  assert.ok(target, 'official deepseek config must resolve');
  fs.mkdirSync(withKey.paths.providerUsageDir, { recursive: true });
  fs.writeFileSync(target.cachePath, JSON.stringify({
    version: 1,
    provider: 'deepseek',
    credentialFingerprint: target.credentialFingerprint,
    fetchedAt: NOW - 1000,
    kind: 'balance',
    label: 'DeepSeek',
    available: true,
    balances: [{ currency: 'CNY', total: 42, granted: 10, toppedUp: 32 }],
  }));
  const okRun = collect(withKey);
  const okCheck = one(okRun.report, 'providers', 'deepseek');
  assert.equal(okCheck.level, 'ok');
  assert.match(okCheck.detail, /cache fresh, age 1s/);
  assert.match(okCheck.detail, new RegExp(`account ${target.credentialFingerprint}`));
  assert.equal(doctorExitCode(okRun.report), 0);

  const proxy = makeEnv();
  seedConfigToml(proxy.paths, [
    '',
    '[providers.deepseek]',
    'type = "deepseek"',
    'base_url = "https://deepseek.proxy.example/v1"',
    'api_key = "sk-synth-deepseek-key"',
    '',
  ].join('\n'));
  const proxyRun = collect(proxy);
  assert.match(one(proxyRun.report, 'providers', 'deepseek').detail, /balance stays hidden by design/);
  assert.equal(doctorExitCode(proxyRun.report), 0);

  const noKey = makeEnv();
  seedConfigToml(noKey.paths, [
    '',
    '[providers.deepseek]',
    'type = "deepseek"',
    'base_url = "https://api.deepseek.com/v1"',
    '',
  ].join('\n'));
  assert.match(one(collect(noKey).report, 'providers', 'deepseek').detail, /balance stays hidden by design/);
});

test('stale deepseek cache and its backoff are reported', () => {
  const env = makeEnv();
  seedConfigToml(env.paths, [
    '',
    '[providers.deepseek]',
    'type = "deepseek"',
    'base_url = "https://api.deepseek.com"',
    'api_key = "sk-synth-deepseek-key"',
    '',
  ].join('\n'));
  const target = resolveProviderUsageTarget({
    provider: 'deepseek',
    configText: fs.readFileSync(env.paths.configTomlPath, 'utf8'),
    providerUsageDir: env.paths.providerUsageDir,
  });
  fs.mkdirSync(env.paths.providerUsageDir, { recursive: true });
  fs.writeFileSync(target.cachePath, JSON.stringify({
    version: 1,
    provider: 'deepseek',
    credentialFingerprint: target.credentialFingerprint,
    fetchedAt: NOW - 5 * 60 * 1000,
    kind: 'balance',
    label: 'DeepSeek',
    available: true,
    balances: [{ currency: 'CNY', total: 42, granted: 10, toppedUp: 32 }],
  }));
  recordRefreshFailure({
    statePath: target.statePath,
    category: 'server',
    now: NOW,
    jitter: () => 0,
  });
  const { report } = collect(env);
  assert.match(one(report, 'providers', 'deepseek').detail, /cache stale, age 5m 00s/);
  assert.match(one(report, 'providers', 'deepseek refresh state').detail, /next attempt in 2s/);
});

test('output never contains tokens, session bodies, or third-party commands', () => {
  const env = makeEnv();
  seedCredentials(env.kimiHome, {
    access_token: 'sk-super-secret-access-token-value',
    refresh_token: 'rt-super-secret-refresh-token-value',
  });
  fs.mkdirSync(env.paths.sessionStateDir, { recursive: true });
  fs.writeFileSync(path.join(env.paths.sessionStateDir, 'metrics-abc123.json'),
    'SYNTHETIC_SESSION_BODY_MARKER');
  seedInstalledTui(env.paths, 'bash /secret/path/other-hud.sh');
  const local = formatDoctorReport(collectDoctorReport({
    paths: env.paths, env: {}, scriptPath: SCRIPT, now: NOW,
  }));
  const share = formatDoctorReport(collectDoctorReport({
    paths: env.paths, env: {}, scriptPath: SCRIPT, now: NOW,
  }), { shareable: true });
  for (const text of [local, share]) {
    for (const secret of [
      'sk-super-secret-access-token-value',
      'rt-super-secret-refresh-token-value',
      'SYNTHETIC_SESSION_BODY_MARKER',
      'other-hud.sh',
    ]) {
      assert.equal(text.includes(secret), false, `leaked: ${secret}`);
    }
  }
  assert.match(local, /1 session state file/);
});

test('shareable output masks personal paths; local output shows them', () => {
  const env = makeEnv();
  seedQuotaCache(env.paths, env.kimiHome, { ageMs: 1000 });
  const report = collectDoctorReport({ paths: env.paths, env: {}, scriptPath: SCRIPT, now: NOW });
  const local = formatDoctorReport(report);
  const share = formatDoctorReport(report, { shareable: true });
  assert.match(local, new RegExp(`path: ${env.paths.quotaCachePath}`));
  assert.equal(share.includes(env.root), false, 'shareable output must not contain the tmp root');
  // Paths under the known roots are rewritten to logical labels.
  assert.match(share, /path: \$KIMI_HUD_HOME[\\/]quota\.json/);
  assert.match(share, /path: \$KIMI_CODE_HOME/);
  // The context digest is a non-reversible summary and stays visible.
  assert.match(share, new RegExp(`context ${currentContextKey(env.kimiHome)}`));
});

test('share mode hides custom roots like /Volumes/PrivateCustomer; local keeps them readable', () => {
  const privateRoot = '/Volumes/PrivateCustomer/Project/Kimi';
  const paths = resolveRuntimePaths({
    env: {
      KIMI_CODE_HOME: `${privateRoot}/.kimi-code`,
      KIMI_HUD_HOME: `${privateRoot}/.kimi-code-hud`,
      KIMI_HUD_TUI_TOML: '/etc/kimi-hud-doctor-fixture/tui.toml',
      KIMI_HUD_CONFIG_TOML: `${privateRoot}/.kimi-code/config.toml`,
    },
  });
  const report = collectDoctorReport({ paths, env: {}, scriptPath: SCRIPT, now: NOW });
  const local = formatDoctorReport(report);
  const share = formatDoctorReport(report, { shareable: true });
  assert.match(local, new RegExp(`path: ${privateRoot}/\\.kimi-code`));
  assert.match(local, /path: \/etc\/kimi-hud-doctor-fixture\/tui\.toml/);
  for (const secret of ['/Volumes/PrivateCustomer', '/etc/kimi-hud-doctor-fixture']) {
    assert.equal(share.includes(secret), false, `shareable output leaked: ${secret}`);
  }
  assert.match(share, /path: \$KIMI_CODE_HOME/);
  assert.match(share, /path: \$KIMI_HUD_HOME/);
  assert.match(share, /path: <absolute-path-hidden>/);
});

test('share mode labels a UNC kimi home (user repro); local keeps it verbatim', () => {
  const uncRoot = '\\\\private-server\\PrivateCustomer\\Project\\Kimi';
  const paths = resolveRuntimePaths({
    env: {
      KIMI_CODE_HOME: uncRoot,
      KIMI_HUD_HOME: `${uncRoot}\\.kimi-code-hud`,
      KIMI_HUD_TUI_TOML: `${uncRoot}\\tui.toml`,
      KIMI_HUD_CONFIG_TOML: `${uncRoot}\\config.toml`,
    },
  });
  const report = collectDoctorReport({ paths, env: {}, scriptPath: SCRIPT, now: NOW });
  const local = formatDoctorReport(report);
  const share = formatDoctorReport(report, { shareable: true });
  assert.equal(local.includes(uncRoot), true, 'local output must stay byte-for-byte');
  for (const secret of [uncRoot, 'private-server', 'PrivateCustomer']) {
    assert.equal(share.includes(secret), false, `shareable output leaked: ${secret}`);
  }
  assert.match(share, /path: \$KIMI_CODE_HOME/);
  assert.match(share, /path: \$KIMI_HUD_HOME[\\/]/);
});

test('bin --doctor --share masks a UNC kimi home (user repro)', () => {
  const uncRoot = '\\\\private-server\\PrivateCustomer\\Project\\Kimi';
  const result = spawnSync(process.execPath, [BIN, '--doctor', '--share'], {
    input: '',
    env: {
      ...process.env,
      KIMI_CODE_HOME: uncRoot,
      KIMI_HUD_HOME: `${uncRoot}\\.kimi-code-hud`,
      KIMI_HUD_TUI_TOML: `${uncRoot}\\tui.toml`,
      KIMI_HUD_CONFIG_TOML: `${uncRoot}\\config.toml`,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('private-server'), false);
  assert.equal(result.stdout.includes('PrivateCustomer'), false);
  assert.match(result.stdout, /path: \$KIMI_CODE_HOME/);
  assert.match(result.stdout, /path: \$KIMI_HUD_HOME[\\/]/);
});

test('share mode hides unknown UNC and extended-length path fields', () => {
  const onePath = (p) => ({
    now: NOW,
    paths: null,
    checks: [{
      section: 'environment',
      level: 'ok',
      label: 'kimi home',
      detail: 'present',
      path: p,
    }],
  });
  for (const p of [
    '\\\\nas\\Private\\Share\\sub',
    '\\\\?\\C:\\Private\\secret\\hud',
    '\\\\?\\UNC\\nas\\Private\\Share\\sub',
  ]) {
    const local = formatDoctorReport(onePath(p));
    const share = formatDoctorReport(onePath(p), { shareable: true });
    assert.equal(local.includes(p), true, `local must pass through ${p} byte-for-byte`);
    assert.equal(share.includes(p), false, `shareable output leaked: ${p}`);
    assert.match(share, /path: <absolute-path-hidden>/);
  }
});

test('share mode labels extended-length forms of known roots', () => {
  const onePath = (paths, p) => ({
    now: NOW,
    paths,
    checks: [{
      section: 'environment',
      level: 'ok',
      label: 'kimi home',
      detail: 'present',
      path: p,
    }],
  });
  // \\?\UNC\... value under a plain UNC kimi home.
  const uncShare = formatDoctorReport(
    onePath({ kimiHome: '\\\\private-server\\PrivateCustomer\\Project\\Kimi' },
      '\\\\?\\UNC\\private-server\\PrivateCustomer\\Project\\Kimi\\credentials\\kimi-code.json'),
    { shareable: true },
  );
  assert.equal(uncShare.includes('private-server'), false);
  assert.match(uncShare, /path: \$KIMI_CODE_HOME\\credentials\\kimi-code\.json/);
  // \\?\C:\... value under a drive-letter kimi home.
  const driveShare = formatDoctorReport(
    onePath({ kimiHome: 'C:\\Private\\Kimi' }, '\\\\?\\C:\\Private\\Kimi\\hud\\quota.json'),
    { shareable: true },
  );
  assert.equal(driveShare.includes('C:\\Private'), false);
  assert.match(driveShare, /path: \$KIMI_CODE_HOME\\hud\\quota\.json/);
  // A plain value under an extended-length UNC kimi home.
  const extRootShare = formatDoctorReport(
    onePath({ kimiHome: '\\\\?\\UNC\\nas\\Share\\Kimi' }, '\\\\nas\\Share\\Kimi\\quota.json'),
    { shareable: true },
  );
  assert.match(extRootShare, /path: \$KIMI_CODE_HOME\\quota\.json/);
  // Windows paths fold case when matching a known root.
  const ciShare = formatDoctorReport(
    onePath({ kimiHome: '\\\\nas\\Share\\Kimi' }, '\\\\NAS\\SHARE\\KIMI\\x.json'),
    { shareable: true },
  );
  assert.match(ciShare, /path: \$KIMI_CODE_HOME\\x\.json/);
});

test('share mode redacts UNC paths in free text without touching prose or URLs', () => {
  const report = {
    now: NOW,
    paths: null,
    checks: [{
      section: 'install',
      level: 'warn',
      label: 'status line',
      detail: 'scan skipped for \\\\nas\\Private\\Share\\v1.2\\cache.log, retry tomorrow.',
      hint: 'logs live at \\\\private-server\\PrivateCustomer\\hud.log and https://example.com/docs/setup',
    }],
  };
  const local = formatDoctorReport(report);
  const share = formatDoctorReport(report, { shareable: true });
  assert.match(local, /\\\\nas\\Private\\Share\\/);
  for (const secret of ['private-server', 'PrivateCustomer', '\\\\nas']) {
    assert.equal(share.includes(secret), false, `shareable output leaked: ${secret}`);
  }
  assert.match(share, /scan skipped for <absolute-path-hidden>, retry tomorrow\./);
  assert.match(share, /logs live at <absolute-path-hidden> and https:\/\/example\.com\/docs\/setup/);

  // Extended-length forms inside free text are consumed whole, colon included.
  const extended = (detail) => ({
    now: NOW,
    paths: null,
    checks: [{ section: 'environment', level: 'note', label: 'sessions', detail }],
  });
  const extShare = formatDoctorReport(
    extended('ignored \\\\?\\C:\\Windows\\secret and \\\\?\\UNC\\nas\\Private\\Share\\x now'),
    { shareable: true },
  );
  for (const secret of ['C:\\Windows', 'nas', 'Private', 'Share']) {
    assert.equal(extShare.includes(secret), false, `shareable output leaked: ${secret}`);
  }
  assert.match(extShare, /ignored <absolute-path-hidden> and <absolute-path-hidden> now/);
});

test('share mode leaves look-alike prose untouched: escapes, single backslashes, mixed separators', () => {
  const plain = (detail) => ({
    now: NOW,
    paths: null,
    checks: [{ section: 'quota', level: 'note', label: 'context', detail }],
  });
  // Regex-style escapes and a single-backslash relative hint are not UNC paths.
  const proseShare = formatDoctorReport(
    plain('pattern \\\\? and \\\\d stay visible; so does folder\\sub'),
    { shareable: true },
  );
  assert.equal(
    proseShare.includes('pattern \\\\? and \\\\d stay visible; so does folder\\sub'),
    true,
    proseShare,
  );
  // A UNC-shaped token with mixed separators is redacted as a whole.
  const mixedShare = formatDoctorReport(
    plain('stuck on \\\\nas\\Private\\Share/mixed\\child, see docs'),
    { shareable: true },
  );
  assert.equal(mixedShare.includes('Private'), false, mixedShare);
  assert.match(mixedShare, /stuck on <absolute-path-hidden>, see docs/);
});

test('share mode redacts absolute paths in free text; local keeps them', () => {
  const report = {
    now: NOW,
    paths: null,
    checks: [{
      section: 'install',
      level: 'warn',
      label: 'status line',
      detail: 'a third-party status line occupies the slot '
        + '(command: bash /Volumes/PrivateCustomer/Project/Kimi/other-hud.sh)',
      hint: 'run `kimi-code-hud --install` to replace it (a .bak backup is kept)',
    }],
  };
  const local = formatDoctorReport(report);
  const share = formatDoctorReport(report, { shareable: true });
  assert.match(local, /\/Volumes\/PrivateCustomer\/Project\/Kimi\/other-hud\.sh/);
  assert.equal(share.includes('/Volumes/PrivateCustomer'), false, 'share leaked the foreign command path');
  assert.match(share, /bash <absolute-path-hidden>\)/);
  assert.match(share, /run `kimi-code-hud --install` to replace it/);

  const known = {
    now: NOW,
    paths: { kimiHome: '/Volumes/PrivateCustomer/Project/Kimi/.kimi-code' },
    checks: [{
      section: 'install',
      level: 'warn',
      label: 'status line',
      detail: 'installed, but pointing at a different kimi-hud copy: node '
        + '/Volumes/PrivateCustomer/Project/Kimi/.kimi-code/other/bin/kimi-hud.mjs and C:\\Private\\hud.js',
    }],
  };
  const knownShare = formatDoctorReport(known, { shareable: true });
  assert.equal(knownShare.includes('/Volumes/PrivateCustomer'), false);
  assert.match(knownShare, /node \$KIMI_CODE_HOME\/other\/bin\/kimi-hud\.mjs/);
  assert.equal(knownShare.includes('C:\\Private'), false);
  assert.match(knownShare, /<absolute-path-hidden>/);
});

test('collection is strictly read-only: the state tree is byte-identical after', () => {
  const env = makeEnv();
  seedInstalledTui(env.paths);
  seedConfigToml(env.paths);
  seedCredentials(env.kimiHome);
  seedQuotaCache(env.paths, env.kimiHome, { ageMs: 1000 });
  recordRefreshFailure({
    statePath: env.paths.quotaRefreshStatePath,
    category: 'network',
    now: NOW,
    jitter: () => 0,
    contextKey: currentContextKey(env.kimiHome),
  });
  fs.writeFileSync(env.paths.quotaLockPath, JSON.stringify({ pid: 1, at: NOW, token: 't' }));
  fs.mkdirSync(env.paths.providerUsageDir, { recursive: true });
  fs.writeFileSync(path.join(env.paths.providerUsageDir, 'deepseek-0123456789abcdef.json'), '{}');
  fs.writeFileSync(env.paths.gitStatusCachePath, JSON.stringify({
    version: 1,
    entries: { [`${'a'.repeat(64)}`]: { checkedAt: NOW - 5000, branch: 'main', dirty: false } },
  }));
  const snapshot = (dir) => {
    const rows = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const filePath = path.join(current, entry.name);
        if (entry.isDirectory()) walk(filePath);
        else {
          const st = fs.statSync(filePath);
          rows.push(`${filePath}:${st.size}:${st.mtimeMs}`);
        }
      }
    };
    walk(dir);
    return rows.sort().join('\n');
  };
  const before = snapshot(env.root);
  const { report } = collect(env);
  assert.equal(snapshot(env.root), before, 'doctor must not write, touch or delete anything');
  assert.match(one(report, 'quota', 'refresh lock').detail, /lock present — a detached refresh may be running/);
  assert.match(one(report, 'git status', 'cache').detail, /1 entry, newest 5s ago/);
  assert.match(one(report, 'providers', 'other cached account').detail, /deepseek · account 0123456789abcdef/);
});

test('bin --doctor exits 0 on a fresh environment and prints to stdout only', () => {
  const env = makeEnv();
  const result = spawnSync(process.execPath, [BIN, '--doctor'], {
    input: '',
    env: {
      ...process.env,
      KIMI_CODE_HOME: env.kimiHome,
      KIMI_HUD_HOME: env.hudDir,
      KIMI_HUD_TUI_TOML: env.paths.tuiTomlPath,
      KIMI_HUD_CONFIG_TOML: env.paths.configTomlPath,
      KIMI_CODE_OAUTH_HOST: '',
      KIMI_OAUTH_HOST: '',
      KIMI_CODE_BASE_URL: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^kimi-code-hud doctor — read-only diagnostics\n/);
  assert.match(result.stdout, /result: healthy \(exit 0\)/);
  assert.ok(result.stdout.includes(env.kimiHome), 'local mode shows resolved paths');
});

test('bin --doctor exits 1 when a cache file is corrupt', () => {
  const env = makeEnv();
  fs.writeFileSync(env.paths.quotaCachePath, 'definitely not json');
  const result = spawnSync(process.execPath, [BIN, '--doctor'], {
    input: '',
    env: {
      ...process.env,
      KIMI_CODE_HOME: env.kimiHome,
      KIMI_HUD_HOME: env.hudDir,
      KIMI_HUD_TUI_TOML: env.paths.tuiTomlPath,
      KIMI_HUD_CONFIG_TOML: env.paths.configTomlPath,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[warn\] cache: corrupt JSON/);
  assert.match(result.stdout, /result: attention needed \(exit 1\)/);
});

test('bin --doctor --share masks personal paths', () => {
  const env = makeEnv();
  const result = spawnSync(process.execPath, [BIN, '--doctor', '--share'], {
    input: '',
    env: {
      ...process.env,
      KIMI_CODE_HOME: env.kimiHome,
      KIMI_HUD_HOME: env.hudDir,
      KIMI_HUD_TUI_TOML: env.paths.tuiTomlPath,
      KIMI_HUD_CONFIG_TOML: env.paths.configTomlPath,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes(env.root), false);
  assert.match(result.stdout, /path: \$KIMI_HUD_HOME[\\/]/);
  assert.match(result.stdout, /path: \$KIMI_CODE_HOME/);
});

test('bin --help documents the doctor entry point', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], {
    input: '',
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--doctor/);
  assert.match(result.stdout, /--share/);
});
