// Synthetic (synthetic.new) subscription-window adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /v2/quotas endpoint on api.synthetic.new
// — and nothing else. One API key drives both inference and quota reads; there
// is no separate management credential.
//
// id: 'synthetic' · hosts: api.synthetic.new · metric: usage windows
// accepts(config): the credential boundary is the official host, not a path.
//   Synthetic documents /v1, /openai/v1 and /anthropic inference bases on that
//   single host, so any path is accepted once the URL is credential-safe and
//   the hostname matches exactly; proxies and every other host fail closed.
// request(): one GET to the pinned quota URL. The endpoint does not count
//   against the subscription, but a 429/5xx is still classified and handed to
//   the shared backoff rather than retried here.
//
// The service reports the rolling five-hour bucket, the weekly token bucket
// and the hourly search bucket either at the root or under `data`. The legacy
// `subscription` block, the free tool-call buckets and the weekly dollar-credit
// rows are deliberately not mapped: they are not HUD windows, and the credit
// rows describe one bucket's allowance, not an account balance.

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

export const SYNTHETIC_PROVIDER = 'synthetic';
export const SYNTHETIC_USAGE_URL = 'https://api.synthetic.new/v2/quotas';

const SYNTHETIC_HOSTS = Object.freeze(['api.synthetic.new']);
const SYNTHETIC_SLOTS = Object.freeze(['rollingFiveHourLimit', 'weeklyTokenLimit', 'search']);

/** One finite number from a JSON field, or null when the field is absent,
 * blank, or not a finite number. `Number(null)` would read as 0, so presence
 * is checked before coercion. */
function syntheticNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function clampRatio(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * Reset time as ISO text. The quota fields carry ISO-8601 strings; epoch
 * milliseconds and epoch seconds are accepted as a fallback, mirroring the
 * tolerance CodexBar applies.
 */
function syntheticResetAt(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    return new Date(timestamp).toISOString();
  }
  const epoch = syntheticNumber(value);
  if (epoch === null || epoch <= 0) return null;
  const milliseconds = epoch > 1e12 ? epoch : epoch > 1e9 ? epoch * 1000 : null;
  if (milliseconds === null) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hasSyntheticSlot(object) {
  return SYNTHETIC_SLOTS.some((slot) => object[slot] !== undefined && object[slot] !== null);
}

/**
 * Locate the quota slots. The payload is normally the root object; some
 * responses wrap the same slots in `data`. The root wins when it carries any
 * known slot, so a wrapper is only consulted when the root has none.
 */
function syntheticSlots(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (hasSyntheticSlot(json)) return json;
  const data = json.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return hasSyntheticSlot(data) ? data : null;
}

/**
 * Rolling five-hour bucket. `limited` means the account is throttled right
 * now, so it wins over the floating-point remainder. `nextTickAt` marks the
 * next partial regeneration, not the window reset, so no reset time is
 * reported for this window.
 */
function syntheticFiveHourWindow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let usedRatio = null;
  if (raw.limited === true) {
    usedRatio = 1;
  } else {
    const max = syntheticNumber(raw.max);
    const remaining = syntheticNumber(raw.remaining);
    if (max !== null && max > 0 && remaining !== null) {
      usedRatio = clampRatio((max - remaining) / max);
    }
  }
  return usedRatio === null ? null : { label: '5h', usedRatio, resetAt: null };
}

/**
 * Weekly token bucket. `percentRemaining` is a 0–100 remaining share (not a
 * 0–1 fraction); it is clamped and inverted to the used share. `nextRegenAt`
 * is the next partial regeneration, not the weekly reset, so it is not shown.
 */
function syntheticWeeklyWindow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const percentRemaining = syntheticNumber(raw.percentRemaining);
  if (percentRemaining === null) return null;
  const percent = Math.min(100, Math.max(0, percentRemaining));
  return { label: '7d', usedRatio: clampRatio((100 - percent) / 100), resetAt: null };
}

/** Hourly search bucket: `requests` used against `limit`, with a real hourly
 * `renewsAt` that can back the rendered countdown. */
function syntheticSearchWindow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hourly = raw.hourly;
  if (!hourly || typeof hourly !== 'object' || Array.isArray(hourly)) return null;
  const limit = syntheticNumber(hourly.limit);
  const requests = syntheticNumber(hourly.requests);
  if (limit === null || limit <= 0 || requests === null || requests < 0) return null;
  return {
    label: '1h',
    usedRatio: clampRatio(requests / limit),
    resetAt: syntheticResetAt(hourly.renewsAt),
  };
}

/**
 * Parse Synthetic's /v2/quotas response into provider-neutral windows. A
 * payload with no usable bucket (free or unsubscribed accounts, legacy-only
 * `subscription` responses) returns null so the caller hides the segment
 * instead of rendering 0%.
 */
export function parseSyntheticQuotas(json) {
  const slots = syntheticSlots(json);
  if (!slots) return null;
  const windows = [];
  const fiveHour = syntheticFiveHourWindow(slots.rollingFiveHourLimit);
  if (fiveHour) windows.push(fiveHour);
  const weekly = syntheticWeeklyWindow(slots.weeklyTokenLimit);
  if (weekly) windows.push(weekly);
  const hourly = syntheticSearchWindow(slots.search);
  if (hourly) windows.push(hourly);
  if (windows.length === 0) return null;
  return normalizeUsage({ kind: 'windows', label: 'Synthetic', windows });
}

/** Pinned https URL: credential-safe, exact host, exact path, no query/hash. */
function officialSyntheticUsageUrl(value) {
  const parsed = officialHostUrl(value, SYNTHETIC_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === '/v2/quotas'
    && parsed.search === ''
    && parsed.hash === '';
}

/**
 * Resolve the Synthetic endpoints from the provider's inference base URL. Any
 * path on the official host is the same service and the same credential
 * target; only the hostname decides, so compatible-looking proxies fail
 * closed.
 */
function syntheticEndpoints(config) {
  return officialHostUrl(config?.baseUrl, SYNTHETIC_HOSTS)
    ? { usageUrl: SYNTHETIC_USAGE_URL, balanceUrl: null }
    : null;
}

/** Fetch one Synthetic quota response without mutating any local state.
 * Same request discipline as the other adapters: one shared deadline for
 * headers, body and parse, size-capped and always released. HTTP 401/403 map
 * to unauthorized; the endpoint publishes no body-level error codes, so the
 * body is only ever parsed for windows.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestSyntheticUsage({
  apiKey,
  url = null,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetUrl = url ?? endpoints?.usageUrl ?? SYNTHETIC_USAGE_URL;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialSyntheticUsageUrl(targetUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: targetUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseSyntheticQuotas,
  });
}

export const ADAPTER = Object.freeze({
  id: SYNTHETIC_PROVIDER,
  hosts: SYNTHETIC_HOSTS,
  metric: 'usage windows',
  accepts: syntheticEndpoints,
  request: requestSyntheticUsage,
});
