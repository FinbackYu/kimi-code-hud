// Ollama Cloud balance adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the documented GET https://ollama.com/api/balance
// endpoint, authenticated with the same Ollama Cloud API key inference uses —
// and nothing else.
//
// id: 'ollama' · hosts: ollama.com, www.ollama.com, api.ollama.com ·
// metric: usage windows
// accepts(config): the credential boundary is the official host. The key is
//   only ever sent to the pinned ollama.com balance URL, so a compatible
//   proxy fail closed here; a local `ollama serve` on localhost is not listed
//   and has no balance concept at all.
// request(): one GET to the pinned balance URL. A credit plan exposes a
//   monthly `mo` window from allowance_usd vs balance_usd; a legacy plan
//   exposes `5h`/`7d` windows from the remaining percentages. Windows win
//   when either is derivable (the same preference as the Zhipu adapter); a
//   response with money but no window is rendered as a plain USD balance.

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

export const OLLAMA_PROVIDER = 'ollama';
export const OLLAMA_BALANCE_URL = 'https://ollama.com/api/balance';

const OLLAMA_HOSTS = Object.freeze(['ollama.com', 'www.ollama.com', 'api.ollama.com']);
const OLLAMA_LABEL = 'Ollama';
const OLLAMA_CURRENCY = 'USD';

// Plain decimal notation only. Number() alone would accept "0x10", whitespace
// and exponent strings; `true` and null would coerce to 1 and 0.
const OLLAMA_DECIMAL_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** One finite amount from a JSON field. Ollama's balance endpoint mixes
 * numbers and decimal strings ("52.50" and 60 both appear), so both are read
 * the same way; everything else — booleans, null, blank strings, hex,
 * non-finite values — is unusable and yields null. */
function ollamaAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!OLLAMA_DECIMAL_RE.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

/** One reset stamp as ISO text. The endpoint documents ISO 8601 UTC strings;
 * anything unparsable is dropped rather than rendered raw. */
function ollamaIsoTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function ollamaRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function ollamaClampedRatio(numerator, denominator) {
  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio)) return null;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * Credit-plan monthly window: allowance_usd is the included allowance for the
 * period and included.balance_usd is what is left of it, so the used share is
 * (allowance - balance) / allowance. An overdrawn balance (negative) clamps to
 * a full window; a zero allowance produces no window at all rather than a
 * meaningless 0% bar.
 */
function ollamaCreditWindow(included) {
  if (!included) return null;
  const allowance = ollamaAmount(included.allowance_usd);
  const remaining = ollamaAmount(included.balance_usd);
  if (allowance === null || allowance <= 0 || remaining === null) return null;
  const usedRatio = ollamaClampedRatio(allowance - remaining, allowance);
  if (usedRatio === null) return null;
  const period = ollamaRecord(included.period);
  return {
    label: 'mo',
    usedRatio,
    resetAt: period ? ollamaIsoTime(period.until) : null,
  };
}

/**
 * Legacy session/weekly window: remaining_percent runs 0–100 and is what is
 * LEFT, so it is flipped into the used share the HUD expects. Values outside
 * the documented range are unusable rather than clamped, so a broken payload
 * cannot silently claim a window is exhausted or untouched.
 */
function ollamaRemainingWindow(raw, label) {
  if (!raw) return null;
  const remaining = ollamaAmount(raw.remaining_percent);
  if (remaining === null || remaining < 0 || remaining > 100) return null;
  return {
    label,
    usedRatio: 1 - remaining / 100,
    resetAt: ollamaIsoTime(raw.resets_at),
  };
}

/**
 * Money-only fallback: included.balance_usd and purchased.balance_usd are both
 * remaining amounts, so the reported total is their sum. Purchased credit may
 * be absent; a negative included balance (overdraft) leaves the total floored
 * at zero and is not attributed to granted or toppedUp.
 */
function ollamaBalanceUsage(included, purchased) {
  const includedBalance = ollamaAmount(included?.balance_usd);
  const purchasedBalance = ollamaAmount(purchased?.balance_usd);
  if (includedBalance === null && purchasedBalance === null) return null;
  return {
    kind: 'balance',
    label: OLLAMA_LABEL,
    available: true,
    balances: [{
      currency: OLLAMA_CURRENCY,
      total: Math.max(0, (includedBalance ?? 0) + (purchasedBalance ?? 0)),
      granted: includedBalance !== null && includedBalance >= 0 ? includedBalance : null,
      toppedUp: purchasedBalance !== null && purchasedBalance >= 0 ? purchasedBalance : null,
    }],
  };
}

/**
 * Parse Ollama's /api/balance response into provider-neutral data. Windows are
 * preferred because they carry the quota picture; the balance form only
 * appears when no window can be derived. Every unexpected structure — a
 * non-object, an empty body, an `{"error": ...}` body — yields null, which the
 * request layer reports as an invalid payload instead of throwing.
 */
export function parseOllamaUsage(json) {
  const body = ollamaRecord(json);
  if (!body) return null;
  const included = ollamaRecord(body.included);
  const purchased = ollamaRecord(body.purchased);
  const windows = [];
  const monthly = ollamaCreditWindow(included);
  if (monthly) windows.push(monthly);
  const session = ollamaRemainingWindow(ollamaRecord(included?.session), '5h');
  const weekly = ollamaRemainingWindow(ollamaRecord(included?.weekly), '7d');
  if (session) windows.push(session);
  if (weekly) windows.push(weekly);
  if (windows.length > 0) {
    return normalizeUsage({ kind: 'windows', label: OLLAMA_LABEL, windows });
  }
  return normalizeUsage(ollamaBalanceUsage(included, purchased));
}

/** Pinned https URL: credential-safe, exact host, exact path, no query/hash. */
function officialOllamaBalanceUrl(value) {
  const parsed = officialHostUrl(value, OLLAMA_HOSTS);
  return Boolean(parsed)
    && parsed.hostname === 'ollama.com'
    && parsed.pathname === '/api/balance'
    && parsed.search === ''
    && parsed.hash === '';
}

/**
 * Resolve the endpoints from the provider's inference base URL. Only the
 * official Ollama Cloud hosts are accepted; both the native `https://ollama.com/api`
 * and the OpenAI-compatible `https://ollama.com/v1` bases pass. The host — not
 * the path — is the credential boundary because the request itself always goes
 * to the pinned ollama.com balance URL.
 */
function ollamaEndpoints(config) {
  return officialHostUrl(config?.baseUrl, OLLAMA_HOSTS)
    ? { usageUrl: OLLAMA_BALANCE_URL }
    : null;
}

/** Fetch one Ollama balance response without mutating any local state.
 * One GET, one whole-lifecycle deadline, size-capped body, no local writes.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestOllamaUsage({
  apiKey,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const usageUrl = endpoints?.usageUrl ?? OLLAMA_BALANCE_URL;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialOllamaBalanceUrl(usageUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: usageUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseOllamaUsage,
  });
}

export const ADAPTER = Object.freeze({
  id: OLLAMA_PROVIDER,
  hosts: OLLAMA_HOSTS,
  metric: 'usage windows',
  accepts: ollamaEndpoints,
  request: requestOllamaUsage,
});
