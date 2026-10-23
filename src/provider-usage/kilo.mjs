// Kilo (Kilo Gateway prepaid credits) balance adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the Kilo console's tRPC credit-block query on
// app.kilo.ai — and nothing else.
//
// id: 'kilo' · hosts: ai-gateway.kilo.ai, api.kilo.ai · metric: balance
// accepts(config): the configured base URL must sit on one of the two official
//   Kilo inference hosts, at one of the inference paths each host documents, so
//   a compatible-looking proxy never receives the key. The endpoint itself is
//   always app.kilo.ai, so the credit query never follows the configured URL.
// request(): one GET of the pinned tRPC batch query. The console answers a
//   batch with one slot per procedure (array, sparse numeric-key object, or a
//   single envelope); credit blocks are slot 0, the Kilo Pass subscription is
//   slot 1, auto top-up is slot 2. Only the credit balance is mapped; the
//   subscription would model a monthly window better served by the balance
//   (every account has one, an account without a Pass does not).
//
// The endpoint is an undocumented console-internal tRPC batch: procedure names
// or the response envelope can change without notice, so every unexpected
// shape fails closed as INVALID and the facade keeps the last good cache.
//
// The optional X-KILOCODE-ORGANIZATIONID header is deliberately not sent: this
// adapter reads the personal account view, which is the default scope.

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

export const KILO_PROVIDER = 'kilo';

const KILO_USAGE_HOST = 'app.kilo.ai';
const KILO_TRPC_PATH = '/api/trpc/user.getCreditBlocks,kiloPass.getState,user.getAutoTopUpPaymentMethod';
// `input` decodes to {"0":{"json":null},"1":{"json":null},"2":{"json":null}}:
// the indices line up with the procedures in the path and carry no arguments.
const KILO_TRPC_SEARCH = '?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%2C%221%22%3A%7B%22json%22%3Anull%7D%2C%222%22%3A%7B%22json%22%3Anull%7D%7D';

export const KILO_USAGE_URL = `https://${KILO_USAGE_HOST}${KILO_TRPC_PATH}${KILO_TRPC_SEARCH}`;

const KILO_INFERENCE_HOSTS = Object.freeze(['ai-gateway.kilo.ai', 'api.kilo.ai']);

// Documented inference base paths per host. A path outside its host's set is
// not a Kilo entry point we can vouch for, so it fails closed.
const KILO_INFERENCE_PATHS = Object.freeze({
  'ai-gateway.kilo.ai': Object.freeze(new Set(['', '/api/v1'])),
  'api.kilo.ai': Object.freeze(new Set(['', '/api/gateway', '/api/openrouter'])),
});

const MICRO_USD = 1_000_000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** One finite number from a JSON field, or null when the field is absent,
 * blank, or not a finite number. `Number(null)` would read as 0, so presence
 * is checked before coercion. */
function kiloNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * The batch slot for one procedure index. A batch answers with an array in
 * procedure order, a sparse object keyed by index, or — for a single
 * procedure — one bare `{result|error}` envelope, which can only stand for
 * slot 0. Anything else yields undefined for every index.
 */
function kiloSlot(payload, index) {
  if (Array.isArray(payload)) return payload[index];
  if (!isPlainObject(payload)) return undefined;
  if (Object.hasOwn(payload, 'result') || Object.hasOwn(payload, 'error')) {
    return index === 0 ? payload : undefined;
  }
  return payload[String(index)];
}

/**
 * The business payload of one slot. tRPC wraps a payload as `result.data`,
 * either directly or — under the superjson transformer — as
 * `result.data.json` with `meta` alongside. A null `json` wrapper means the
 * procedure returned nothing.
 */
function kiloSlotData(entry) {
  if (!isPlainObject(entry) || !isPlainObject(entry.result)) return null;
  const data = entry.result.data;
  if (!isPlainObject(data)) return null;
  return isPlainObject(data.json) ? data.json : data;
}

/**
 * Classify one tRPC error slot. The code is read from the first of
 * `error.json.data.code`, `error.data.code` and `error.code`; the message from
 * `error.json.message` or `error.message`. Only an auth failure has its own
 * result — a renamed procedure (NOT_FOUND) and every other code collapse onto
 * INVALID, where the facade keeps the last good cache.
 */
function kiloErrorText(error) {
  if (!isPlainObject(error)) return null;
  const json = isPlainObject(error.json) ? error.json : null;
  const jsonData = isPlainObject(json?.data) ? json.data : null;
  const data = isPlainObject(error.data) ? error.data : null;
  const code = jsonData?.code ?? data?.code ?? error.code ?? null;
  const message = json?.message ?? error.message ?? null;
  return [
    typeof code === 'string' ? code : '',
    typeof message === 'string' ? message : '',
  ].join(' ');
}

