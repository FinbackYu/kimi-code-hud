// OpenCode Go subscription-window adapter.
//
// Adapter contract: see the header of ./common.mjs. This module owns exactly
// one provider surface — the official /zen/go/v1/usage endpoint on
// opencode.ai.
//
// id: 'opencode-go' · hosts: opencode.ai · metric: usage windows
// accepts(config): the credential boundary is the official host, not a path.
//   The key is only ever sent to opencode.ai, the same host the provider's
//   inference base_url already points at; both /inference/go/* and /zen/go/*
//   are the official service, so any path (and query/hash) on that exact host
//   is accepted. Proxies fail closed.
// request(): one GET to the pinned usage URL; parseOpenCodeGoUsage turns the
//   rolling/weekly/monthly percentages into labeled windows.

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

export const OPENCODE_GO_PROVIDER = 'opencode-go';
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

const OPENCODE_GO_HOSTS = Object.freeze(['opencode.ai']);

function officialOpenCodeGoBaseUrl(value) {
  return Boolean(officialHostUrl(value, OPENCODE_GO_HOSTS));
}

function officialOpenCodeGoUsageUrl(value) {
  const parsed = officialHostUrl(value, OPENCODE_GO_HOSTS);
  return Boolean(parsed)
    && parsed.pathname === '/zen/go/v1/usage'
    && parsed.search === ''
    && parsed.hash === '';
}

function openCodeGoWindow(raw, label) {
  if (!raw || typeof raw !== 'object') return null;
  const percent = Number(raw.percent);
  if (!Number.isFinite(percent) || percent < 0) return null;
  return {
    label,
    usedRatio: percent / 100,
    resetAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
  };
}

/**
 * Parse OpenCode Go's /zen/go/v1/usage response into provider-neutral data.
 * The API reports each subscription window as a used percentage plus its
 * reset time: rolling (the 5h window), weekly (7d) and monthly. Rolling and
 * weekly are the core contract; monthly rides along when present.
 */
export function parseOpenCodeGoUsage(json) {
  const usage = json && typeof json === 'object' && !Array.isArray(json) ? json.usage : null;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const rolling = openCodeGoWindow(usage.rolling, '5h');
  const weekly = openCodeGoWindow(usage.weekly, '7d');
  if (!rolling || !weekly) return null;
  const monthly = openCodeGoWindow(usage.monthly, 'mo');
  return normalizeUsage({
    kind: 'windows',
    label: 'OpenCode Go',
    windows: monthly ? [rolling, weekly, monthly] : [rolling, weekly],
  });
}

/** Fetch one OpenCode Go usage response without mutating any local state.
 * Same request discipline as the DeepSeek balance fetch: one shared deadline
 * for headers, body and parse, size-capped and always released.
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestOpenCodeGoUsage({
  apiKey,
  url = null,
  endpoints = null,
  timeoutMs = 8000,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetUrl = url ?? endpoints?.usageUrl ?? OPENCODE_GO_USAGE_URL;
  if (
    typeof apiKey !== 'string'
    || apiKey.length === 0
    || !officialOpenCodeGoUsageUrl(targetUrl)
  ) {
    return { status: PROVIDER_USAGE_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  return requestJsonWithLimits({
    url: targetUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs,
    maxBytes,
    fetchImpl,
    parse: parseOpenCodeGoUsage,
  });
}

export const ADAPTER = Object.freeze({
  id: OPENCODE_GO_PROVIDER,
  hosts: OPENCODE_GO_HOSTS,
  metric: 'usage windows',
  accepts: (config) => (officialOpenCodeGoBaseUrl(config.baseUrl)
    ? { usageUrl: OPENCODE_GO_USAGE_URL, balanceUrl: null }
    : null),
  request: requestOpenCodeGoUsage,
});
