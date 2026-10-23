// Chutes subscription-window adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — GET /users/me/subscription_usage on api.chutes.ai —
// and spends exactly one request per refresh.
//
// id: 'chutes' · hosts: llm.chutes.ai, api.chutes.ai · metric: usage windows
// accepts(config): the credential boundary is the official Chutes domain. The
//   hosted inference base is https://llm.chutes.ai/v1; custom chutes are
//   served from <username>-<chute>.chutes.ai with the same key, and the
//   management host doubles as a per-ID invocation base. Any single label
//   directly under chutes.ai is therefore accepted; the apex marketing site,
//   look-alike domains, non-https URLs, non-default ports and URLs carrying
//   userinfo fail closed.
// request(): one GET to the pinned subscription_usage URL with the dashboard
//   key as a Bearer token. Chutes publishes no response schema for this route
//   (its OpenAPI declares the 200 body as a plain string), so the parser is a
//   field-name heuristic: only windows whose used figure and limit resolve to
//   finite numbers are taken. A payload with no clean window is INVALID rather
//   than a guessed number, and there is no fallback endpoint — a failed or
//   empty subscription report never turns into an invented balance reading.
//   Chutes also declares no Retry-After, so the shared guard's fixed/exponential
//   backoff is used; a present header is still honored.

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

export const CHUTES_PROVIDER = 'chutes';
export const CHUTES_SUBSCRIPTION_USAGE_URL = 'https://api.chutes.ai/users/me/subscription_usage';
// Chutes' own client allows 15s for this call. The caller may pass a smaller
// budget (the facade does), which always wins.
export const CHUTES_REQUEST_TIMEOUT_MS = 15_000;

const CHUTES_API_HOST = 'api.chutes.ai';
const CHUTES_LLM_HOST = 'llm.chutes.ai';
const CHUTES_HOSTS = Object.freeze([CHUTES_LLM_HOST, CHUTES_API_HOST]);
const CHUTES_CUSTOM_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.chutes\.ai$/;
// 'Chutes ' plus at most 25 name characters stays inside the shared label
// limit of 32.
const CHUTES_PLAN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,24}$/;
// Epoch values above this are milliseconds; below it they are seconds. Stamps
// under 1e9 seconds (1970-2001) cannot be a real reset and are unusable.
const CHUTES_EPOCH_MS_THRESHOLD = 1e10;
const CHUTES_EPOCH_MIN_SECONDS = 1e9;

// Nested window key, short label, flat field prefix. Order is ascending window
// length: 4h consumption cap, daily request allowance, monthly billing cycle.
const CHUTES_WINDOWS = Object.freeze([
  Object.freeze({ nested: 'four_hour_window', label: '4h', flat: 'four_hour' }),
  Object.freeze({ nested: 'daily_quota_usage', label: '1d', flat: 'daily' }),
  Object.freeze({ nested: 'billing_cycle_cap', label: 'mo', flat: 'billing_cycle' }),
]);

/** One finite number from a JSON field, or null when absent, blank or not a
 * finite number. `Number(null)` would read as 0, so presence is checked first. */
function chutesNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * A reset stamp as ISO text, or null. Accepts epoch seconds, epoch
 * milliseconds and ISO strings, matching what the heuristic clients accept.
 * Display-only `reset_label` text is never treated as a timestamp, and a
 * nonexistent stamp yields null instead of an invented time.
 */
function chutesDate(value) {
  let stamp = null;
  if (typeof value === 'number') {
    stamp = Number.isFinite(value) ? value : null;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    stamp = /^[0-9]+(\.[0-9]+)?$/.test(text) ? Number(text) : Date.parse(text);
  }
  if (stamp === null || !Number.isFinite(stamp) || stamp <= 0) return null;
  const ms = stamp > CHUTES_EPOCH_MS_THRESHOLD ? stamp : stamp * 1000;
  if (ms < CHUTES_EPOCH_MIN_SECONDS * 1000) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Every shape this window may arrive in, most specific first: the nested
 * object, then the flat `<prefix>_used/_limit/_remaining` fields. */
function chutesWindowSources(json, spec) {
  const sources = [];
  const nested = json[spec.nested];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    sources.push({
      used: nested.used,
      limit: nested.limit,
      remaining: nested.remaining,
      resetAt: nested.reset_at ?? nested.resets_at,
    });
  }
  const flatLimit = json[`${spec.flat}_limit`];
  const flatUsed = json[`${spec.flat}_used`];
  if (flatLimit !== undefined || flatUsed !== undefined) {
    sources.push({
      used: flatUsed,
      limit: flatLimit,
      remaining: json[`${spec.flat}_remaining`],
      resetAt: json[`${spec.flat}_reset_at`] ?? json[`${spec.flat}_resets_at`],
    });
  }
  return sources;
}

