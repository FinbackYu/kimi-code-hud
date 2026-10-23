// DeepSeek balance adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /user/balance endpoint on
// api.deepseek.com — and nothing else.
//
// id: 'deepseek' · hosts: api.deepseek.com · metric: balance
// accepts(config): config.baseUrl must be the official DeepSeek inference
//   base (https, api.deepseek.com, default port, no userinfo, path empty or
//   /v1) so a compatible third-party proxy never receives the key.
// request(): one GET to the pinned balance URL; the response is parsed into
//   { kind: 'balance', label: 'DeepSeek', ... } by parseDeepSeekBalance.

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

export const DEEPSEEK_PROVIDER = 'deepseek';
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

const DEEPSEEK_HOSTS = Object.freeze(['api.deepseek.com']);

function officialDeepSeekBaseUrl(value) {
  const parsed = officialHostUrl(value, DEEPSEEK_HOSTS);
  if (!parsed) return false;
  const pathname = parsed.pathname.replace(/\/$/, '');
  return (pathname === '' || pathname === '/v1')
    && parsed.search === ''
    && parsed.hash === '';
}

function officialDeepSeekBalanceUrl(value) {
  const parsed = officialHostUrl(value, DEEPSEEK_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === '/user/balance'
    && parsed.search === ''
    && parsed.hash === '';
}

/** Parse DeepSeek's official /user/balance response into provider-neutral data. */
export function parseDeepSeekBalance(json) {
  if (!json || typeof json !== 'object' || typeof json.is_available !== 'boolean') return null;
  return normalizeUsage({
    kind: 'balance',
    label: 'DeepSeek',
    available: json.is_available,
    balances: json.balance_infos,
  });
}

/** Fetch one DeepSeek balance response without mutating any local state.
 * The whole request — headers, body and JSON parse — shares one deadline, and
 * response bodies are size-capped and always released.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestDeepSeekUsage({
  apiKey,
  url = null,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetUrl = url ?? endpoints?.usageUrl ?? DEEPSEEK_BALANCE_URL;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialDeepSeekBalanceUrl(targetUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: targetUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseDeepSeekBalance,
  });
}

export const ADAPTER = Object.freeze({
  id: DEEPSEEK_PROVIDER,
  hosts: DEEPSEEK_HOSTS,
  metric: 'balance',
  accepts: (config) => (officialDeepSeekBaseUrl(config.baseUrl)
    ? { usageUrl: DEEPSEEK_BALANCE_URL, balanceUrl: null }
    : null),
  request: requestDeepSeekUsage,
});
