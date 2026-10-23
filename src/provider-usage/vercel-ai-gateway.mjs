// Vercel AI Gateway balance adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /v1/credits endpoint on
// ai-gateway.vercel.sh — and nothing else. The personal-budget surface
// (/ai-gateway/budgets/list) needs a separate Vercel access token plus a team
// id, so it is deliberately out of scope.
//
// id: 'vercel-ai-gateway' · hosts: ai-gateway.vercel.sh · metric: balance
// accepts(config): config.baseUrl must be one of the documented inference
//   entry points on the official gateway host (https, default port, no
//   userinfo, no query/hash), so a compatible third-party proxy never receives
//   the key. The key already targets this host for inference; the team is
//   inferred from the key, so no account identifier is needed.
// request(): one GET to the pinned credits URL and no fallback; the response
//   is parsed into { kind: 'balance', label: 'Vercel AI Gateway', ... }.

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

export const VERCEL_AI_GATEWAY_PROVIDER = 'vercel-ai-gateway';
export const VERCEL_AI_GATEWAY_CREDITS_URL = 'https://ai-gateway.vercel.sh/v1/credits';

const VERCEL_AI_GATEWAY_HOST = 'ai-gateway.vercel.sh';
const VERCEL_AI_GATEWAY_HOSTS = Object.freeze([VERCEL_AI_GATEWAY_HOST]);

// Inference entry points documented for this gateway: the OpenAI-compatible
// base, the generic coding-agent base, Codex, Cursor, the Anthropic Messages
// base and the bare host. Anything else on the host is not a surface we know,
// so it fails closed.
const VERCEL_AI_GATEWAY_BASE_PATHS = Object.freeze(new Set([
  '',
  '/v1',
  '/coding-agent/v1',
  '/codex/v1',
  '/cursor/v1',
  '/claude-code',
]));

/**
 * One USD amount from a credits field, or null when it is absent or not a
 * plain decimal. The REST sample types both fields as strings and the SDK
 * types them as numbers, so both are accepted; anything else (blank text,
 * thousands separators, `NaN`, objects) is refused rather than coerced.
 */
function creditAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(text)) return null;
  return Number(text);
}

function officialVercelAiGatewayBaseUrl(value) {
  const parsed = officialHostUrl(value, VERCEL_AI_GATEWAY_HOSTS);
  if (!parsed) return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return VERCEL_AI_GATEWAY_BASE_PATHS.has(pathname);
}

function officialVercelAiGatewayCreditsUrl(value) {
  const parsed = officialHostUrl(value, VERCEL_AI_GATEWAY_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === '/v1/credits'
    && parsed.search === ''
    && parsed.hash === '';
}

/**
 * Parse Vercel AI Gateway's /v1/credits response into provider-neutral data.
 * `balance` is the remaining credit in USD and is clamped at zero (the service
 * can report a negative balance; the balance model has no slot for debt).
 * `total_used` is lifetime spend, not a grant split, so it is validated and
 * then discarded instead of being mapped onto granted/toppedUp.
 */
export function parseVercelCredits(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const balance = creditAmount(json.balance);
  if (balance === null) return null;
  const totalUsed = creditAmount(json.total_used);
  if (totalUsed === null || totalUsed < 0) return null;
  return normalizeUsage({
    kind: 'balance',
    label: 'Vercel AI Gateway',
    available: true,
    balances: [{
      currency: 'USD',
      total: Math.max(0, balance),
      granted: null,
      toppedUp: null,
    }],
  });
}

/** Fetch one AI Gateway credits response without mutating any local state.
 * The whole request — headers, body and JSON parse — shares one deadline, and
 * response bodies are size-capped and always released.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestVercelAiGatewayUsage({
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
    || !officialVercelAiGatewayCreditsUrl(targetUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: targetUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseVercelCredits,
  });
}

export const ADAPTER = Object.freeze({
  id: VERCEL_AI_GATEWAY_PROVIDER,
  hosts: VERCEL_AI_GATEWAY_HOSTS,
  metric: 'balance',
  accepts: (config) => (officialVercelAiGatewayBaseUrl(config.baseUrl)
    ? { usageUrl: VERCEL_AI_GATEWAY_CREDITS_URL }
    : null),
  request: requestVercelAiGatewayUsage,
});
