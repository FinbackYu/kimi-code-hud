// MiniMax usage adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns the two
// account surfaces a MiniMax inference key can address, on the three official
// inference hosts.
//
// id: 'minimax' · hosts: api.minimax.io, api.minimax.cn, api.minimaxi.com ·
//   metric: usage windows
// accepts(config): the credential boundary is the official host. The three
//   inference hosts are exactly the ones the configured key already targets;
//   the public www.*/platform.* spellings are normalized onto their api.* twin
//   (same backend, same host family) so the key is only ever sent to the
//   canonical host. Proxies and lookalike suffixes fail closed. Any path on
//   the accepted host is allowed — the host is the boundary, not the path.
// request(): the key prefix decides the surface, mirroring the official CLI:
//   `sk-api-*` pay-as-you-go keys read /account/query_balance; every other
//   (subscription) key reads /v1/token_plan/remains. Both endpoints answer
//   with a `base_resp` envelope, which is inspected before normalization.

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

export const MINIMAX_PROVIDER = 'minimax';

export const MINIMAX_USAGE_PATH = '/v1/token_plan/remains';
export const MINIMAX_BALANCE_PATH = '/account/query_balance';

export const MINIMAX_GLOBAL_USAGE_URL = 'https://api.minimax.io/v1/token_plan/remains';
export const MINIMAX_GLOBAL_BALANCE_URL = 'https://api.minimax.io/account/query_balance';
export const MINIMAX_CN_USAGE_URL = 'https://api.minimax.cn/v1/token_plan/remains';
export const MINIMAX_CN_BALANCE_URL = 'https://api.minimax.cn/account/query_balance';
export const MINIMAX_CN_LEGACY_USAGE_URL = 'https://api.minimaxi.com/v1/token_plan/remains';
export const MINIMAX_CN_LEGACY_BALANCE_URL = 'https://api.minimaxi.com/account/query_balance';

export const MINIMAX_HOSTS = Object.freeze([
  'api.minimax.io',
  'api.minimax.cn',
  'api.minimaxi.com',
]);

// Canonical host -> region and settlement currency. `*.minimax.io` is
// denominated in USD; the CN hosts (current and legacy) in CNY.
const MINIMAX_SURFACES = Object.freeze({
  'api.minimax.io': Object.freeze({ region: 'global', currency: 'USD' }),
  'api.minimax.cn': Object.freeze({ region: 'cn', currency: 'CNY' }),
  'api.minimaxi.com': Object.freeze({ region: 'cn', currency: 'CNY' }),
});

// Public spellings the same backend answers on, mapped to their api.* twin.
// The key is never sent to these hosts; only the canonical URL is requested.
const MINIMAX_HOST_ALIASES = Object.freeze({
  'www.minimax.io': 'api.minimax.io',
  'platform.minimax.io': 'api.minimax.io',
  'www.minimax.cn': 'api.minimax.cn',
  'platform.minimaxi.com': 'api.minimaxi.com',
});

// The envelope codes the service uses for an unusable credential: 1004
// covers the "carry the API secret key" / "invalid api key" / web-session
// messages, 1001 and 2049 appear as invalid-key variants.
const MINIMAX_AUTH_CODES = new Set([1001, 1004, 2049]);

// Models whose `model_remains` rows describe text-generation quota. Video,
// speech and image rows carry their own windows and must not be mixed in.
const MINIMAX_TEXT_MODEL_RE = /^(?:minimax-m\d.*|m\d+(?:\.\d+)?)$/;

function miniMaxNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value.trim());
  return Number.isFinite(amount) ? amount : null;
}

/** The `base_resp.status_code` of a MiniMax body, or null when the envelope
 * is absent or not a number. */
function miniMaxEnvelopeCode(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const resp = json.base_resp;
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return null;
  return miniMaxNumber(resp.status_code);
}

/** The object that carries `model_remains` and the plan title. New responses
 * wrap it in `data`; the official CLI fixture is flat. */
function miniMaxUsageSource(json) {
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
    if (Array.isArray(json.data.model_remains)) return json.data;
  }
  return json;
}

function isMiniMaxTextModelName(value) {
  if (typeof value !== 'string') return false;
  const name = value.trim().toLowerCase();
  return name === 'general' || MINIMAX_TEXT_MODEL_RE.test(name);
}

