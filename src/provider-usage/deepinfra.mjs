// DeepInfra balance adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /payment/checklist billing report on
// api.deepinfra.com — and nothing else.
//
// id: 'deepinfra' · hosts: api.deepinfra.com · metric: balance
// accepts(config): config.baseUrl must be a documented DeepInfra inference base
//   (https, api.deepinfra.com, default port, no userinfo, path empty or one of
//   /v1, /v1/openai, /v1/inference, no query/hash) so a compatible third-party
//   gateway never receives the key.
// request(): one GET to the pinned checklist URL. `stripe_balance` is negative
//   for prepaid credit and positive for debt, `recent` is usage billed since
//   the last invoice; their sum is folded into a single USD balance row.
//   `available: false` marks an account that cannot spend — in debt or
//   suspended — because the balance row has no negative amount to show.
//   /payment/usage is deliberately not requested: neither balance nor window
//   rendering has a field for its monthly cost, and skipping it keeps a slow
//   second request off the refresh path.

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

export const DEEPINFRA_PROVIDER = 'deepinfra';
export const DEEPINFRA_CHECKLIST_URL = 'https://api.deepinfra.com/payment/checklist?compute_owed=true';

const DEEPINFRA_HOSTS = Object.freeze(['api.deepinfra.com']);
// The two documented inference surfaces: the OpenAI-compatible path and the
// native one. The bare origin and /v1 are what users typically type.
const DEEPINFRA_BASE_PATHS = new Set(['', '/v1', '/v1/openai', '/v1/inference']);

function officialDeepInfraBaseUrl(value) {
  const parsed = officialHostUrl(value, DEEPINFRA_HOSTS);
  if (!parsed) return false;
  return DEEPINFRA_BASE_PATHS.has(parsed.pathname.replace(/\/$/, ''))
    && parsed.search === ''
    && parsed.hash === '';
}

/**
 * The checklist URL is pinned including its query: `compute_owed=true` is not
 * in DeepInfra's documented parameter table, but it is what the reference
 * client always sends, and the omitted form has never been verified.
 */
function officialDeepInfraChecklistUrl(value) {
  const parsed = officialHostUrl(value, DEEPINFRA_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === '/payment/checklist'
    && parsed.search === '?compute_owed=true'
    && parsed.hash === '';
}

/** One finite number from a JSON field, or null when the field is absent,
 * blank, or not numeric. `Number(null)` would read as 0, so presence is
 * checked before coercion. */
function deepinfraNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * Parse DeepInfra's checklist report into a USD balance. `stripe_balance` is
 * sign-inverted (negative = prepaid credit, positive = debt) and `recent` is
 * the usage accumulated since the last invoice, so the spendable amount is
 * `-(stripe_balance + recent)`, floored at zero: debt and suspension collapse
 * onto `available: false` rather than a negative total. `granted` and
 * `toppedUp` stay null — `scoped_credits` are per-model discounts, not an
 * account-wide grant, and folding them in would overstate the balance.
 */
export function parseDeepInfraChecklist(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const stripeBalance = deepinfraNumber(json.stripe_balance);
  const recent = deepinfraNumber(json.recent);
  if (stripeBalance === null || recent === null) return null;
  const effective = stripeBalance + recent;
  return normalizeUsage({
    kind: 'balance',
    label: 'DeepInfra',
    available: json.suspended !== true && effective <= 0,
    balances: [{
      currency: 'USD',
      total: Math.max(0, -effective),
      granted: null,
      toppedUp: null,
    }],
  });
}

/** Fetch one DeepInfra checklist response without mutating any local state.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestDeepInfraUsage({
  apiKey,
  url = null,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetUrl = url ?? endpoints?.checklistUrl ?? DEEPINFRA_CHECKLIST_URL;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialDeepInfraChecklistUrl(targetUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: targetUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseDeepInfraChecklist,
  });
}

export const ADAPTER = Object.freeze({
  id: DEEPINFRA_PROVIDER,
  hosts: DEEPINFRA_HOSTS,
  metric: 'balance',
  accepts: (config) => (officialDeepInfraBaseUrl(config.baseUrl)
    ? { checklistUrl: DEEPINFRA_CHECKLIST_URL }
    : null),
  request: requestDeepInfraUsage,
});
