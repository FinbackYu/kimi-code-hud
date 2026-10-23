// Zhipu GLM Coding Plan adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns two
// provider surfaces plus one fallback: the Coding Plan quota endpoint on the
// CN and international hosts, and the CN-only account balance report.
//
// id: 'zhipuai-coding-plan' · hosts: open.bigmodel.cn, api.z.ai · metric: usage
// accepts(config): the region is decided by the official host alone — CN
//   accounts live on open.bigmodel.cn, international accounts on api.z.ai —
//   and both hosts are the ones the configured key already targets. Any
//   inference path on those hosts is accepted (the host is the credential
//   boundary); proxies fail closed. Only the CN service exposes an account
//   balance report, so the international region has no fallback.
// request(): one quota GET; body-level failures fall back to the CN balance
//   report, and only there is a second request spent.
//
// Provider names no longer select this adapter; the historical alias list is
// kept as documentation of the names users configure for the same plan.

import {
  MAX_RESPONSE_BYTES,
  REQUEST_CATEGORY,
  requestJsonWithLimits,
} from '../request-guard.mjs';
import {
  PROVIDER_USAGE_RESULT,
  credentialedHttpsUrl,
  normalizeUsage,
  officialHostUrl,
} from './common.mjs';

export const ZHIPU_PROVIDER = 'zhipuai-coding-plan';
export const ZHIPU_PROVIDER_ALIASES = Object.freeze([
  'zhipuai-coding-plan',
  'zhipu-coding-plan',
  'zhipu',
  'zai',
]);
export const ZHIPU_CN_USAGE_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
export const ZHIPU_INTL_USAGE_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
export const ZHIPU_CN_BALANCE_URL = 'https://www.bigmodel.cn/api/biz/account/query-customer-account-report';

const ZHIPU_CN_HOST = 'open.bigmodel.cn';
const ZHIPU_INTL_HOST = 'api.z.ai';
const ZHIPU_BALANCE_HOST = 'www.bigmodel.cn';
const ZHIPU_HOSTS = Object.freeze([ZHIPU_CN_HOST, ZHIPU_INTL_HOST]);

/** One finite number from a JSON field, or null when the field is absent,
 * blank, or not a finite number. `Number(null)` would read as 0, so presence
 * is checked before coercion. */
function zhipuNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/** Window length in minutes; unit 1 = day, 3 = hour, 5 = minute, 6 = week. */
const ZHIPU_UNIT_MINUTES = Object.freeze({ 1: 1440, 3: 60, 5: 1, 6: 10080 });
const ZHIPU_TOKEN_LIMIT_TYPES = new Set(['TOKENS_LIMIT', 'CREDIT_LIMIT']);
// TIME_LIMIT is the monthly MCP tool allowance; its unit/number pair describes
// one tool call, not the reset period, so the reset-defense horizon is a month.
const ZHIPU_MCP_WINDOW_MINUTES = 43_200;
const ZHIPU_RESET_SLACK_MS = 300_000;

function zhipuWindowMinutes(number, unit) {
  const multiplier = ZHIPU_UNIT_MINUTES[unit];
  const count = zhipuNumber(number);
  if (multiplier === undefined || count === null || count <= 0) return null;
  const minutes = count * multiplier;
  return Number.isInteger(minutes) ? minutes : null;
}

function zhipuWindowLabel(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return '7d';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function zhipuUsedRatio(raw) {
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const usage = zhipuNumber(raw.usage);
  const current = zhipuNumber(raw.currentValue);
  const remaining = zhipuNumber(raw.remaining);
  if (usage !== null && usage > 0 && current !== null && remaining !== null) {
    return clamp(Math.max(usage - remaining, current) / usage);
  }
  const percentage = zhipuNumber(raw.percentage);
  return percentage !== null && percentage >= 0 ? clamp(percentage / 100) : null;
}

/**
 * Reset time as ISO text. A reset stamped further out than a window's own
 * length (plus five minutes of slack) cannot belong to that window — the
 * service has been seen to attach a neighbouring window's reset — so only the
 * percentage survives.
 */
function zhipuResetAt(raw, windowMinutes, now) {
  const stamp = zhipuNumber(raw.nextResetTime);
  if (stamp === null || stamp <= 0) return null;
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) return null;
  if (windowMinutes < 1440 && stamp > now + windowMinutes * 60_000 + ZHIPU_RESET_SLACK_MS) {
    return null;
  }
  return date.toISOString();
}

function zhipuEnvelopeSucceeded(json) {
  if (json.success === false) return false;
  if (json.success === true) return true;
  const code = zhipuNumber(json.code);
  return code === 200;
}

/**
 * Parse the GLM Coding Plan quota response into provider-neutral windows.
 * TOKENS_LIMIT / CREDIT_LIMIT windows are collected in ascending duration and
 * labelled from their duration; TIME_LIMIT is the monthly MCP tool allowance
 * and rides along once as the `mcp` window. The response's `percentage` is
 * the used share; when the per-window counters are present they win because
 * they are recomputed rather than rounded.
 */