/**
 * One window from one source shape. The used share is used/limit and falls
 * back to (limit - remaining)/limit when `used` is absent. A non-positive
 * limit is dropped — a brand-new account reports real 0/0 quotas — and so is
 * any source whose figures do not resolve to a non-negative usage.
 */
function chutesWindow(source, label) {
  const limit = chutesNumber(source.limit);
  if (limit === null || limit <= 0) return null;
  const used = chutesNumber(source.used);
  const remaining = chutesNumber(source.remaining);
  const consumed = used !== null ? used : (remaining !== null ? limit - remaining : null);
  if (consumed === null || consumed < 0) return null;
  return {
    label,
    usedRatio: Math.min(1, consumed / limit),
    resetAt: chutesDate(source.resetAt),
  };
}

function chutesPlanLabel(json) {
  const plan = json.plan && typeof json.plan === 'object' && !Array.isArray(json.plan)
    ? json.plan
    : null;
  const name = plan?.name ?? json.plan_name;
  return typeof name === 'string' && CHUTES_PLAN_NAME_RE.test(name)
    ? `Chutes ${name}`
    : 'Chutes';
}

/**
 * Parse Chutes' subscription_usage payload into provider-neutral windows. Each
 * window is taken only when it parses cleanly; unusable windows are skipped,
 * and a payload that leaves no window at all is rejected (null) so the caller
 * reports INVALID instead of displaying a partial or guessed reading.
 */
export function parseChutesSubscriptionUsage(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const windows = [];
  for (const spec of CHUTES_WINDOWS) {
    for (const source of chutesWindowSources(json, spec)) {
      const window = chutesWindow(source, spec.label);
      if (window) {
        windows.push(window);
        break;
      }
    }
  }
  if (windows.length === 0) return null;
  return normalizeUsage({
    kind: 'windows',
    label: chutesPlanLabel(json),
    windows,
  });
}

/** Pinned https URL for the usage request: credential-safe, exact host, exact
 * path, no query/hash. */
function officialChutesUsageUrl(value) {
  const parsed = officialHostUrl(value, [CHUTES_API_HOST]);
  return Boolean(parsed)
    && parsed.pathname === '/users/me/subscription_usage'
    && parsed.search === ''
    && parsed.hash === '';
}

/** Official Chutes host: the two published ones, or one custom-chute label
 * directly under chutes.ai. */
function chutesHost(hostname) {
  return CHUTES_HOSTS.includes(hostname) || CHUTES_CUSTOM_HOST_RE.test(hostname);
}

/**
 * Resolve the Chutes endpoints from the provider's inference base URL. Only
 * the official domain is accepted, so the key is never forwarded to a
 * compatible-looking proxy.
 */
function chutesEndpoints(config) {
  const parsed = credentialedHttpsUrl(config?.baseUrl);
  if (!parsed || !chutesHost(parsed.hostname)) return null;
  return { usageUrl: CHUTES_SUBSCRIPTION_USAGE_URL };
}

/**
 * Fetch one Chutes subscription_usage response without mutating local state.
 * HTTP status is the only machine-readable signal the service offers (no error
 * codes, only a human `detail` string), so the shared guard's status mapping is
 * used as-is: 401/403 unauthorized, 429/5xx transient, everything else invalid.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestChutesUsage({
  apiKey,
  endpoints = null,
  timeoutMs = CHUTES_REQUEST_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const usageUrl = endpoints?.usageUrl ?? null;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialChutesUsageUrl(usageUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: usageUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseChutesSubscriptionUsage,
  });
}

export const ADAPTER = Object.freeze({
  id: CHUTES_PROVIDER,
  hosts: CHUTES_HOSTS,
  metric: 'usage windows',
  accepts: chutesEndpoints,
  request: requestChutesUsage,
});
