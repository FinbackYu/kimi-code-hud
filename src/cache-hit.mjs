/**
 * Session-cumulative prompt-cache metrics reconstructed from the main agent's
 * wire journal. The caller owns persistence; this module only mutates the
 * supplied state and derives a render-safe metric.
 */

function emptyCache() {
  return {
    readTokens: 0,
    inputTokens: 0,
    // True between a turn.prompt and that turn's first fully-counted
    // step.end: the cumulative ratio then lags the live session and renders
    // dimmed instead of disappearing (which used to jump the line width).
    awaitsUsage: false,
  };
}

function ensureCacheState(state) {
  const cache = state.cache;
  const validCounters =
    validUsageNumber(cache?.readTokens) &&
    validUsageNumber(cache?.inputTokens) &&
    cache.readTokens <= cache.inputTokens;
  if (!cache || typeof cache !== 'object' || !validCounters || typeof cache.awaitsUsage !== 'boolean') {
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
 * Fold one wire row into the session cache counters. turn.prompt only marks
 * the ratio as awaiting fresh usage; step.end accumulates cumulatively — the
 * metric describes the whole session, not the current turn. usage.record is
 * deliberately ignored because it duplicates the step.end usage. A step.end
 * without complete usage fields is skipped rather than poisoning the ratio.
 * @param {object} state mutated in place
 * @param {object} row parsed wire.jsonl line
 */
export function applyCacheWireRow(state, row) {
  ensureCacheState(state);

  if (row?.type === 'turn.prompt') {
    state.cache.awaitsUsage = true;
    return;
  }
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
  state.cache.awaitsUsage = false;
}

/**
 * Return the render-safe session cache metric, or null when nothing has been
 * counted yet. `stale` marks a turn that has prompted but not yet contributed
 * usage — the ratio shown is then one step behind the live session.
 * @param {object} state
 * @returns {{hitRate: number, readTokens: number, inputTokens: number, stale: boolean}|null}
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
    stale: cache.awaitsUsage,
  };
}
