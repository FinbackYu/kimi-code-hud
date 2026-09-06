import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from './fs-store.mjs';

export const REQUEST_RESULT = Object.freeze({
  SUCCESS: 'success',
  UNAUTHORIZED: 'unauthorized',
  TRANSIENT: 'transient',
  INVALID: 'invalid',
});

/**
 * One error vocabulary shared by every background usage request. The five
 * classes the remediation plan asks to distinguish are TIMEOUT, NETWORK,
 * RATE_LIMITED, SERVER, AUTH and INVALID_FORMAT; BODY_LIMIT and
 * UNEXPECTED_STATUS cover the remaining protocol violations.
 */
export const REQUEST_CATEGORY = Object.freeze({
  NONE: 'none',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  RATE_LIMITED: 'rate_limited',
  SERVER: 'server',
  AUTH: 'auth',
  INVALID_FORMAT: 'invalid_format',
  BODY_LIMIT: 'body_limit',
  UNEXPECTED_STATUS: 'unexpected_status',
});

export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

/** Hard ceiling for one response body; quota/balance payloads are far smaller. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Refresh backoff schedule, fixed by contract: the first retry waits
 * RETRY_BASE_DELAY_MS, each further failure doubles the delay (plus up to
 * RETRY_JITTER_MAX_MS of jitter), and RETRY_MAX_DELAY_MS bounds every delay —
 * including honored Retry-After values — so one broken endpoint can never
 * silence a segment indefinitely.
 */
export const RETRY_BASE_DELAY_MS = 2_000;
export const RETRY_MAX_DELAY_MS = 300_000;
export const RETRY_JITTER_MAX_MS = 1_000;

export const REFRESH_STATE_VERSION = 1;

const STATE_CATEGORIES = new Set(Object.values(REQUEST_CATEGORY));

function noop() {}

function cancelBody(response) {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(noop);
  } catch {
    // No stream to release (mock responses, already-closed bodies).
  }
}

function retryAfterHeader(response) {
  try {
    const headers = response.headers;
    if (!headers) return null;
    if (typeof headers.get === 'function') {
      const value = headers.get('retry-after');
      return typeof value === 'string' ? value : null;
    }
    const raw = headers['retry-after'] ?? headers['Retry-After'];
    return typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Parse one Retry-After value. Accepts delay-seconds (integer, per RFC 9110)
 * and IMF-fixdate HTTP dates; anything else — including empty, fractional,
 * negative or unparsable values — returns null so callers fall back to a
 * conservative default. A date already in the past yields 0.
 * @param {string|null} value
 * @param {number} [now]
 * @returns {number|null} milliseconds, or null when unusable
 */
const HTTP_DATE_RE = /^[A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return seconds * 1000;
  }
  if (!HTTP_DATE_RE.test(trimmed)) return null;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

/**
 * Read one response body under the byte ceiling. Real streams are read
 * chunk-wise and cancelled the moment they exceed the limit; mock responses
 * carrying only json() fall through to that method (still under the request
 * deadline held by the caller).
 */
async function readBody(response, maxBytes) {
  const stream = response.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength ?? value.length ?? 0;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* stream already gone */ }
          return { tooLarge: true };
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* lock already gone */ }
    }
    return { kind: 'text', text: Buffer.concat(chunks).toString('utf8') };
  }
  const json = await response.json();
  return { kind: 'json', json };
}

/**
 * One fetch with a single deadline covering the whole request lifecycle:
 * response headers, body read and JSON parsing all complete before the timer
 * is cleared, so a fast header/slow body server can no longer stretch a call
 * past its budget. Response bodies are cancelled on every exit path (non-2xx
 * included) to release the connection, and real streams are aborted once they
 * exceed maxBytes. Never throws; every outcome is classified.
 * @param {object} opts
 * @param {string} opts.url already caller-whitelisted endpoint
 * @param {object} opts.headers request headers (may carry Authorization)
 * @param {number} [opts.timeoutMs] whole-request budget
 * @param {number} [opts.maxBytes] response body ceiling
 * @param {Function} [opts.fetchImpl] injectable fetch
 * @param {Function} [opts.parse] payload validator, returns null when unusable
 * @param {number} [opts.now] clock for Retry-After date parsing
 * @returns {Promise<{status: string, category: string, parsed?: object,
 *   retryAfterSeen?: boolean, retryAfterMs?: number|null}>}
 */
