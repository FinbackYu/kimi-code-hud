// Read-only diagnostics entry point (H06). The doctor answers "why does the
// HUD look the way it does?" without mutating anything: no network, no
// refreshes, no config edits, no cache cleanup — repair stays with the
// existing management flags (--install/--on/--off/--uninstall) and the
// detached refreshes. Rendering is silent as before; the doctor is a separate
// subcommand.
//
// Privacy contract: session content, tokens, credentials and config file
// bodies are never printed. Credentials are opened only to derive boolean
// facts (is an access token present?). What may appear: result categories,
// ages, failure categories, retry timing, file existence, and non-reversible
// digests (quota contextKey, provider credential fingerprint) — the same
// digests the on-disk state files already carry. Shareable mode additionally
// rewrites paths under known roots to logical labels and hides every other
// absolute path (POSIX, drive-letter, Windows UNC and \\?\ extended forms),
// so the report can be pasted into an issue.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nodeCommand } from './command.mjs';
import {
  DEEPSEEK_PROVIDER,
  PROVIDER_USAGE_TTL_MS,
  resolveProviderUsageTarget,
} from './provider-usage.mjs';
import {
  MANAGED_KIMI_PROVIDER,
  decodedStringValue,
  findProviderTable,
} from './model-config.mjs';
import {
  LOCK_STALE_MS,
  QUOTA_AGE,
  quotaAge,
  quotaContextKeyFor,
  credentialFileFingerprint,
  resolveQuotaEndpoints,
} from './quota.mjs';
import { readRefreshState } from './request-guard.mjs';
import { isHudDisabled, managedPluginId } from './plugin-state.mjs';
import { inspectStatusLineCommand, isKimiHudCommand } from './toml.mjs';

export const DOCTOR_LEVEL = Object.freeze({ OK: 'ok', NOTE: 'note', WARN: 'warn' });

// Mirrors the START marker in hooks.mjs, which does not export it.
const HOOK_MARKER = '# --- kimi-code-hud hooks START';

// provider-usage dir entries: <provider>-<fingerprint>.json|.state.json|.lock
const PROVIDER_GROUP_RE = /^([a-z0-9][a-z0-9_-]{0,63})-([0-9a-f]{16})\.(state\.json|json|lock)$/;

const METRICS_STATE_RE = /^metrics-[A-Za-z0-9_-]+\.json$/;

const GIT_STATUS_CACHE_VERSION = 1;

/**
 * Human-readable duration ("40s", "2m 05s", "3h 12m", "9d 02h").
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${String(h % 24).padStart(2, '0')}h`;
}

/** When the next attempt may run, as a relative offset from `now`. */
function formatUntil(targetMs, now) {
  return `in ${formatDuration(targetMs - now)}`;
}

