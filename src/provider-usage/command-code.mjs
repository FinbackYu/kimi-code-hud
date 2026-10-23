// Command Code credit and usage-window adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns the
// Command Code surfaces the vendor CLI calls with the same inference API key:
// the credit snapshot with its 5h/7d window limits, the subscription cycle
// behind the monthly window, and the remaining USD credit balance.
//
// id: 'command-code' · hosts: api.commandcode.ai · metric: usage windows
// accepts(config): only the official inference host. The documented provider
//   base URL is https://api.commandcode.ai/provider/v1 (chat completions,
//   responses and messages all hang off it), and the credential boundary is
//   that exact host, so only the bare root and the /provider and /provider/v1
//   bases are accepted. commandcode.ai / www.commandcode.ai are the web app,
//   not inference hosts; a compatible-looking proxy fails closed.
// request(): one GET to /alpha/billing/credits, then an optional GET to
//   /alpha/billing/subscriptions for the monthly plan cycle. The plan request
//   is never allowed to change the outcome: its failures only drop the plan id
//   and the monthly reset time.
//
// The /alpha/* routes are undocumented internal API (the routes the `cmd` CLI
// itself uses), so every field is read defensively. Anything unexpected
// degrades to the monthly balance, or to an `invalid` result, and never
// throws; nothing here logs or caches, and the caller owns all state writes.

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

export const COMMAND_CODE_PROVIDER = 'command-code';
export const COMMAND_CODE_CREDITS_URL = 'https://api.commandcode.ai/alpha/billing/credits';
export const COMMAND_CODE_SUBSCRIPTIONS_URL = 'https://api.commandcode.ai/alpha/billing/subscriptions';

const COMMAND_CODE_HOSTS = Object.freeze(['api.commandcode.ai']);

// The plan request only refines the monthly window, so it gets a short grace
// period (the same 2s the reference implementation allows for this optional
// call) even when the caller allows the credit request a long budget.
const COMMAND_CODE_PLAN_TIMEOUT_MS = 2_000;

// Monthly credit caps by plan id, in USD. Only ids confirmed by captured
// responses are listed: an unknown plan id keeps its monthly window out rather
// than inventing a cap. `monthlyCreditsGranted` in the credits payload always
// wins over this table.
const COMMAND_CODE_PLAN_CREDITS = Object.freeze({
  'individual-go': 10,
});

// Resets above this magnitude are epoch milliseconds; anything smaller is
// epoch seconds. The live service is known to mix both in one payload (the
// 5h window in seconds, the weekly window in milliseconds).
const COMMAND_CODE_MS_THRESHOLD = 10_000_000_000;

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One finite number from a JSON field, or null when the field is absent,
 * blank, or not finite. Numeric strings are accepted because the service is
 * not documented and has been seen to quote amounts. */
function commandCodeNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function nonNegative(value) {
  return value !== null && value >= 0 ? value : null;
}

/**
 * Normalize a reset timestamp to ISO text. Numbers (and all-digit strings) are
 * seconds or milliseconds by magnitude; ISO 8601 strings are parsed directly;
 * 0, null, blank text and anything else become null so the window keeps only
 * its ratio.
 */
function commandCodeResetAt(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const milliseconds = value > COMMAND_CODE_MS_THRESHOLD ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return commandCodeResetAt(Number(trimmed));
  if (!ISO_INSTANT_RE.test(trimmed)) return null;
  const stamp = Date.parse(trimmed);
  return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : null;
}

/** The credit figures every mapping depends on, or null when the response no
 * longer carries the one field that cannot be substituted. */
function commandCodeCredits(json) {
  if (!plainObject(json)) return null;
  const credits = json.credits;
  if (!plainObject(credits)) return null;
  const monthlyCredits = commandCodeNumber(credits.monthlyCredits);
  if (monthlyCredits === null || monthlyCredits < 0) return null;
  return {
    monthlyCredits,
    monthlyCreditsGranted: nonNegative(commandCodeNumber(credits.monthlyCreditsGranted)),
    purchasedCredits: nonNegative(commandCodeNumber(credits.purchasedCredits)),
    freeCredits: nonNegative(commandCodeNumber(credits.freeCredits)),
    windowLimits: commandCodeWindowLimits(json, credits),
  };
}

