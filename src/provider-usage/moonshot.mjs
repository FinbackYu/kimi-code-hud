// Moonshot (Kimi Open Platform) balance adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /v1/users/me/balance endpoint on the
// international and China-mainland Open Platform hosts — and nothing else.
//
// id: 'moonshot' · hosts: api.moonshot.ai, api.moonshot.cn · metric: balance
// accepts(config): config.baseUrl must be an official Open Platform inference
//   base (https, exact host, default port, no userinfo, path empty or /v1).
//   The host alone also decides the currency — api.moonshot.ai bills USD and
//   api.moonshot.cn bills CNY — because the balance response carries no
//   currency field. Keys are issued per platform and rejected across
//   platforms, so a proxy, the other region's host, or the Kimi Code OAuth
//   host api.kimi.com must never receive this key.
// request(): one GET to the pinned balance URL; the response is parsed into
//   { kind: 'balance', label: 'Moonshot', ... } by parseMoonshotBalance.
//
// There is no session or weekly window on this surface: the service exposes
// balance only, so this adapter never produces `windows`.

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

export const MOONSHOT_PROVIDER = 'moonshot';
export const MOONSHOT_INTL_BALANCE_URL = 'https://api.moonshot.ai/v1/users/me/balance';
export const MOONSHOT_CN_BALANCE_URL = 'https://api.moonshot.cn/v1/users/me/balance';

const MOONSHOT_BALANCE_PATH = '/v1/users/me/balance';
const MOONSHOT_CURRENCY_BY_HOST = Object.freeze({
  'api.moonshot.ai': 'USD',
  'api.moonshot.cn': 'CNY',
});
const MOONSHOT_HOSTS = Object.freeze(Object.keys(MOONSHOT_CURRENCY_BY_HOST));

/** One finite number from a JSON field, or null when the field is absent,
 * blank, or not a finite value (`1e999` parses as Infinity and must not
 * become a balance). */
function moonshotNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * The service reports arrears as a negative figure: cash_balance can go below
 * zero (debt) and available_balance follows the voucher figure then. The
 * shared balance contract only carries non-negative amounts, so negatives
 * clamp to zero rather than vanishing; the sign itself has no field here.
 */
function moonshotClampedAmount(value) {
  const amount = moonshotNumber(value);
  return amount === null ? null : Math.max(0, amount);
}

/**
 * Classify the response envelope. The service answers HTTP 200 for some
 * account-level failures, signalling them through `status: false` or a
 * non-zero `code`; the body code has no mandatory relation to the HTTP status,
 * so the HTTP layer is judged first (by requestJsonWithLimits) and this runs on
 * the 200 body only. A body with neither signal fails closed.
 * @returns {'ok'|'unauthorized'|'failed'|'invalid'}
 */
function moonshotEnvelopeOutcome(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'invalid';
  const code = moonshotNumber(json.code);
  if (json.status === false || (code !== null && code !== 0)) {
    const scode = typeof json.scode === 'string' ? json.scode.toLowerCase() : '';
    return code === 401 || scode === 'unauthorized' ? 'unauthorized' : 'failed';
  }
  return json.status === true || code === 0 ? 'ok' : 'invalid';
}

/**
 * Parse Moonshot's official balance response into provider-neutral data.
 * `available_balance` is the spendable total (cash plus voucher),
 * `voucher_balance` the granted part and `cash_balance` the topped-up part;
 * the three are not summed or cross-checked because the service overrides the
 * total with the voucher figure while cash is negative.
 * @param {object} json parsed response body
 * @param {string} [currency] ISO 4217 code decided by the endpoint host
 */
export function parseMoonshotBalance(json, currency = 'USD') {
  if (moonshotEnvelopeOutcome(json) !== 'ok') return null;
  const code = typeof currency === 'string' ? currency.toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const data = json.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const total = moonshotClampedAmount(data.available_balance);
  if (total === null) return null;
  return normalizeUsage({
    kind: 'balance',
    label: 'Moonshot',
    available: true,
    balances: [{
      currency: code,
      total,
      granted: moonshotClampedAmount(data.voucher_balance),
      toppedUp: moonshotClampedAmount(data.cash_balance),
    }],
  });
}

/** Currency of a pinned balance URL, or null when the URL is not the exact
 * official endpoint: credential-safe https, exact host, exact path, no
 * query/hash. */
function moonshotBalanceCurrency(value) {
  const parsed = officialHostUrl(value, MOONSHOT_HOSTS);
  if (
    !parsed
    || parsed.pathname !== MOONSHOT_BALANCE_PATH
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    return null;
  }
  return MOONSHOT_CURRENCY_BY_HOST[parsed.hostname] ?? null;
}

/** Currency of an official inference base URL (path empty or /v1), or null. */
function officialMoonshotBaseUrl(value) {
  const parsed = officialHostUrl(value, MOONSHOT_HOSTS);
  if (!parsed) return null;
  const pathname = parsed.pathname.replace(/\/$/, '');
  if (!(pathname === '' || pathname === '/v1')) return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  return MOONSHOT_CURRENCY_BY_HOST[parsed.hostname] ?? null;
}

/**
 * Resolve the Moonshot endpoints from the provider's inference base URL. The
 * region and currency follow the host alone, so the key is only ever sent to
 * the platform that issued it.
 */
function moonshotEndpoints(config) {
  const currency = officialMoonshotBaseUrl(config?.baseUrl);
  if (currency === null) return null;
  const cn = currency === 'CNY';
  return {
    region: cn ? 'cn' : 'intl',
    currency,
    usageUrl: cn ? MOONSHOT_CN_BALANCE_URL : MOONSHOT_INTL_BALANCE_URL,
    balanceUrl: null,
  };
}

/**
 * Fetch one Moonshot balance response without mutating any local state. The
 * HTTP layer is classified by requestJsonWithLimits (401/403 unauthorized,
 * 429/5xx transient with Retry-After, everything else invalid); a 200 body is
 * then classified from its own envelope, so account-level body errors never
 * spend a second request.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestMoonshotUsage({
  apiKey,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const usageUrl = endpoints?.usageUrl;
  const hostCurrency = moonshotBalanceCurrency(usageUrl);
  const declaredCurrency = typeof endpoints?.currency === 'string'
    ? endpoints.currency.toUpperCase()
    : null;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || hostCurrency === null
    || (declaredCurrency !== null && declaredCurrency !== hostCurrency)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const envelope = await requestJsonWithLimits({
    url: usageUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: (json) => json,
  });
  if (envelope.status !== PROVIDER_USAGE_RESULT.SUCCESS) return envelope;
  const outcome = moonshotEnvelopeOutcome(envelope.parsed);
  if (outcome === 'unauthorized') {
    return { status: PROVIDER_USAGE_RESULT.UNAUTHORIZED, category: REQUEST_CATEGORY.AUTH };
  }
  const parsed = outcome === 'ok' ? parseMoonshotBalance(envelope.parsed, hostCurrency) : null;
  return parsed
    ? { status: PROVIDER_USAGE_RESULT.SUCCESS, parsed }
    : { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
}

export const ADAPTER = Object.freeze({
  id: MOONSHOT_PROVIDER,
  hosts: MOONSHOT_HOSTS,
  metric: 'balance',
  accepts: moonshotEndpoints,
  request: requestMoonshotUsage,
});
