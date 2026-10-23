// ClinePass subscription-window adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /api/v1/users/me/plan/usage-limits
// endpoint on api.cline.bot.
//
// id: 'clinepass' · hosts: api.cline.bot · metric: usage windows
// accepts(config): the credential boundary is the official host. Cline's
//   inference base_url is either the bare host or the /api/v1 prefix, so both
//   are accepted (trailing slash tolerated) and every other path, query or
//   proxy fails closed; the key is only ever sent to the pinned endpoint.
// request(): one GET to the pinned usage URL; parseClinePassUsage maps the
//   five-hour, weekly and monthly percentages onto labeled windows.
//
// The endpoint is the Cline client's own plan-limits route rather than a
// documented public API (docs.cline.bot lists chat/models only), so any
// unreadable payload degrades to INVALID and never overwrites the cache.
// Accounts without a ClinePass subscription answer 200 with an empty limits
// array: the provider-neutral vocabulary has no "no quota" state, so that
// also degrades to INVALID instead of inventing a zeroed window.

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

export const CLINEPASS_PROVIDER = 'clinepass';
export const CLINEPASS_USAGE_URL = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits';

/** The upstream client allows 15s for this route; callers may narrow it. */
export const CLINEPASS_TIMEOUT_MS = 15_000;

const CLINEPASS_HOSTS = Object.freeze(['api.cline.bot']);

// Render labels are the HUD's short forms (5h / 7d / mo), not the API's type
// names. A Map keeps lookups off the object prototype, so a hostile
// `type: "constructor"` is just an unknown type.
const CLINEPASS_WINDOWS = Object.freeze([
  Object.freeze({ type: 'five_hour', label: '5h' }),
  Object.freeze({ type: 'weekly', label: '7d' }),
  Object.freeze({ type: 'monthly', label: 'mo' }),
]);
const CLINEPASS_LABELS = new Map(
  CLINEPASS_WINDOWS.map((window) => [window.type, window.label]),
);

function officialClinePassBaseUrl(value) {
  const parsed = officialHostUrl(value, CLINEPASS_HOSTS);
  if (!parsed) return false;
  const pathname = parsed.pathname.replace(/\/$/, '');
  return (pathname === '' || pathname === '/api/v1')
    && parsed.search === ''
    && parsed.hash === '';
}

function officialClinePassUsageUrl(value) {
  const parsed = officialHostUrl(value, CLINEPASS_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === '/api/v1/users/me/plan/usage-limits'
    && parsed.search === ''
    && parsed.hash === '';
}

/**
 * One window from one limits entry. percentUsed is the used share of the
 * window (0–100), so it maps straight onto usedRatio without inversion and is
 * clamped into [0, 1]; a reset is only kept when it is an ISO-8601 string that
 * actually parses. Anything else returns null, and the caller treats that as a
 * whole-payload failure: a partly unreadable answer must not be shown as a
 * smaller set of windows.
 */
function clinePassWindow(raw, label) {
  const percent = raw.percentUsed;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  let resetAt = null;
  if (raw.resetsAt !== null && raw.resetsAt !== undefined) {
    if (typeof raw.resetsAt !== 'string') return null;
    const stamp = Date.parse(raw.resetsAt);
    if (!Number.isFinite(stamp)) return null;
    resetAt = new Date(stamp).toISOString();
  }
  return {
    label,
    usedRatio: Math.min(1, Math.max(0, percent / 100)),
    resetAt,
  };
}

/**
 * Parse ClinePass's plan usage response into provider-neutral windows. The
 * envelope must report success and carry a limits array; unknown limit types
 * are ignored, while a known type with malformed numbers or a reset resolves
 * to null. Windows are emitted in ascending duration (5h, 7d, mo) and
 * duplicates of one type keep the first occurrence.
 */
export function parseClinePassUsage(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json.success !== true) return null;
  const data = json.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!Array.isArray(data.limits)) return null;
  const parsed = new Map();
  for (const entry of data.limits) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const label = CLINEPASS_LABELS.get(entry.type);
    if (label === undefined || parsed.has(entry.type)) continue;
    const window = clinePassWindow(entry, label);
    if (window === null) return null;
    parsed.set(entry.type, window);
  }
  const windows = [];
  for (const { type } of CLINEPASS_WINDOWS) {
    const window = parsed.get(type);
    if (window) windows.push(window);
  }
  if (windows.length === 0) return null;
  return normalizeUsage({ kind: 'windows', label: 'ClinePass', windows });
}

/** Fetch one ClinePass plan usage response without mutating any local state.
 * Same request discipline as the other adapters: one shared deadline for
 * headers, body and parse, size-capped and always released.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestClinePassUsage({
  apiKey,
  endpoints = null,
  timeoutMs = CLINEPASS_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const usageUrl = endpoints?.usageUrl;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialClinePassUsageUrl(usageUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: usageUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseClinePassUsage,
  });
}

export const ADAPTER = Object.freeze({
  id: CLINEPASS_PROVIDER,
  hosts: CLINEPASS_HOSTS,
  metric: 'usage windows',
  accepts: (config) => (officialClinePassBaseUrl(config?.baseUrl)
    ? { usageUrl: CLINEPASS_USAGE_URL }
    : null),
  request: requestClinePassUsage,
});