/** The service puts `windowLimits` at the root or inside `credits`; the root
 * copy wins, and a root object without either window key falls through to the
 * nested copy instead of hiding it. */
function commandCodeWindowLimits(json, credits) {
  for (const candidate of [json.windowLimits, credits.windowLimits]) {
    if (
      plainObject(candidate)
      && (Object.hasOwn(candidate, 'fiveHour') || Object.hasOwn(candidate, 'weekly'))
    ) {
      return candidate;
    }
  }
  return null;
}

/** One window limit as `used / cap`, the used share in [0, 1]. Windows whose
 * counters are missing or unusable, and empty windows (cap <= 0), are skipped
 * rather than reported as 0% used. */
function commandCodeWindow(raw, label) {
  if (!plainObject(raw)) return null;
  const used = commandCodeNumber(raw.used);
  const cap = commandCodeNumber(raw.cap);
  if (used === null || cap === null || used < 0 || cap <= 0) return null;
  return {
    label,
    usedRatio: Math.min(1, used / cap),
    resetAt: commandCodeResetAt(raw.resetAt),
  };
}

/** Subscription cycle: `{success: true, data: null}` is the free tier, not an
 * error, and every other unusable envelope is treated the same way. */
function commandCodePlan(json) {
  if (!plainObject(json) || json.success !== true || !plainObject(json.data)) return null;
  return {
    planId: typeof json.data.planId === 'string' ? json.data.planId : null,
    currentPeriodEnd: commandCodeResetAt(json.data.currentPeriodEnd),
  };
}

/** The monthly cap: the payload's own grant first, then the confirmed catalog. */
function commandCodeGrant(credits, plan) {
  if (credits.monthlyCreditsGranted !== null) return credits.monthlyCreditsGranted;
  const planId = plan?.planId;
  return planId && Object.hasOwn(COMMAND_CODE_PLAN_CREDITS, planId)
    ? COMMAND_CODE_PLAN_CREDITS[planId]
    : null;
}

/** The monthly window is `(grant - remaining) / grant`: monthlyCredits is the
 * remaining monthly allowance, so it must not be read as the total. */
function commandCodeMonthlyWindow(credits, plan) {
  const grant = commandCodeGrant(credits, plan);
  if (grant === null || grant <= 0) return null;
  const used = (grant - credits.monthlyCredits) / grant;
  return {
    label: 'mo',
    usedRatio: Math.min(1, Math.max(0, used)),
    resetAt: plan?.currentPeriodEnd ?? null,
  };
}

/**
 * Parse one Command Code credit snapshot, with the subscription envelope as an
 * optional companion. 5h/7d come from `windowLimits`; `mo` comes from the
 * remaining monthly credits against a known grant. When no window can be
 * built the snapshot degrades to the remaining USD credit balance instead of
 * claiming 0% used. `premiumMonthlyCredits` and `opensourceMonthlyCredits` are
 * category views of the same allowance, not addable balances, so they are
 * deliberately ignored.
 * @param {object} json /alpha/billing/credits response
 * @param {object|null} [subscriptions] /alpha/billing/subscriptions response
 * @returns {object|null} normalized usage, or null for an unusable shape
 */