function miniMaxTextRows(rows) {
  const textRows = rows.filter((row) => row
    && typeof row === 'object'
    && !Array.isArray(row)
    && isMiniMaxTextModelName(row.model_name));
  const general = textRows.filter((row) => row.model_name.trim().toLowerCase() === 'general');
  const rest = textRows.filter((row) => !general.includes(row));
  return [...general, ...rest];
}

/** Remaining percentage as a 0..100 number; strings are accepted because the
 * service has shipped `"96"`. Anything outside that range is unusable. */
function miniMaxRemainingPercent(value) {
  const percent = miniMaxNumber(value);
  if (percent === null || percent < 0 || percent > 100) return null;
  return percent;
}

/**
 * Reset time as ISO text. The service stamps `end_time` in epoch
 * milliseconds; values too small to be milliseconds are not coerced, and the
 * `remains_time` fallback decides the unit by magnitude (values above 1e6 are
 * milliseconds, everything else seconds).
 */
function miniMaxResetAt(endValue, remainsValue, now) {
  const end = miniMaxNumber(endValue);
  if (end !== null && end >= 1_000_000_000_000) {
    const date = new Date(end);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const remains = miniMaxNumber(remainsValue);
  if (remains !== null && remains >= 0 && Number.isFinite(now)) {
    const ms = remains > 1_000_000 ? remains : remains * 1000;
    const date = new Date(now + ms);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function miniMaxWindow(label, remaining, endValue, remainsValue, now) {
  return {
    label,
    usedRatio: Math.min(1, Math.max(0, (100 - remaining) / 100)),
    resetAt: miniMaxResetAt(endValue, remainsValue, now),
  };
}

/**
 * The 5-hour window. `current_interval_status` 3 means unlimited (the service
 * ships such placeholder rows), and an unlimited row carries no window.
 */
function miniMaxIntervalWindow(row, now) {
  if (miniMaxNumber(row.current_interval_status) === 3) return null;
  const remaining = miniMaxRemainingPercent(row.current_interval_remaining_percent);
  return remaining === null
    ? null
    : miniMaxWindow('5h', remaining, row.end_time, row.remains_time, now);
}

function miniMaxWeeklyWindow(row, now) {
  const remaining = miniMaxRemainingPercent(row.current_weekly_remaining_percent);
  return remaining === null
    ? null
    : miniMaxWindow('7d', remaining, row.weekly_end_time, row.weekly_remains_time, now);
}

function miniMaxWindowsForRow(row, now) {
  return [
    miniMaxIntervalWindow(row, now),
    miniMaxWeeklyWindow(row, now),
  ].filter(Boolean);
}

/** Plan title, kept only when it fits the display-safe label alphabet. */
function miniMaxLabel(source) {
  const title = typeof source.current_subscribe_title === 'string'
    ? source.current_subscribe_title.trim()
    : '';
  return /^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,23}$/.test(title)
    ? `MiniMax ${title}`
    : 'MiniMax';
}

/**
 * Parse a `/v1/token_plan/remains` response into provider-neutral windows.
 * The remaining percentage is the authoritative figure (the count fields have
 * been reported to lag and disagree with the console), the interval maps to
 * the 5h window and the weekly fields to the 7d window. Works with both the
 * `data`-wrapped and the flat response shapes.
 */
export function parseMiniMaxUsage(json, now = Date.now()) {
  if (miniMaxEnvelopeCode(json) !== 0) return null;
  const source = miniMaxUsageSource(json);
  const rows = Array.isArray(source.model_remains) ? source.model_remains : [];
  for (const row of miniMaxTextRows(rows)) {
    const windows = miniMaxWindowsForRow(row, now);
    if (windows.length > 0) {
      return normalizeUsage({ kind: 'windows', label: miniMaxLabel(source), windows });
    }
  }
  return null;
}

/** Optional money field: finite and non-negative, else omitted. Negative
 * figures (cash balance in arrears) have no display-safe meaning here. */
function miniMaxOptionalAmount(value) {
  const amount = miniMaxNumber(value);
  return amount !== null && amount >= 0 ? amount : null;
}

/**
 * Parse an `/account/query_balance` response into a plain balance. Every
 * amount is a decimal string; `available_amount` is the total,
 * `voucher_balance` the granted part and `cash_balance` the topped-up part.
 * `credit_balance`, `owed_amount` and the legacy `points_balance` have no
 * balance slot and are deliberately not converted.
 */
export function parseMiniMaxBalance(json, currency = 'USD') {
  if (miniMaxEnvelopeCode(json) !== 0) return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const total = miniMaxOptionalAmount(json.available_amount);
  if (total === null) return null;
  return normalizeUsage({
    kind: 'balance',
    label: 'MiniMax',
    available: true,
    balances: [{
      currency,
      total,
      granted: miniMaxOptionalAmount(json.voucher_balance),
      toppedUp: miniMaxOptionalAmount(json.cash_balance),
    }],
  });
}

/** Pinned https URL: credential-safe, exact official host, exact path, no
 * query/hash. Returns the parsed URL or null. */
function pinnedMiniMaxUrl(value, pathname) {
  const parsed = officialHostUrl(value, MINIMAX_HOSTS);
  return parsed
    && parsed.pathname === pathname
    && parsed.search === ''
    && parsed.hash === ''
    ? parsed
    : null;
}

/**
 * Validate the endpoints produced by accepts() before any request. Both URLs
 * must be pinned to the same official host, and the caller's currency must be
 * the one that host settles in.
 */
function miniMaxEndpoints(endpoints) {
  if (!endpoints || typeof endpoints !== 'object') return null;
  const usage = pinnedMiniMaxUrl(endpoints.usageUrl, MINIMAX_USAGE_PATH);
  const balance = pinnedMiniMaxUrl(endpoints.balanceUrl, MINIMAX_BALANCE_PATH);
  if (!usage || !balance || usage.hostname !== balance.hostname) return null;
  const surface = MINIMAX_SURFACES[usage.hostname];
  if (!surface || endpoints.currency !== surface.currency) return null;
  return {
    usageUrl: endpoints.usageUrl,
    balanceUrl: endpoints.balanceUrl,
    currency: surface.currency,
  };
}

/**
 * Resolve the MiniMax endpoints from the provider's inference base URL. The
 * host decides region and currency; the public www and platform spellings are
 * normalized onto their api twin. Any other host fails closed.
 */
function miniMaxEndpointsFor(config) {
  const parsed = credentialedHttpsUrl(config?.baseUrl);
  if (!parsed) return null;
  const host = MINIMAX_SURFACES[parsed.hostname]
    ? parsed.hostname
    : MINIMAX_HOST_ALIASES[parsed.hostname];
  if (!host) return null;
  const surface = MINIMAX_SURFACES[host];
  return {
    region: surface.region,
    currency: surface.currency,
    usageUrl: `https://${host}${MINIMAX_USAGE_PATH}`,
    balanceUrl: `https://${host}${MINIMAX_BALANCE_PATH}`,
  };
}

/**
 * Fetch one MiniMax usage response without mutating any local state. The key
 * prefix selects the surface (`sk-api-*` = pay-as-you-go balance, anything
 * else = subscription windows); the body envelope is inspected first, because
 * the service reports credential failures as body codes even on HTTP 200.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestMiniMaxUsage({
  apiKey,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const target = miniMaxEndpoints(endpoints);
  if (typeof apiKey !== 'string' || apiKey.length === 0 || !target) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const payAsYouGo = apiKey.startsWith('sk-api-');
  const url = payAsYouGo ? target.balanceUrl : target.usageUrl;
  const result = await requestJsonWithLimits({
    url,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: (json) => json,
    now,
  });
  if (result.status !== PROVIDER_USAGE_RESULT.SUCCESS) return result;
  const code = miniMaxEnvelopeCode(result.parsed);
  if (code === null) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  if (MINIMAX_AUTH_CODES.has(code)) {
    return { status: PROVIDER_USAGE_RESULT.UNAUTHORIZED, category: REQUEST_CATEGORY.AUTH };
  }
  if (code !== 0) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const parsed = payAsYouGo
    ? parseMiniMaxBalance(result.parsed, target.currency)
    : parseMiniMaxUsage(result.parsed, now);
  return parsed
    ? { status: PROVIDER_USAGE_RESULT.SUCCESS, parsed }
    : { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
}

export const ADAPTER = Object.freeze({
  id: MINIMAX_PROVIDER,
  hosts: MINIMAX_HOSTS,
  metric: 'usage windows',
  accepts: miniMaxEndpointsFor,
  request: requestMiniMaxUsage,
});