export function parseZhipuQuota(json, now = Date.now()) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || !zhipuEnvelopeSucceeded(json)) {
    return null;
  }
  const data = json.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const tokenWindows = [];
  let mcp = null;
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (raw.type === 'TIME_LIMIT') {
      if (mcp) continue;
      const ratio = zhipuUsedRatio(raw);
      if (ratio === null) continue;
      mcp = {
        label: 'mcp',
        usedRatio: ratio,
        resetAt: zhipuResetAt(raw, ZHIPU_MCP_WINDOW_MINUTES, now),
      };
      continue;
    }
    if (!ZHIPU_TOKEN_LIMIT_TYPES.has(raw.type)) continue;
    const minutes = zhipuWindowMinutes(raw.number, raw.unit);
    if (minutes === null) continue;
    const ratio = zhipuUsedRatio(raw);
    if (ratio === null) continue;
    tokenWindows.push({
      minutes,
      window: {
        label: zhipuWindowLabel(minutes),
        usedRatio: ratio,
        resetAt: zhipuResetAt(raw, minutes, now),
      },
    });
  }
  tokenWindows.sort((a, b) => a.minutes - b.minutes);
  const seen = new Set();
  const windows = [];
  for (const entry of tokenWindows) {
    if (seen.has(entry.window.label)) continue;
    seen.add(entry.window.label);
    windows.push(entry.window);
  }
  if (mcp) windows.push(mcp);
  if (windows.length === 0) return null;
  const planName = typeof data.planName === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,31}$/.test(data.planName)
    ? `Zhipu ${data.planName}`
    : 'Zhipu';
  return normalizeUsage({ kind: 'windows', label: planName, windows });
}

/**
 * Parse the CN account report into a plain CNY balance. `rechargeAmount` and
 * `giveAmount` are lifetime totals, not this account's current grants, so they
 * are deliberately not mapped onto granted/toppedUp.
 */
export function parseZhipuBalance(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || !zhipuEnvelopeSucceeded(json)) {
    return null;
  }
  const data = json.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const available = zhipuNumber(data.availableBalance) ?? zhipuNumber(data.balance);
  if (available === null || available < 0) return null;
  return normalizeUsage({
    kind: 'balance',
    label: 'Zhipu',
    available: true,
    balances: [{ currency: 'CNY', total: available, granted: null, toppedUp: null }],
  });
}

/** Pinned https URL: credential-safe, exact host, exact path, no query/hash. */
function pinnedZhipuUrl(value, hosts, pathname) {
  const parsed = officialHostUrl(value, hosts);
  return Boolean(parsed)
    && parsed.pathname === pathname
    && parsed.search === ''
    && parsed.hash === '';
}

function officialZhipuUsageUrl(value) {
  return pinnedZhipuUrl(value, [ZHIPU_CN_HOST, ZHIPU_INTL_HOST], '/api/monitor/usage/quota/limit');
}

function officialZhipuBalanceUrl(value) {
  return pinnedZhipuUrl(
    value,
    [ZHIPU_BALANCE_HOST],
    '/api/biz/account/query-customer-account-report',
  );
}

/**
 * Resolve the Zhipu endpoints from the provider's inference base URL. The
 * region is decided by the official host alone — CN accounts live on
 * open.bigmodel.cn, international accounts on api.z.ai — and both hosts are
 * the ones the configured key already targets. Only the CN service exposes an
 * account balance report, so the international region has no fallback.
 */
function zhipuEndpoints(config) {
  const parsed = credentialedHttpsUrl(config.baseUrl);
  if (!parsed) return null;
  if (parsed.hostname === ZHIPU_CN_HOST) {
    return {
      region: 'cn',
      usageUrl: ZHIPU_CN_USAGE_URL,
      balanceUrl: ZHIPU_CN_BALANCE_URL,
    };
  }
  if (parsed.hostname === ZHIPU_INTL_HOST) {
    return { region: 'intl', usageUrl: ZHIPU_INTL_USAGE_URL, balanceUrl: null };
  }
  return null;
}

/**
 * Fetch one Zhipu Coding Plan quota response. The service reports every
 * failure as HTTP 200 with `success: false` plus a body `code`, so the quota
 * body is inspected before any normalization: body `code` 401 is an auth
 * failure, and an expired or absent plan (as well as a `success: true` body
 * with no usable limits) falls back to the CN account balance. Only the CN
 * region has a balance report; the international region hides instead.
 * HTTP-level failures on the quota request are returned as-is, so a
 * transient error never spends a second request.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestZhipuUsage({
  apiKey,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const usageUrl = endpoints?.usageUrl;
  const balanceUrl = endpoints?.balanceUrl ?? null;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialZhipuUsageUrl(usageUrl)
    || (balanceUrl !== null && !officialZhipuBalanceUrl(balanceUrl))
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const quota = await requestJsonWithLimits({
    url: usageUrl,
    headers,
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: (json) => json,
    now,
  });
  if (quota.status !== PROVIDER_USAGE_RESULT.SUCCESS) return quota;
  const body = quota.parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  if (zhipuNumber(body.code) === 401) {
    return { status: PROVIDER_USAGE_RESULT.UNAUTHORIZED, category: REQUEST_CATEGORY.AUTH };
  }
  const parsedQuota = parseZhipuQuota(body, now);
  if (parsedQuota) return { status: PROVIDER_USAGE_RESULT.SUCCESS, parsed: parsedQuota };
  if (balanceUrl === null) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const balance = await requestJsonWithLimits({
    url: balanceUrl,
    headers,
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: (json) => json,
    now,
  });
  if (balance.status === PROVIDER_USAGE_RESULT.UNAUTHORIZED) return balance;
  const parsedBalance = balance.status === PROVIDER_USAGE_RESULT.SUCCESS
    ? parseZhipuBalance(balance.parsed)
    : null;
  return parsedBalance
    ? { status: PROVIDER_USAGE_RESULT.SUCCESS, parsed: parsedBalance }
    : { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
}

export const ADAPTER = Object.freeze({
  id: ZHIPU_PROVIDER,
  hosts: ZHIPU_HOSTS,
  metric: 'usage',
  accepts: zhipuEndpoints,
  request: requestZhipuUsage,
});
