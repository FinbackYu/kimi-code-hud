// OpenRouter spending-cap adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /api/v1/key endpoint on openrouter.ai.
//
// id: 'openrouter' · hosts: openrouter.ai · metric: usage windows
// accepts(config): config.baseUrl must be the official OpenRouter inference
//   base (https, openrouter.ai, default port, no userinfo, path /api/v1) so
//   the configured key never reaches a compatible proxy.
// request(): one GET to the pinned key URL. OpenRouter is prepaid, so the
//   numbers it reports are a spending cap, not a balance. The prepaid credit
//   balance lives behind /api/v1/credits, which only a Management key may
//   read — and a Management key cannot do inference, so it can never be the
//   key configured for this provider. That branch is therefore not
//   implemented: what a key without a cap reports (limit: null, no budgets)
//   is hidden instead of being shown as 0% used.

import {
  MAX_RESPONSE_BYTES,
  REQUEST_CATEGORY,
  requestJsonWithLimits,
} from '../request-guard.mjs';
import {
  PROVIDER_USAGE_RESULT,
  normalizeUsage,
  officialHostUrl,
} from './common.mjs';

export const OPENROUTER_PROVIDER = 'openrouter';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

const OPENROUTER_HOSTS = Object.freeze(['openrouter.ai']);
const OPENROUTER_BASE_PATH = '/api/v1';
// Budget reset intervals as short window labels; a missing interval is a
// cap with no reset period ("life"), not a monthly window.
const OPENROUTER_INTERVAL_LABELS = Object.freeze({
  daily: '1d',
  weekly: '7d',
  monthly: 'mo',
});

function officialOpenRouterBaseUrl(value) {
  const parsed = officialHostUrl(value, OPENROUTER_HOSTS);
  if (!parsed) return false;
  return parsed.pathname.replace(/\/+$/, '') === OPENROUTER_BASE_PATH
    && parsed.search === ''
    && parsed.hash === '';
}