function readTextFile(filePath) {
  try {
    return { state: 'ok', text: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    // An unreachable UNC server surfaces on Windows as a code-less UNKNOWN
    // error (libuv has no errno name for the network failure). The path is
    // not a broken local file but simply unreachable, so it is classified
    // like absence instead of raising a false "cannot be read" warning.
    return {
      state: !err || !err.code || err.code === 'ENOENT' ? 'missing' : 'unreadable',
      text: null,
    };
  }
}

function readJsonObject(filePath) {
  const file = readTextFile(filePath);
  if (file.state !== 'ok') return { state: file.state, data: null };
  try {
    const data = JSON.parse(file.text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { state: 'corrupt', data: null };
    }
    return { state: 'ok', data };
  } catch {
    return { state: 'corrupt', data: null };
  }
}

function fileAgeMs(filePath, now) {
  try {
    return Math.max(0, now - fs.statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Age of a refresh lock. The lock body's `at` stamp is what the stale-reclaim
 * logic actually compares, so it wins over the file mtime; an unreadable body
 * falls back to mtime (a corrupt lock is reclaimed just like a stale one).
 */
function lockAgeMs(lockPath, now) {
  const raw = readJsonObject(lockPath);
  if (raw.state === 'ok' && Number.isFinite(raw.data.at)) {
    return Math.max(0, now - raw.data.at);
  }
  return fileAgeMs(lockPath, now);
}

function dirExists(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/** Classify the persisted quota cache beyond what readQuotaCache collapses. */
function classifyQuotaCache(filePath) {
  const file = readJsonObject(filePath);
  if (file.state !== 'ok') return file;
  const data = file.data;
  if (data.version !== 2) return { state: 'legacy', data: null };
  if (
    typeof data.contextKey !== 'string'
    || !/^[0-9a-f]{16}$/.test(data.contextKey)
    || typeof data.fetchedAt !== 'number'
    || !Number.isFinite(data.fetchedAt)
  ) {
    return { state: 'corrupt', data: null };
  }
  return file;
}

/** Group provider-usage directory entries by account stem. */
function scanProviderGroups(providerUsageDir, now) {
  let names;
  try {
    names = fs.readdirSync(providerUsageDir);
  } catch {
    return [];
  }
  const groups = new Map();
  for (const name of names) {
    const m = name.match(PROVIDER_GROUP_RE);
    if (!m) continue;
    const stem = `${m[1]}-${m[2]}`;
    const group = groups.get(stem) || {
      provider: m[1],
      fingerprint: m[2],
      cachePath: null,
      statePath: null,
      lockPath: null,
    };
    if (m[3] === 'json') group.cachePath = path.join(providerUsageDir, name);
    else if (m[3] === 'state.json') group.statePath = path.join(providerUsageDir, name);
    else group.lockPath = path.join(providerUsageDir, name);
    groups.set(stem, group);
  }
  for (const group of groups.values()) {
    group.cache = group.cachePath ? classifyProviderCache(group.cachePath, now) : { state: 'missing' };
    group.state = group.statePath ? readRefreshState(group.statePath) : null;
    group.statePresent = group.statePath !== null;
    group.lockAgeMs = group.lockPath ? fileAgeMs(group.lockPath, now) : null;
  }
  return [...groups.values()];
}

function classifyProviderCache(filePath, now) {
  const file = readJsonObject(filePath);
  if (file.state !== 'ok') return file;
  const data = file.data;
  if (
    data.version !== 1
    || typeof data.provider !== 'string'
    || !/^[a-f0-9]{16}$/.test(data.credentialFingerprint || '')
    || typeof data.fetchedAt !== 'number'
    || !Number.isFinite(data.fetchedAt)
  ) {
    return { state: 'corrupt', data: null };
  }
  const ageMs = now - data.fetchedAt;
  return {
    state: ageMs > PROVIDER_USAGE_TTL_MS ? 'stale' : 'fresh',
    data,
    ageMs,
  };
}

/** Every provider name configured in config.toml (provider tables + models). */
function configuredProviderNames(configText) {
  const names = new Set();
  const providerRe = /\[providers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/g;
  let m;
  while ((m = providerRe.exec(configText)) !== null) names.add(m[1] || m[2]);
  const modelRe = /\[models\."([^"]+)"\]\s*\n([\s\S]*?)(?=\n\[|$)/g;
  while ((m = modelRe.exec(configText)) !== null) {
    const provider = decodedStringValue(m[2], 'provider');
    if (provider) names.add(provider);
  }
  return [...names];
}

/** Managed-plugin install state for the running script path. */
function managedPluginState(scriptPath, kimiHome) {
  const id = managedPluginId(scriptPath);
  if (!id) return { kind: 'plain' };
  const file = readJsonObject(path.join(kimiHome, 'plugins', 'installed.json'));
  if (file.state === 'missing') return { kind: 'store-missing', id };
  if (file.state !== 'ok') return { kind: 'store-malformed', id };
  const plugins = Array.isArray(file.data.plugins) ? file.data.plugins : null;
  if (!plugins) return { kind: 'store-malformed', id };
  const record = plugins.find((p) => p && p.id === id);
  if (!record) return { kind: 'no-record', id };
  return { kind: record.enabled === false ? 'disabled' : 'enabled', id };
}

/**
 * Collect every doctor fact. Strictly read-only: file reads, stats and one
 * directory listing per location — no writes, no network, no spawns.
 * @param {object} [opts]
 * @param {object} [opts.paths] resolveRuntimePaths() snapshot
 * @param {object} [opts.env] environment for quota endpoint resolution
 * @param {string|null} [opts.scriptPath] absolute path of bin/kimi-hud.mjs
 * @param {number} [opts.now] diagnostic clock
 * @returns {{now: number, paths: object, checks: object[]}}
 */
export function collectDoctorReport({
  paths,
  env = {},
  scriptPath = null,
  now = Date.now(),
} = {}) {
  const p = paths;
  const checks = [];
  const add = (section, level, label, detail, extra = {}) => {
    checks.push({ section, level, label, detail, ...extra });
  };

  const tui = readTextFile(p.tuiTomlPath);
  const configToml = readTextFile(p.configTomlPath);
  const hudConfig = readJsonObject(p.configPath);

  // --- environment ---------------------------------------------------------
  add('environment', dirExists(p.kimiHome) ? 'ok' : 'note', 'kimi home',
    dirExists(p.kimiHome) ? 'present' : 'absent — created on first host run',
    { path: p.kimiHome });
  add('environment', dirExists(p.hudDir) ? 'ok' : 'note', 'hud home',
    dirExists(p.hudDir) ? 'present' : 'absent — caches appear after the first render',
    { path: p.hudDir });
  add('environment',
    tui.state === 'ok' ? 'ok' : tui.state === 'missing' ? 'note' : 'warn',
    'tui.toml',
    tui.state === 'ok' ? 'readable' : tui.state === 'missing' ? 'absent' : 'exists but cannot be read',
    { path: p.tuiTomlPath });
  add('environment',
    configToml.state === 'ok' ? 'ok' : configToml.state === 'missing' ? 'note' : 'warn',
    'config.toml',
    configToml.state === 'ok'
      ? 'readable'
      : configToml.state === 'missing'
        ? 'absent — quota region falls back to the default endpoint'
        : 'exists but cannot be read — quota context falls back to the default',
    { path: p.configTomlPath });
  if (hudConfig.state === 'ok') {
    const disabled = hudConfig.data.disabled === true;
    const layout = hudConfig.data.layout === 'compact' || hudConfig.data.layout === 'normal'
      ? hudConfig.data.layout
      : 'default';
    add('environment', disabled ? 'warn' : 'ok', 'HUD config.json',
      disabled ? 'readable, but switched off' : `readable (layout: ${layout})`,
      { path: p.configPath });
  } else {
    add('environment',
      hudConfig.state === 'missing' ? 'ok' : 'warn',
      'HUD config.json',
      hudConfig.state === 'missing'
        ? 'absent — defaults in effect'
        : `${hudConfig.state} — ignored, defaults in effect`,
      { path: p.configPath });
  }
  add('environment', dirExists(p.sessionsRoot) ? 'ok' : 'note', 'host sessions',
    dirExists(p.sessionsRoot) ? 'present' : 'absent — no host sessions yet',
    { path: p.sessionsRoot });

  // --- install & ownership --------------------------------------------------
  let statusLine = null;
  if (tui.state === 'ok') {
    statusLine = inspectStatusLineCommand(tui.text);
    if (statusLine.kind === 'absent') {
      add('install', 'note', 'status line', 'not installed',
        { hint: 'run `kimi-code-hud --install` to register it' });
    } else if (statusLine.kind === 'unknown') {
      add('install', 'warn', 'status line',
        'unrecognized [status_line] command syntax — the HUD cannot verify ownership');
    } else if (isKimiHudCommand(statusLine.value)) {
      const sameCopy = scriptPath === null
        || statusLine.value === nodeCommand(scriptPath);
      add('install', 'ok', 'status line',
        sameCopy ? 'installed (this copy)' : 'installed, but pointing at a different kimi-hud copy',
        sameCopy ? {} : { hint: 'run `kimi-code-hud --install` again from this copy to re-point it' });
    } else {
      add('install', 'warn', 'status line',
        'a third-party status line occupies the slot — the HUD will not render',
        { hint: 'run `kimi-code-hud --install` to replace it (a .bak backup is kept)' });
    }
  } else if (tui.state === 'missing') {
    add('install', 'note', 'status line', 'not installed (tui.toml absent)',
      { hint: 'run `kimi-code-hud --install` to register it' });
  } else {
    add('install', 'warn', 'status line', 'install state unknown (tui.toml unreadable)');
  }
  const hookRegistered = configToml.state === 'ok' && configToml.text.includes(HOOK_MARKER);
  add('install', hookRegistered ? 'ok' : 'note', 'SessionStart hook',
    hookRegistered
      ? 'self-heal hook registered in config.toml'
      : 'not registered (optional; --install adds it — it repairs the status line on session start)');
  const plugin = managedPluginState(scriptPath, p.kimiHome);
  if (plugin.kind === 'plain') {
    add('install', 'ok', 'plugin install', 'plain install (not a managed plugin copy)');
  } else if (plugin.kind === 'enabled') {
    add('install', 'ok', 'plugin install', 'managed plugin record present and enabled');
  } else if (plugin.kind === 'disabled') {
    add('install', 'warn', 'plugin install',
      'plugin disabled in plugins/installed.json — the HUD stays silent');
  } else if (plugin.kind === 'no-record' || plugin.kind === 'store-missing') {
    add('install', 'warn', 'plugin install',
      'managed copy present but the install record is gone — the HUD stays silent',
      { hint: 'reinstall or re-enable the plugin' });
  } else {
    add('install', 'note', 'plugin install',
      'plugins/installed.json unreadable — treated as enabled (fail-open)');
  }
  const offSwitch = isHudDisabled(p.configPath);
  add('install', offSwitch ? 'warn' : 'ok', 'on/off switch',
    offSwitch ? 'switched off via --off' : 'enabled',
    offSwitch ? { hint: 'run `kimi-code-hud --on` to re-enable' } : {});

  // --- quota (managed Kimi subscription) ------------------------------------
  const endpoints = resolveQuotaEndpoints({
    env,
    configPath: p.configTomlPath,
    kimiHome: p.kimiHome,
  });
  const contextKey = quotaContextKeyFor(
    endpoints.credentialsPath,
    endpoints.url,
    credentialFileFingerprint(endpoints.credentialsPath),
  );
  let endpointHost = endpoints.url;
  try {
    endpointHost = new URL(endpoints.url).hostname;
  } catch { /* keep raw url — resolution is fail-closed to official hosts */ }
  add('quota', 'ok', 'context',
    `endpoint ${endpointHost} · slot ${path.basename(endpoints.credentialsPath)} · context ${contextKey}`);
  const credentials = readJsonObject(endpoints.credentialsPath);
  if (credentials.state === 'ok') {
    const hasAccess = typeof credentials.data.access_token === 'string'
      && credentials.data.access_token.length > 0;
    const hasRefresh = typeof credentials.data.refresh_token === 'string'
      && credentials.data.refresh_token.length > 0;
    add('quota', hasAccess ? 'ok' : 'note', 'credentials',
      hasAccess
        ? `access token present${hasRefresh ? '' : ' (no refresh token)'}`
        : 'no access token on disk (signed out) — quota stays hidden until the next login',
      { path: endpoints.credentialsPath });
  } else {
    add('quota', 'note', 'credentials',
      credentials.state === 'missing'
        ? 'credentials file absent — quota appears after signing in'
        : `credentials file ${credentials.state}`,
      { path: endpoints.credentialsPath });
  }
  const cache = classifyQuotaCache(p.quotaCachePath);
  if (cache.state === 'ok') {
    const age = quotaAge(cache.data, now);
    const matches = cache.data.contextKey === contextKey;
    let level = age.state === QUOTA_AGE.FRESH ? 'ok' : 'note';
    let detail;
    if (age.state === QUOTA_AGE.FRESH) detail = `fresh, age ${formatDuration(age.ageMs)}`;
    else if (age.state === QUOTA_AGE.STALE) {
      detail = `stale, age ${formatDuration(age.ageMs)} — rendered dimmed with a [stale] marker`;
    } else if (age.ageMs !== null && age.ageMs < 0) {
      detail = 'timestamp ahead of the clock — treated as expired, figures hidden';
    } else {
      detail = 'expired — figures hidden until the next successful refresh';
    }
    if (matches) detail += '; context matches the current config';
    else {
      level = 'warn';
      detail += '; context mismatch — figures hidden until a refresh for the current context';
    }
    add('quota', level, 'cache', detail, { path: p.quotaCachePath });
  } else if (cache.state === 'missing') {
    add('quota', 'note', 'cache', 'no cache yet — the first render spawns a background refresh',
      { path: p.quotaCachePath });
  } else if (cache.state === 'legacy') {
    add('quota', 'warn', 'cache',
      'untagged legacy cache (no context attribution) — ignored; the next successful refresh rewrites a tagged cache',
      { path: p.quotaCachePath });
  } else if (cache.state === 'corrupt') {
    add('quota', 'warn', 'cache',
      'corrupt JSON — ignored; the next successful refresh rewrites it (safe to delete)',
      { path: p.quotaCachePath });
  } else {
    add('quota', 'warn', 'cache', 'exists but cannot be read', { path: p.quotaCachePath });
  }
  const refreshState = readRefreshState(p.quotaRefreshStatePath);
  if (refreshState === null) {
    const raw = readJsonObject(p.quotaRefreshStatePath);
    if (raw.state !== 'missing') {
      add('quota', 'warn', 'refresh state', 'corrupt refresh state — ignored', {
        path: p.quotaRefreshStatePath,
      });
    } else {
      add('quota', 'ok', 'refresh state', 'no failed refreshes recorded');
    }
  } else {
    const blocked = now < refreshState.nextAttemptAt;
    const foreign = typeof refreshState.contextKey === 'string'
      && refreshState.contextKey !== contextKey;
    let detail = blocked
      ? `backoff in effect after ${refreshState.failures} failure(s) (${refreshState.category}); next attempt ${formatUntil(refreshState.nextAttemptAt, now)}`
      : `last failure ${refreshState.category} ×${refreshState.failures}; retry allowed now`;
    if (foreign) {
      detail += '; state belongs to a different credential context — it does not gate the current context; a first attempt is not delayed by this window';
    }
    add('quota', 'note', 'refresh state', detail, {
      path: p.quotaRefreshStatePath,
      hint: blocked
        ? 'no action needed — the HUD retries automatically; quota may stay dimmed ([stale]) until a success'
        : undefined,
    });
  }
  const lockAge = lockAgeMs(p.quotaLockPath, now);
  if (lockAge === null) {
    add('quota', 'ok', 'refresh lock', 'idle');
  } else if (lockAge < LOCK_STALE_MS) {
    add('quota', 'note', 'refresh lock', 'lock present — a detached refresh may be running');
  } else {
    add('quota', 'note', 'refresh lock',
      `leftover lock, age ${formatDuration(lockAge)} — reclaimed automatically on the next refresh`);
  }

  // --- provider usage -------------------------------------------------------
  if (configToml.state === 'ok') {
    const supported = new Set([MANAGED_KIMI_PROVIDER, DEEPSEEK_PROVIDER]);
    const unsupported = configuredProviderNames(configToml.text)
      .filter((name) => !supported.has(name));
    if (unsupported.length > 0) {
      add('providers', 'note', 'usage targets',
        `no usage adapter for: ${unsupported.join(', ')} — balances render only for `
        + `${DEEPSEEK_PROVIDER}; quota bars only for ${MANAGED_KIMI_PROVIDER}`);
    }
    const groups = scanProviderGroups(p.providerUsageDir, now);
    const target = resolveProviderUsageTarget({
      provider: DEEPSEEK_PROVIDER,
      configText: configToml.text,
      providerUsageDir: p.providerUsageDir,
    });
    let currentStem = null;
    if (findProviderTable(configToml.text, DEEPSEEK_PROVIDER) !== null) {
      if (target === null) {
        add('providers', 'note', DEEPSEEK_PROVIDER,
          'provider table present but unusable for balance (missing api_key, or base_url is '
          + 'not the official endpoint) — the balance stays hidden by design');
      } else {
        currentStem = `${target.provider}-${target.credentialFingerprint}`;
        const group = groups.find((g) => g.provider === target.provider
          && g.fingerprint === target.credentialFingerprint);
        const dc = group ? group.cache : { state: 'missing' };
        if (dc.state === 'fresh') {
          add('providers', 'ok', DEEPSEEK_PROVIDER,
            `cache fresh, age ${formatDuration(dc.ageMs)} · account ${target.credentialFingerprint}`);
        } else if (dc.state === 'stale') {
          add('providers', 'note', DEEPSEEK_PROVIDER,
            `cache stale, age ${formatDuration(dc.ageMs)} — rendered dimmed · account ${target.credentialFingerprint}`);
        } else if (dc.state === 'missing') {
          add('providers', 'note', DEEPSEEK_PROVIDER,
            `no cache yet — the first render spawns a background refresh · account ${target.credentialFingerprint}`);
        } else if (dc.state === 'corrupt' || dc.state === 'legacy') {
          add('providers', 'warn', DEEPSEEK_PROVIDER,
            `${dc.state} cache record — ignored; the next successful refresh rewrites it`);
        } else {
          add('providers', 'warn', DEEPSEEK_PROVIDER, 'cache exists but cannot be read');
        }
        const ds = group && group.statePresent ? group.state : undefined;
        if (ds === null) {
          add('providers', 'warn', `${DEEPSEEK_PROVIDER} refresh state`,
            'corrupt refresh state — ignored');
        } else if (ds && now < ds.nextAttemptAt) {
          add('providers', 'note', `${DEEPSEEK_PROVIDER} refresh state`,
            `backoff in effect after ${ds.failures} failure(s) (${ds.category}); next attempt ${formatUntil(ds.nextAttemptAt, now)}`);
        }
      }
    }
    const others = groups.filter((g) => `${g.provider}-${g.fingerprint}` !== currentStem);
    for (const group of others) {
      const parts = [];
      if (group.cache.state === 'fresh') parts.push(`cache fresh, age ${formatDuration(group.cache.ageMs)}`);
      else if (group.cache.state === 'stale') parts.push(`cache stale, age ${formatDuration(group.cache.ageMs)}`);
      else if (group.cache.state === 'missing') parts.push('no cache');
      else parts.push(`cache ${group.cache.state}`);
      if (group.state) {
        parts.push(group.state.failures === 1 ? '1 recorded failure' : `${group.state.failures} recorded failures`);
      }
      add('providers', 'note', 'other cached account',
        `${group.provider} · account ${group.fingerprint} · ${parts.join(', ')} — not displayed (different credential)`);
    }
  }

  // --- sessions ---------------------------------------------------------------
  let metricsCount = 0;
  try {
    metricsCount = fs.readdirSync(p.sessionStateDir)
      .filter((name) => METRICS_STATE_RE.test(name)).length;
  } catch { /* directory absent */ }
  add('sessions', metricsCount > 0 ? 'ok' : 'note', 'session metrics',
    metricsCount > 0
      ? `${metricsCount} session state file${metricsCount === 1 ? '' : 's'}`
      : 'none yet — metrics appear after the first turn in a Kimi Code session',
    { path: p.sessionStateDir });

  // --- git status cache -------------------------------------------------------
  const gitCache = readJsonObject(p.gitStatusCachePath);
  if (gitCache.state === 'missing') {
    add('git status', 'note', 'cache', 'none yet — the first branch render creates it');
  } else if (
    gitCache.state !== 'ok'
    || gitCache.data.version !== GIT_STATUS_CACHE_VERSION
    || !gitCache.data.entries
    || typeof gitCache.data.entries !== 'object'
    || Array.isArray(gitCache.data.entries)
  ) {
    add('git status', 'warn', 'cache',
      `${gitCache.state === 'ok' ? 'unrecognized format' : gitCache.state} — ignored; rewritten automatically`);
  } else {
    const entries = Object.values(gitCache.data.entries);
    const newest = entries.reduce((acc, e) => Math.max(acc, e && e.checkedAt) || acc, 0);
    add('git status', 'ok', 'cache',
      `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
        + (newest > 0 ? `, newest ${formatDuration(Math.max(0, now - newest))} ago` : ''));
  }

  return { now, paths: p, checks };
}

/**
 * Exit code contract: 0 when everything examined is healthy, 1 when any
 * warning needs attention (corrupt files, a foreign status line, a disabled
 * or unrecorded plugin install, a context mismatch). Notes never change the
 * exit code.
 * @param {object} report result of collectDoctorReport
 * @returns {0|1}
 */
export function doctorExitCode(report) {
  return report.checks.some((c) => c.level === DOCTOR_LEVEL.WARN) ? 1 : 0;
}

// Share-mode path policy. Paths under a known root are rewritten to a logical
// label ($KIMI_CODE_HOME/..., $KIMI_HUD_HOME/..., ~, ~tmp); any other absolute
// path is hidden outright — a custom KIMI_CODE_HOME on a customer volume or a
// project checkout must never reach a public issue verbatim. Absolute covers
// the POSIX and Windows drive-letter shapes plus Windows UNC
// (\\server\share\...) and the extended-length \\?\... device forms. Local
// (non-shareable) output is passed through untouched.
const HIDDEN_PATH = '<absolute-path-hidden>';

// UNC recognition: \\server\share (server and share both non-empty) and the
// extended-length device forms \\?\C:\... / \\?\UNC\server\share\...
const UNC_PATH_RE = /^\\\\(?:\?\\|[^\\]+\\[^\\])/;

// Absolute-path tokens inside free text: UNC (matched first so a UNC-shaped
// token is consumed whole), Windows drive-letter style, and POSIX-style (not
// part of a URL or a larger word). The UNC alternatives after `\\` are, in
// order: the extended drive form \\?\C:\... (its colon is consumed
// explicitly — the classes below stop at `:` to keep https: out), the other
// \\?\ device forms, and plain \\server\share\.... The classes stop at
// whitespace, quotes/backticks and closers (,;:)] — but keep dots and
// separators, which occur inside path components, so punctuation glued to a
// token is redacted together with it.
const POSIX_PATH_TOKEN_RE = /(?<![:/\w])\/[^\s'"`,;:)\]]*/g;
const WINDOWS_PATH_TOKEN_RE = /\b[A-Za-z]:[\\/][^\s'"`,;:)\]]*/g;
const UNC_PATH_TOKEN_RE = /(?<!\\)\\\\(?:\?\\[A-Za-z]:[\\/][^\s'"`,;:)\]]*(?:\\[^\\\s'"`,;:)\]]*)*|\?\\[^\\\s'"`,;:)\]]*(?:\\[^\\\s'"`,;:)\]]*)*|[^\\\s'"`,;:)\]]*(?:\\[^\\\s'"`,;:)\]]*)*)/g;

// Strip the \\?\ device prefixes: `\\?\C:\x` and `\\?\UNC\server\share\x`
// compare as their plain drive/UNC equivalents. `skip` is how many characters
// of the original string the plain form's head does not account for: 4 for
// the `\\?\` marker, 6 for `?\UNC\` (the plain UNC's leading `\\` maps onto
// the original's own first two backslashes).
function plainWindowsForm(value) {
  if (value.startsWith('\\\\?\\UNC\\')) return { skip: 6, text: `\\\\${value.slice(8)}` };
  if (value.startsWith('\\\\?\\')) return { skip: 4, text: value.slice(4) };
  return { skip: 0, text: value };
}

/** Known roots, longest first, so nested roots (kimi home under ~) win. */
function shareRoots({ paths, home, tmp }) {
  return [
    [paths && paths.kimiHome, '$KIMI_CODE_HOME'],
    [paths && paths.hudDir, '$KIMI_HUD_HOME'],
    [home, '~'],
    [tmp, '~tmp'],
  ]
    .filter(([prefix]) => typeof prefix === 'string' && prefix.length > 1)
    .sort((a, b) => plainWindowsForm(b[0]).text.length - plainWindowsForm(a[0]).text.length);
}

/**
 * Remainder of `value` after its `prefix`-shaped head, or null when `value` is
 * neither the prefix itself nor under it. Windows-flavored roots (drive
 * letters, UNC) match either separator, fold case, and accept the
 * extended-length forms of both sides; POSIX roots stay verbatim.
 */
function remainderUnder(value, prefix) {
  if (!(/^[A-Za-z]:/.test(prefix) || prefix.startsWith('\\\\'))) {
    if (value === prefix) return '';
    if (value.startsWith(`${prefix}/`) || value.startsWith(prefix + path.sep)) {
      return value.slice(prefix.length);
    }
    return null;
  }
  const v = plainWindowsForm(value);
  const p = plainWindowsForm(prefix);
  const head = p.text.toLowerCase();
  const body = v.text.toLowerCase();
  if (body !== head && !body.startsWith(`${head}/`) && !body.startsWith(`${head}\\`)) {
    return null;
  }
  return value.slice(v.skip + p.text.length);
}

function redactPathValue(value, roots) {
  if (typeof value !== 'string' || value === '') return value;
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value) && !UNC_PATH_RE.test(value)) {
    return value;
  }
  for (const [prefix, label] of roots) {
    const remainder = remainderUnder(value, prefix);
    if (remainder !== null) return label + remainder;
  }
  return HIDDEN_PATH;
}

function redactPathTokens(text, roots) {
  if (typeof text !== 'string') return text;
  return text
    .replace(UNC_PATH_TOKEN_RE, (token) => redactPathValue(token, roots))
    .replace(WINDOWS_PATH_TOKEN_RE, (token) => redactPathValue(token, roots))
    .replace(POSIX_PATH_TOKEN_RE, (token) => redactPathValue(token, roots));
}

/**
 * Render the report as plain text. Every line stays free of session content,
 * tokens and config bodies in both modes. Shareable mode additionally rewrites
 * paths under known roots to logical labels ($KIMI_CODE_HOME, $KIMI_HUD_HOME,
 * ~, ~tmp) and hides every other absolute path as <absolute-path-hidden> —
 * POSIX, drive-letter, UNC and \\?\ extended shapes, in `path` fields and
 * inside free text (detail, hint) alike — so the report can be pasted into an
 * issue.
 * @param {object} report result of collectDoctorReport
 * @param {object} [opts]
 * @param {boolean} [opts.shareable] mask personal paths for pasting into issues
 * @param {string} [opts.home] home prefix to mask (default os.homedir())
 * @param {string} [opts.tmp] tmp prefix to mask (default os.tmpdir())
 * @returns {string} complete report including trailing newline
 */
export function formatDoctorReport(report, {
  shareable = false,
  home = os.homedir(),
  tmp = os.tmpdir(),
} = {}) {
  const roots = shareable ? shareRoots({ paths: report.paths, home, tmp }) : [];
  const mask = (value) => (shareable ? redactPathValue(value, roots) : value);
  const maskText = (value) => (shareable ? redactPathTokens(value, roots) : value);
  const lines = [`kimi-code-hud doctor — read-only diagnostics`, ``];
  let section = null;
  for (const check of report.checks) {
    if (check.section !== section) {
      section = check.section;
      lines.push(`${section}`);
    }
    lines.push(`  [${check.level}] ${check.label}: ${maskText(check.detail)}`);
    if (check.path) lines.push(`        path: ${mask(check.path)}`);
    if (check.hint) lines.push(`        hint: ${maskText(check.hint)}`);
  }
  const warnings = report.checks.filter((c) => c.level === DOCTOR_LEVEL.WARN).length;
  const notes = report.checks.filter((c) => c.level === DOCTOR_LEVEL.NOTE).length;
  const code = doctorExitCode(report);
  lines.push('');
  lines.push(
    `result: ${code === 0 ? 'healthy' : 'attention needed'} (exit ${code}) — `
    + `${warnings} warning${warnings === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}`,
  );
  return `${lines.join('\n')}\n`;
}
