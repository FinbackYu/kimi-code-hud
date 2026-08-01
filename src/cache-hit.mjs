/**
 * Session-cumulative prompt-cache metrics reconstructed from the main agent's
 * wire journal. The caller owns persistence; this module only mutates the
 * supplied state and derives a render-safe metric.
 */

function emptyCache() {
  return {
    readTokens: 0,
    inputTokens: 0,
  };
}

function ensureCacheState(state) {
  const cache = state.cache;
  const validCounters =
    validUsageNumber(cache?.readTokens) &&
    validUsageNumber(cache?.inputTokens) &&
    cache.readTokens <= cache.inputTokens;
  if (!cache || typeof cache !== 'object' || !validCounters) {
    state.cache = emptyCache();
  }
}

/**
 * Reset the session cache counters (wire truncated/rotated, restore retry).
 * @param {object} state mutated in place
 */
export function resetCacheState(state) {
  state.cache = emptyCache();
}

function validUsageNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Fold one wire row into the session cache counters. step.end accumulates
 * cumulatively — the metric describes the whole session, not the current
 * turn. usage.record is deliberately ignored because it duplicates the
 * step.end usage. A step.end without complete usage fields is skipped
 * rather than poisoning the ratio.
 * @param {object} state mutated in place
 * @param {object} row parsed wire.jsonl line
 */
export function applyCacheWireRow(state, row) {
  ensureCacheState(state);

  if (row?.type !== 'context.append_loop_event') return;
  const event = row.event;
  if (!event || event.type !== 'step.end') return;

  const usage = event.usage;
  const fields = [
    usage?.inputOther,
    usage?.inputCacheRead,
    usage?.inputCacheCreation,
  ];
  if (!fields.every(validUsageNumber)) return;

  state.cache.readTokens += usage.inputCacheRead;
  state.cache.inputTokens +=
    usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
}

/**
 * Return the render-safe session cache metric, or null when nothing has been
 * counted yet. The ratio is session-cumulative, so between turns it is
 * already the latest complete value — no freshness flag is attached.
 * @param {object} state
 * @returns {{hitRate: number, readTokens: number, inputTokens: number}|null}
 */
export function cacheMetricFromState(state) {
  ensureCacheState(state);
  const cache = state.cache;
  if (
    !Number.isFinite(cache.inputTokens) ||
    cache.inputTokens <= 0 ||
    !Number.isFinite(cache.readTokens) ||
    cache.readTokens < 0
  ) {
    return null;
  }
  return {
    hitRate: cache.readTokens / cache.inputTokens,
    readTokens: cache.readTokens,
    inputTokens: cache.inputTokens,
  };
}