const KILO_UNAUTHORIZED_RE = /unauthori[sz]ed|forbidden/i;

function kiloErrorFailure(error) {
  const text = kiloErrorText(error);
  return text !== null && KILO_UNAUTHORIZED_RE.test(text)
    ? { status: PROVIDER_USAGE_RESULT.UNAUTHORIZED, category: REQUEST_CATEGORY.AUTH }
    : { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
}

/**
 * Parse the credit-block payload into a plain USD balance. Every amount is
 * micro-USD (`_mUsd` divide by 1,000,000). `totalBalance_mUsd` is the
 * remaining credit — the same "what is left" reading the DeepSeek balance
 * uses — and is recomputed from the blocks only when the aggregate is absent.
 * `granted`/`toppedUp` stay null: credit blocks carry `is_free`, but the only
 * implementation known to read this endpoint ignores it, so splitting the
 * balance on it would be a guess. An exhausted account is a valid 0 balance,
 * not missing data.
 */
export function parseKiloBalance(json) {
  if (!isPlainObject(json)) return null;
  let micro = kiloNumber(json.totalBalance_mUsd);
  if (micro === null) {
    if (!Array.isArray(json.creditBlocks) || json.creditBlocks.length === 0) return null;
    const blockMicros = json.creditBlocks.map(
      (block) => (isPlainObject(block) ? kiloNumber(block.balance_mUsd) : null),
    );
    if (blockMicros.some((value) => value === null || value < 0)) return null;
    micro = blockMicros.reduce((sum, value) => sum + value, 0);
  }
  if (micro < 0) return null;
  const total = micro / MICRO_USD;
  return normalizeUsage({
    kind: 'balance',
    label: 'Kilo',
    available: total > 0,
    balances: [{ currency: 'USD', total, granted: null, toppedUp: null }],
  });
}

/** Pinned https URL: credential-safe, exact host, exact path, exact query.
 * The batch query is the one place a query string is genuinely required. */
function officialKiloUsageUrl(value) {
  const parsed = officialHostUrl(value, [KILO_USAGE_HOST]);
  return Boolean(parsed)
    && parsed.pathname === KILO_TRPC_PATH
    && parsed.search === KILO_TRPC_SEARCH
    && parsed.hash === '';
}

/**
 * Resolve the Kilo usage endpoint from the provider's inference base URL. The
 * official host plus one of its documented inference paths is the credential
 * boundary; the credit query is pinned to app.kilo.ai either way.
 */
function kiloEndpoints(config) {
  const parsed = officialHostUrl(config?.baseUrl, KILO_INFERENCE_HOSTS);
  if (!parsed) return null;
  const allowedPaths = KILO_INFERENCE_PATHS[parsed.hostname];
  const pathname = parsed.pathname.replace(/\/$/, '');
  if (!allowedPaths || !allowedPaths.has(pathname)) return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  return { usageUrl: KILO_USAGE_URL };
}

/**
 * Fetch one Kilo credit response without mutating any local state. HTTP
 * failures keep the guard's classification (401/403 auth, 429 and 5xx
 * transient with Retry-After, other non-2xx invalid). On HTTP 200 the batch
 * is inspected before normalization: an error in slot 0 or slot 1 fails the
 * whole response (an auth failure there is UNAUTHORIZED), while slot 2 — auto
 * top-up, which this adapter does not read — is ignored even when it errors.
 * A missing slot is not an error: the sparse batch form omits slots.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestKiloUsage({
  apiKey,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const usageUrl = endpoints?.usageUrl;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialKiloUsageUrl(usageUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const batch = await requestJsonWithLimits({
    url: usageUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: (json) => json,
    now,
  });
  if (batch.status !== PROVIDER_USAGE_RESULT.SUCCESS) return batch;
  const payload = batch.parsed;
  for (const index of [0, 1]) {
    const entry = kiloSlot(payload, index);
    if (isPlainObject(entry) && entry.error != null) return kiloErrorFailure(entry.error);
  }
  const parsed = parseKiloBalance(kiloSlotData(kiloSlot(payload, 0)));
  return parsed
    ? { status: PROVIDER_USAGE_RESULT.SUCCESS, parsed }
    : { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
}

export const ADAPTER = Object.freeze({
  id: KILO_PROVIDER,
  hosts: KILO_INFERENCE_HOSTS,
  metric: 'balance',
  accepts: kiloEndpoints,
  request: requestKiloUsage,
});