export async function requestJsonWithLimits({
  url,
  headers,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
  parse = (json) => (json && typeof json === 'object' ? json : null),
  now = Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { status: REQUEST_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  }
  const totalMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  let response = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* already aborted */ }
      reject(new Error('request exceeded its whole-lifecycle deadline'));
    }, totalMs);
  });
  try {
    response = await Promise.race([
      fetchImpl(url, { headers, signal: controller.signal }),
      deadline,
    ]);
    if (!response || typeof response.status !== 'number' || typeof response.ok !== 'boolean') {
      return { status: REQUEST_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: REQUEST_RESULT.UNAUTHORIZED, category: REQUEST_CATEGORY.AUTH };
    }
    if (response.status === 429 || response.status >= 500) {
      const headerValue = retryAfterHeader(response);
      return {
        status: REQUEST_RESULT.TRANSIENT,
        category: response.status === 429
          ? REQUEST_CATEGORY.RATE_LIMITED
          : REQUEST_CATEGORY.SERVER,
        retryAfterSeen: headerValue !== null,
        retryAfterMs: headerValue === null ? null : parseRetryAfter(headerValue, now),
      };
    }
    if (!response.ok) {
      return { status: REQUEST_RESULT.INVALID, category: REQUEST_CATEGORY.UNEXPECTED_STATUS };
    }
    const body = await Promise.race([readBody(response, byteLimit), deadline]);
    if (!body || body.tooLarge) {
      return { status: REQUEST_RESULT.INVALID, category: REQUEST_CATEGORY.BODY_LIMIT };
    }
    let json = body.json;
    if (body.kind === 'text') {
      try {
        json = JSON.parse(body.text);
      } catch {
        return { status: REQUEST_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
      }
    }
    let parsed = null;
    try {
      parsed = parse(json);
    } catch {
      parsed = null;
    }
    return parsed
      ? { status: REQUEST_RESULT.SUCCESS, parsed }
      : { status: REQUEST_RESULT.INVALID, category: REQUEST_CATEGORY.INVALID_FORMAT };
  } catch {
    return timedOut
      ? { status: REQUEST_RESULT.TRANSIENT, category: REQUEST_CATEGORY.TIMEOUT }
      : { status: REQUEST_RESULT.TRANSIENT, category: REQUEST_CATEGORY.NETWORK };
  } finally {
    if (timer !== null) clearTimeout(timer);
    cancelBody(response);
  }
}

/**
 * Backoff for the next retry attempt. A seen Retry-After header wins and is
 * clamped into [RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS]; invalid values
 * collapse onto the conservative base delay. Without Retry-After the delay
 * grows exponentially from the base with bounded jitter.
 * @param {object} [opts]
 * @returns {number} milliseconds to wait before the next attempt
 */
export function refreshDelayMs({
  failures,
  retryAfterSeen = false,
  retryAfterMs = null,
  jitter = Math.random,
} = {}) {
  const clamp = (ms) => Math.min(RETRY_MAX_DELAY_MS, Math.max(RETRY_BASE_DELAY_MS, ms));
  if (retryAfterSeen === true) {
    const value = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
      ? retryAfterMs
      : -1;
    return clamp(value);
  }
  const attempt = Number.isFinite(failures) && failures >= 1 ? Math.floor(failures) : 1;
  const exponential = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const extraJitter = Math.floor(jitter() * RETRY_JITTER_MAX_MS);
  return clamp(exponential + extraJitter);
}

/** Short, non-reversible digest used as a refresh-state context key. */
export function shortDigest(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/**
 * Read one persisted refresh-failure state. Returns null for missing,
 * corrupt or foreign-version files — the guard then behaves as if no
 * failure had ever been recorded.
 * @param {string|null} statePath
 * @returns {object|null}
 */
export function readRefreshState(statePath) {
  if (typeof statePath !== 'string' || statePath.length === 0) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (
      !state
      || typeof state !== 'object'
      || state.version !== REFRESH_STATE_VERSION
      || !STATE_CATEGORIES.has(state.category)
      || !Number.isInteger(state.failures)
      || state.failures < 0
      || typeof state.nextAttemptAt !== 'number'
      || !Number.isFinite(state.nextAttemptAt)
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * True while persisted failures forbid starting another refresh. Never
 * throws; a missing statePath (feature off) never blocks.
 * @param {string|null} statePath
 * @param {number} [now]
 */
export function isRefreshBlocked(statePath, now = Date.now()) {
  const state = readRefreshState(statePath);
  return state !== null && now < state.nextAttemptAt;
}

/**
 * Persist one failed refresh. The state carries only the failure count, the
 * error category, the computed next-attempt time and an optional non-reversible
 * context digest — never response bodies, tokens or request headers. When the
 * recorded context digest differs from the current one (account or region
 * switch), the failure count restarts instead of inheriting the other
 * account's lockout. Writes are atomic; failures to persist are swallowed.
 * @param {object} opts
 * @returns {object|null} the recorded state, or null when nothing was written
 */
export function recordRefreshFailure({
  statePath,
  category = REQUEST_CATEGORY.NETWORK,
  retryAfterSeen = false,
  retryAfterMs = null,
  now = Date.now(),
  jitter = Math.random,
  contextKey = null,
} = {}) {
  if (typeof statePath !== 'string' || statePath.length === 0) return null;
  const previous = readRefreshState(statePath);
  const switchedContext =
    previous !== null && contextKey !== null && previous.contextKey !== contextKey;
  const failures = (switchedContext ? 0 : previous?.failures ?? 0) + 1;
  const delay = refreshDelayMs({ failures, retryAfterSeen, retryAfterMs, jitter });
  const state = {
    version: REFRESH_STATE_VERSION,
    category,
    failures,
    nextAttemptAt: now + delay,
    updatedAt: now,
  };
  if (contextKey !== null) state.contextKey = contextKey;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    atomicWriteFile(statePath, JSON.stringify(state));
    return state;
  } catch {
    return null;
  }
}

/** Remove persisted failure state after a successful refresh. */
export function clearRefreshState(statePath) {
  if (typeof statePath !== 'string' || statePath.length === 0) return false;
  try {
    fs.unlinkSync(statePath);
    return true;
  } catch {
    return false;
  }
}