export function parseCommandCodeCredits(json, subscriptions = null) {
  const credits = commandCodeCredits(json);
  if (!credits) return null;
  const plan = commandCodePlan(subscriptions);
  const limits = credits.windowLimits;
  const windows = [];
  const fiveHour = limits ? commandCodeWindow(limits.fiveHour, '5h') : null;
  const weekly = limits ? commandCodeWindow(limits.weekly, '7d') : null;
  const monthly = commandCodeMonthlyWindow(credits, plan);
  if (fiveHour) windows.push(fiveHour);
  if (weekly) windows.push(weekly);
  if (monthly) windows.push(monthly);
  if (windows.length > 0) {
    return normalizeUsage({ kind: 'windows', label: 'Command Code', windows });
  }
  const total = credits.monthlyCredits
    + (credits.purchasedCredits ?? 0)
    + (credits.freeCredits ?? 0);
  return normalizeUsage({
    kind: 'balance',
    label: 'Command Code',
    available: true,
    balances: [{
      currency: 'USD',
      total,
      granted: commandCodeGrant(credits, plan),
      toppedUp: credits.purchasedCredits,
    }],
  });
}

/** Pinned https URL: credential-safe, exact host, exact path, no query/hash. */
function pinnedCommandCodeUrl(value, pathname) {
  const parsed = officialHostUrl(value, COMMAND_CODE_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === pathname
    && parsed.search === ''
    && parsed.hash === '';
}

function officialCommandCodeCreditsUrl(value) {
  return pinnedCommandCodeUrl(value, '/alpha/billing/credits');
}

function officialCommandCodeSubscriptionsUrl(value) {
  return pinnedCommandCodeUrl(value, '/alpha/billing/subscriptions');
}

/**
 * Resolve the Command Code endpoints from the provider's inference base URL.
 * Only the official host is accepted; the vendor web app and any proxy fail
 * closed before a credential exists.
 */
function commandCodeEndpoints(config) {
  if (!config) return null;
  const parsed = officialHostUrl(config.baseUrl, COMMAND_CODE_HOSTS);
  if (!parsed) return null;
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname !== '' && pathname !== '/provider' && pathname !== '/provider/v1') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  return {
    creditsUrl: COMMAND_CODE_CREDITS_URL,
    subscriptionsUrl: COMMAND_CODE_SUBSCRIPTIONS_URL,
  };
}

/**
 * Fetch one Command Code credit snapshot and, when the credits payload is
 * usable, the subscription cycle that dates the monthly window. Only the
 * credits request decides the result: HTTP failures and unusable credit
 * payloads are returned as-is, and no plan request is spent on them. Any plan
 * failure — HTTP, envelope or shape — leaves the credit-only result in place,
 * because a plan lookup is an enhancement, not a second account signal.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestCommandCodeUsage({
  apiKey,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const creditsUrl = endpoints?.creditsUrl;
  const subscriptionsUrl = endpoints?.subscriptionsUrl ?? null;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialCommandCodeCreditsUrl(creditsUrl)
    || (subscriptionsUrl !== null && !officialCommandCodeSubscriptionsUrl(subscriptionsUrl))
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const credits = await requestJsonWithLimits({
    url: creditsUrl,
    headers,
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: (json) => json,
    now,
  });
  if (credits.status !== PROVIDER_USAGE_RESULT.SUCCESS) return credits;
  if (!commandCodeCredits(credits.parsed)) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  let subscriptions = null;
  if (subscriptionsUrl !== null) {
    const plan = await requestJsonWithLimits({
      url: subscriptionsUrl,
      headers,
      timeoutMs: Math.min(timeoutMs, COMMAND_CODE_PLAN_TIMEOUT_MS),
      maxBytes,
      fetchImpl,
      parse: (json) => json,
      now,
    });
    if (plan.status === PROVIDER_USAGE_RESULT.SUCCESS) subscriptions = plan.parsed;
  }
  const parsed = parseCommandCodeCredits(credits.parsed, subscriptions);
  return parsed
    ? { status: PROVIDER_USAGE_RESULT.SUCCESS, parsed }
    : { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
}

export const ADAPTER = Object.freeze({
  id: COMMAND_CODE_PROVIDER,
  hosts: COMMAND_CODE_HOSTS,
  metric: 'usage windows',
  accepts: commandCodeEndpoints,
  request: requestCommandCodeUsage,
});