function officialOpenRouterKeyUrl(value) {
  const parsed = officialHostUrl(value, OPENROUTER_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === '/api/v1/key'
    && parsed.search === ''
    && parsed.hash === '';
}

/** One finite number from a JSON field, or null when absent, blank or not a
 * finite number. Presence is checked before coercion, so null never reads 0. */
function openRouterNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function clampRatio(value) {
  return Math.min(1, Math.max(0, value));
}

/** Short label for a reset interval; null when the service sent an interval
 * this adapter does not know and therefore cannot label honestly. */
function intervalLabel(value) {
  if (value === null || value === undefined) return 'life';
  if (typeof value !== 'string') return null;
  return OPENROUTER_INTERVAL_LABELS[value] ?? null;
}

/** Reset timestamp as ISO text, or null when the field is not a parsable
 * date string; the value is never passed through unvalidated. */
function budgetResetAt(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

/**
 * One budget entry as a window. `spend_usd` is preferred; when it is absent
 * the used amount is derived from `remaining_usd`, clamped into [0, limit].
 * A non-positive or missing limit carries no ratio and yields no window.
 */
function budgetWindow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const label = intervalLabel(raw.reset_interval);
  if (label === null) return null;
  const limit = openRouterNumber(raw.limit_usd);
  if (limit === null || limit <= 0) return null;
  const spend = openRouterNumber(raw.spend_usd);
  const remaining = openRouterNumber(raw.remaining_usd);
  const used = spend
    ?? (remaining === null ? null : limit - Math.min(limit, Math.max(0, remaining)));
  if (used === null) return null;
  return { label, usedRatio: clampRatio(used / limit), resetAt: budgetResetAt(raw.resets_at) };
}

/**
 * The key's own spending cap. `limit` is a spending cap, not a balance, so
 * the window reads as used/limit. `limit_reset` only names the period type
 * and never a reset instant, so resetAt stays null. When `limit_remaining`
 * is absent the lifetime `usage` figure is the used amount.
 */
function keyCapWindow(data) {
  const limit = openRouterNumber(data.limit);
  if (limit === null || limit <= 0) return null;
  const label = intervalLabel(data.limit_reset);
  if (label === null) return null;
  const remaining = openRouterNumber(data.limit_remaining);
  const usage = openRouterNumber(data.usage);
  const used = remaining === null
    ? usage
    : limit - Math.min(limit, Math.max(0, remaining));
  if (used === null || used < 0) return null;
  return { label, usedRatio: clampRatio(used / limit), resetAt: null };
}

/**
 * Parse OpenRouter's /api/v1/key response into provider-neutral windows.
 * `effective_budget` wins when it carries a usable limit because it is the
 * single budget actually enforced; otherwise every usable entry of `budgets`
 * contributes one window; only when neither yields a window does the key's
 * own cap apply. Duplicate labels keep the first entry. `free_model_daily_
 * requests` is deliberately ignored — it measures free-model traffic, not
 * the account's spend. No window at all means the key has no cap, and the
 * caller hides it rather than inventing 0%.
 */
export function parseOpenRouterKey(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const data = json.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const collected = [];
  const effective = budgetWindow(data.effective_budget);
  if (effective) {
    collected.push(effective);
  } else if (Array.isArray(data.budgets)) {
    for (const raw of data.budgets) {
      const window = budgetWindow(raw);
      if (window) collected.push(window);
    }
  }
  if (collected.length === 0) {
    const cap = keyCapWindow(data);
    if (cap) collected.push(cap);
  }
  const seen = new Set();
  const windows = [];
  for (const window of collected) {
    if (seen.has(window.label)) continue;
    seen.add(window.label);
    windows.push(window);
  }
  if (windows.length === 0) return null;
  return normalizeUsage({ kind: 'windows', label: 'OpenRouter', windows });
}

/**
 * Classify a body-level OpenRouter error envelope. The service normally pairs
 * the envelope with the matching HTTP status (which requestJsonWithLimits
 * already classifies), so this is defense for a 200 response carrying an
 * error body; `error.code` is used when present but never required, because
 * the "Management key required" 403 body carries no code at all.
 * @returns {string|null} a PROVIDER_USAGE_RESULT value, or null when the body
 *   is not an error envelope
 */
function bodyErrorStatus(body) {
  const error = body.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = openRouterNumber(error.code);
  return code === 401 || code === 403
    ? PROVIDER_USAGE_RESULT.UNAUTHORIZED
    : PROVIDER_USAGE_RESULT.INVALID;
}

/**
 * Fetch one OpenRouter key response without mutating any local state. The
 * whole request — headers, body and parse — shares one deadline, and the
 * response body is size-capped and always released.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestOpenRouterUsage({
  apiKey,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetUrl = endpoints?.usageUrl ?? OPENROUTER_KEY_URL;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialOpenRouterKeyUrl(targetUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const result = await requestJsonWithLimits({
    url: targetUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: (json) => (json && typeof json === 'object' && !Array.isArray(json) ? json : null),
  });
  if (result.status !== PROVIDER_USAGE_RESULT.SUCCESS) return result;
  const failure = bodyErrorStatus(result.parsed);
  if (failure === PROVIDER_USAGE_RESULT.UNAUTHORIZED) {
    return { status: PROVIDER_USAGE_RESULT.UNAUTHORIZED, category: REQUEST_CATEGORY.AUTH };
  }
  const parsed = failure === null ? parseOpenRouterKey(result.parsed) : null;
  return parsed
    ? { status: PROVIDER_USAGE_RESULT.SUCCESS, parsed }
    : { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
}

export const ADAPTER = Object.freeze({
  id: OPENROUTER_PROVIDER,
  hosts: OPENROUTER_HOSTS,
  metric: 'usage windows',
  accepts: (config) => (officialOpenRouterBaseUrl(config.baseUrl)
    ? { usageUrl: OPENROUTER_KEY_URL, balanceUrl: null }
    : null),
  request: requestOpenRouterUsage,
});
