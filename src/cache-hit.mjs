import { CACHE_MAX_SAMPLES, CACHE_TTL_MS } from './metrics-constants.mjs';

/**
 * Recent prompt-cache metrics reconstructed from the main agent's wire
 * journal. The caller owns persistence; this module only mutates the supplied
 * state and derives a render-safe metric.
 */

function emptyCache() {
  return {
    samples: [],
    lastMessageAt: null,
  };
}

function validUsageNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validTimestamp(value) {
  return validUsageNumber(value);
}

function validSample(sample) {
  return sample &&
    typeof sample === 'object' &&
    validUsageNumber(sample.readTokens) &&
    validUsageNumber(sample.inputTokens) &&
    validTimestamp(sample.time) &&
    sample.inputTokens > 0 &&
    sample.readTokens <= sample.inputTokens;
}

function ensureCacheState(state) {
  const cache = state.cache;
  const valid =
    cache &&
    typeof cache === 'object' &&
    Array.isArray(cache.samples) &&
    cache.samples.length <= CACHE_MAX_SAMPLES &&
    cache.samples.every(validSample) &&
    (cache.lastMessageAt === null || validTimestamp(cache.lastMessageAt));
  if (!valid) state.cache = emptyCache();
}

/**
 * Reset the recent cache samples and freshness anchor (wire truncated/rotated,
 * restore retry).
 * @param {object} state mutated in place
 */
export function resetCacheState(state) {
  state.cache = emptyCache();
}

function noteMessage(cache, time) {
  if (
    validTimestamp(time) &&
    (cache.lastMessageAt === null || time > cache.lastMessageAt)
  ) {
    cache.lastMessageAt = time;
  }
}

/**
 * Fold one wire row into the recent cache window. Each timestamped, complete
 * step.end keeps one token-weighted sample; usage.record is deliberately
 * ignored because it duplicates the step.end usage. Prompts only refresh the
 * message anchor and never make an expired sample eligible again.
 * @param {object} state mutated in place
 * @param {object} row parsed wire.jsonl line
 */
export function applyCacheWireRow(state, row) {
  ensureCacheState(state);

  const prompt = row?.type === 'turn.prompt';
  const event = row?.event;
  if (!prompt && (row?.type !== 'context.append_loop_event' || event?.type !== 'step.end')) {
    return;
  }
  noteMessage(state.cache, row.time);
  if (prompt) return;

  const usage = event.usage;
  const fields = [
    usage?.inputOther,
    usage?.inputCacheRead,
    usage?.inputCacheCreation,
  ];
  if (!validTimestamp(row.time) || !fields.every(validUsageNumber)) return;

  const inputTokens =
    usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
  if (!validUsageNumber(inputTokens) || inputTokens <= 0) return;
  state.cache.samples.push({
    readTokens: usage.inputCacheRead,
    inputTokens,
    time: row.time,
  });
  if (state.cache.samples.length > CACHE_MAX_SAMPLES) {
    state.cache.samples.splice(0, state.cache.samples.length - CACHE_MAX_SAMPLES);
  }
}

/**
 * Return the token-weighted metric for the newest requests inside the cache
 * TTL, or null when no fresh positive input has been counted. A fresh window
 * with fewer than CACHE_MAX_SAMPLES samples still produces a metric.
 * @param {object} state
 * @param {number} [now]
 * @returns {{hitRate: number, readTokens: number, inputTokens: number, stale: boolean}|null}
 */
export function cacheMetricFromState(state, now = Date.now()) {
  ensureCacheState(state);
  const samples = validTimestamp(now)
    ? state.cache.samples.filter((sample) => now - sample.time < CACHE_TTL_MS)
    : [];
  const readTokens = samples.reduce((sum, sample) => sum + sample.readTokens, 0);
  const inputTokens = samples.reduce((sum, sample) => sum + sample.inputTokens, 0);
  if (
    !Number.isFinite(inputTokens) ||
    inputTokens <= 0 ||
    !Number.isFinite(readTokens) ||
    readTokens < 0
  ) {
    return null;
  }
  return {
    hitRate: readTokens / inputTokens,
    readTokens,
    inputTokens,
    stale: false,
  };
}
