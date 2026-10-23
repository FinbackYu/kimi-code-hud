// Venice.ai billing-balance adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /api/v1/billing/balance endpoint on
// api.venice.ai — and nothing else.
//
// id: 'venice' · hosts: api.venice.ai · metric: balance
// accepts(config): config.baseUrl must be the official Venice inference base
//   (https, api.venice.ai, default port, no userinfo, path empty or /api/v1)
//   so a compatible proxy never receives the key. The billing route lives on
//   the same host, so the balance URL is pinned rather than derived.
// request(): one GET to the pinned balance URL. Venice requires an ADMIN key
//   on this route; an INFERENCE key answers HTTP 401 and rides the shared
//   unauthorized path, which hides the segment silently instead of erroring.
//
// Shape note: the payload has no ISO 4217 balance for the DIEM credits most
// accounts consume. `balances.diem` is the remaining share of a daily epoch
// allowance in DIEM — a four-letter unit the balance contract rejects as a
// currency — so only the USD balance is reported as `balance`. DIEM accounts,
// and an account the service itself marks `canConsume: false`, are reported
// as the single `1d` epoch window usedRatio = share consumed. The response
// carries no reset timestamp (the daily epoch resets at 00:00 UTC), so
// resetAt stays null and no second request is spent.

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

export const VENICE_PROVIDER = 'venice';
export const VENICE_BALANCE_URL = 'https://api.venice.ai/api/v1/billing/balance';

const VENICE_HOSTS = Object.freeze(['api.venice.ai']);
const VENICE_EPOCH_LABEL = '1d';

/** One finite decimal number from a JSON field, or null when it is absent,
 * blank, boolean, hex, a numeric string that parses to Infinity, or anything
 * else that is not a plain decimal. */
function veniceNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

function veniceClamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** The daily DIEM epoch as the one window this surface can express. */
function veniceEpochWindow(usedRatio) {
  return normalizeUsage({
    kind: 'windows',
    label: 'Venice',
    windows: [{ label: VENICE_EPOCH_LABEL, usedRatio: veniceClamp01(usedRatio), resetAt: null }],
  });
}

function veniceUsdBalance(total) {
  return normalizeUsage({
    kind: 'balance',
    label: 'Venice',
    available: true,
    balances: [{ currency: 'USD', total, granted: null, toppedUp: null }],
  });
}

/**
 * Parse Venice's billing-balance response into provider-neutral data.
 *
 * The service reports the currency it is currently drawing down in
 * `consumptionCurrency` (DIEM, USD, BUNDLED_CREDITS, legacy VCU) and the
 * remaining amounts in `balances`; `diemEpochAllocation` is this epoch's DIEM
 * grant. The mapping follows the researched priority order:
 *
 *   1. `canConsume: false` → the daily epoch at 100% used.
 *   2. consumption currency USD with a positive USD balance → USD balance.
 *   3. a non-USD currency with DIEM and a positive epoch allocation → the
 *      used share of the epoch (clamped into [0, 1]).
 *   4. a positive DIEM balance without an allocation → epoch at 0% used (the
 *      share cannot be computed, but nothing was drawn down).
 *   5. a positive USD balance without a usable DIEM share → USD balance.
 *   6. anything else → null, i.e. hidden by the caller.
 *
 * Two deliberate departures from the reference implementation are recorded
 * here because they change what the user sees:
 *
 *   - The no-data case (rule 6) is hidden instead of shown as 100% used.
 *     The reference maps "can consume, but no usable balances" onto a full
 *     bar, which contradicts `canConsume: true` and misreports Pro accounts
 *     whose bundled credits the payload does not quantify.
 *   - A positive USD balance next to a non-USD consumption currency (rule 5)
 *     is reported as the USD balance rather than a 0% epoch bar, because the
 *     amount is known and a window would assert a period it does not have.
 *
 * `canConsume: false` is likewise a reported state, not permission to claim
 * total exhaustion: bundled credits do not participate in that field. The
 * only representation available here is the 100% epoch window.
 * @param {object} json parsed response body
 * @returns {object|null} normalized usage, or null when the body is unusable
 */
export function parseVeniceBalance(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (typeof json.canConsume !== 'boolean') return null;
  const balances = json.balances;
  if (!balances || typeof balances !== 'object' || Array.isArray(balances)) return null;
  const diem = veniceNumber(balances.diem);
  const usd = veniceNumber(balances.usd);
  const allocation = veniceNumber(json.diemEpochAllocation);
  const currency = typeof json.consumptionCurrency === 'string'
    ? json.consumptionCurrency.trim().toUpperCase()
    : null;

  if (json.canConsume === false) return veniceEpochWindow(1);
  if (currency === 'USD' && usd !== null && usd > 0) return veniceUsdBalance(usd);
  if (currency !== 'USD' && diem !== null && allocation !== null && allocation > 0) {
    return veniceEpochWindow((allocation - diem) / allocation);
  }
  if (diem !== null && diem > 0) return veniceEpochWindow(0);
  if (usd !== null && usd > 0) return veniceUsdBalance(usd);
  return null;
}

function officialVeniceBaseUrl(value) {
  const parsed = officialHostUrl(value, VENICE_HOSTS);
  if (!parsed) return false;
  const pathname = parsed.pathname.replace(/\/$/, '');
  return (pathname === '' || pathname === '/api/v1')
    && parsed.search === ''
    && parsed.hash === '';
}

function officialVeniceBalanceUrl(value) {
  const parsed = officialHostUrl(value, VENICE_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === '/api/v1/billing/balance'
    && parsed.search === ''
    && parsed.hash === '';
}

/** Fetch one Venice balance response without mutating any local state. The
 * whole request — headers, body and parse — shares one deadline, bodies are
 * size-capped and always released, and Retry-After is classified by the
 * shared guard. Venice answers 401 for an INFERENCE key on this admin route;
 * that is the same unauthorized state as an invalid key.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestVeniceUsage({
  apiKey,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetUrl = endpoints?.usageUrl;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialVeniceBalanceUrl(targetUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: targetUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseVeniceBalance,
  });
}

export const ADAPTER = Object.freeze({
  id: VENICE_PROVIDER,
  hosts: VENICE_HOSTS,
  metric: 'balance',
  accepts: (config) => (officialVeniceBaseUrl(config?.baseUrl)
    ? { usageUrl: VENICE_BALANCE_URL, balanceUrl: null }
    : null),
  request: requestVeniceUsage,
});
