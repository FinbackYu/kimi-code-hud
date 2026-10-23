// Shared base for the per-provider usage adapters in this directory.
//
// Each adapter module (deepseek.mjs, opencode-go.mjs, zhipu.mjs, and every
// future one) exports one frozen `ADAPTER` object with this exact shape:
//
//   ADAPTER = {
//     // Stable registry identity, unique across adapters. Also names the
//     // module in diagnostics; the configured provider name is NOT used.
//     id: 'deepseek',
//     // Official inference base_url hosts this adapter serves. Documented
//     // only — selection happens through accepts(); one host belongs to
//     // exactly one adapter.
//     hosts: ['api.deepseek.com'],
//     // What the adapter produces, as the doctor spells it ("balance",
//     // "usage windows", "usage"). Shown in `--doctor` diagnostics.
//     metric: 'balance',
//     // Strictly validate config.baseUrl (the host's `base_url` value for the
//     // provider table) and return the endpoint parameters for request(), or
//     // null when this adapter does not serve that URL. Only the official
//     // host may be accepted: the credential is sent to whatever URL is
//     // returned, so a compatible-looking proxy must fail closed here.
//     accepts: (config) => endpoints | null,
//     // Perform at most the requests this adapter needs and normalize the
//     // result. Must not mutate local state; the caller owns cache writes.
//     //   -> { status, category, parsed? }
//     // status is a PROVIDER_USAGE_RESULT value; category a REQUEST_CATEGORY
//     // value on failure; parsed is the provider-neutral usage object built
//     // with normalizeUsage() below.
//     request: async ({ apiKey, endpoints, timeoutMs, fetchImpl }) => result,
//   };
//
// This module holds what every adapter shares: the result vocabulary, the
// provider-neutral usage normalizer (the single gate every parsed payload and
// every cache record passes through), and the credential-safe URL parser.

export const PROVIDER_USAGE_RESULT = Object.freeze({
  SUCCESS: 'success',
  UNAUTHORIZED: 'unauthorized',
  TRANSIENT: 'transient',
  INVALID: 'invalid',
});

function finiteAmount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizeBalanceInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const currency = typeof info.currency === 'string' ? info.currency.toUpperCase() : '';
  const total = finiteAmount(info.total ?? info.total_balance);
  if (!/^[A-Z]{3}$/.test(currency) || total === null) return null;
  const granted = finiteAmount(info.granted ?? info.granted_balance);
  const toppedUp = finiteAmount(info.toppedUp ?? info.topped_up_balance);
  return { currency, total, granted, toppedUp };
}

function normalizeUsageLabel(label) {
  return typeof label === 'string' && /^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,31}$/.test(label);
}

function normalizeWindowEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.]{0,15}$/.test(entry.label)) {
    return null;
  }
  const usedRatio = Number(entry.usedRatio);
  if (!Number.isFinite(usedRatio) || usedRatio < 0) return null;
  return {
    label: entry.label,
    usedRatio,
    resetAt: typeof entry.resetAt === 'string' ? entry.resetAt : null,
  };
}

/** Validate one parsed (or cached) usage record into its display-safe form. */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || !normalizeUsageLabel(usage.label)) return null;
  if (usage.kind === 'balance') {
    if (typeof usage.available !== 'boolean' || !Array.isArray(usage.balances)) return null;
    const balances = usage.balances.map(normalizeBalanceInfo).filter(Boolean);
    if (balances.length === 0) return null;
    return {
      kind: 'balance',
      label: usage.label,
      available: usage.available,
      balances,
    };
  }
  if (usage.kind === 'windows') {
    if (!Array.isArray(usage.windows)) return null;
    const windows = usage.windows.map(normalizeWindowEntry).filter(Boolean);
    if (windows.length === 0) return null;
    return {
      kind: 'windows',
      label: usage.label,
      windows,
    };
  }
  return null;
}

/**
 * Parse a URL that may carry a provider credential: https only, the default
 * port (or none), and no userinfo. Returns the parsed URL or null. Every
 * adapter's host and endpoint checks are layered on top of this, so the
 * transport rules live in one place.
 * @param {string|null|undefined} value
 * @returns {URL|null}
 */
export function credentialedHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    if (!(parsed.port === '' || parsed.port === '443')) return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Exact-host variant of credentialedHttpsUrl: null unless the URL is
 * credential-safe and its hostname is one of `hosts`. Hostnames compare
 * exactly, so `api.deepseek.com.evil` never matches.
 * @param {string|null|undefined} value
 * @param {string[]} hosts
 * @returns {URL|null}
 */
export function officialHostUrl(value, hosts) {
  const parsed = credentialedHttpsUrl(value);
  return parsed && hosts.includes(parsed.hostname) ? parsed : null;
}
