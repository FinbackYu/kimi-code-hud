/**
 * Current-turn prompt-cache metrics reconstructed from the main agent's wire
 * journal. The caller owns persistence; this module only mutates the supplied
 * state and derives a render-safe metric.
 */

function emptyCacheTurn() {
  return {
    turnId: null,
    readTokens: 0,
    inputTokens: 0,
    complete: true,
  };
}

function ensureCacheState(state) {
  const cache = state.cacheTurn;
  const validTurnId =
    cache?.turnId === null ||
    typeof cache?.turnId === 'string' ||
    typeof cache?.turnId === 'number';
  const validCounters =
    validUsageNumber(cache?.readTokens) &&
    validUsageNumber(cache?.inputTokens) &&
    cache.readTokens <= cache.inputTokens;
  if (
    !cache ||
    typeof cache !== 'object' ||
    !validTurnId ||
    !validCounters ||
    typeof cache.complete !== 'boolean'
  ) {
    state.cacheTurn = emptyCacheTurn();
  }
  if (typeof state.cacheNeedsPrompt !== 'boolean') {
    state.cacheNeedsPrompt = false;
  }
}

/**
 * Reset the current-turn cache state.
 * @param {object} state mutated in place
 * @param {object} [opts]
 * @param {boolean} [opts.needsPrompt]
 */
export function resetCacheState(state, { needsPrompt = false } = {}) {
  state.cacheTurn = emptyCacheTurn();
  state.cacheNeedsPrompt = needsPrompt;
}

function validUsageNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Fold one wire row into the current-turn cache counters. Only turn.prompt
 * and context.append_loop_event/step.end are relevant; usage.record is
 * deliberately ignored because it duplicates the step.end usage.
 * @param {object} state mutated in place
 * @param {object} row parsed wire.jsonl line
 */
export function applyCacheWireRow(state, row) {
  ensureCacheState(state);

  if (row?.type === 'turn.prompt') {
    resetCacheState(state);
    return;
  }
  if (row?.type !== 'context.append_loop_event') return;
  const event = row.event;
  if (!event || event.type !== 'step.end' || state.cacheNeedsPrompt) return;

  const turnId =
    typeof event.turnId === 'string' || typeof event.turnId === 'number'
      ? event.turnId
      : null;
  if (
    state.cacheTurn.turnId !== null &&
    turnId !== null &&
    turnId !== state.cacheTurn.turnId
  ) {
    resetCacheState(state);
  }
  if (state.cacheTurn.turnId === null && turnId !== null) {
    state.cacheTurn.turnId = turnId;
  }

  const usage = event.usage;
  const fields = [
    usage?.inputOther,
    usage?.inputCacheRead,
    usage?.inputCacheCreation,
  ];
  if (!fields.every(validUsageNumber)) {
    state.cacheTurn.complete = false;
    return;
  }
  if (!state.cacheTurn.complete) return;

  state.cacheTurn.readTokens += usage.inputCacheRead;
  state.cacheTurn.inputTokens +=
    usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
}

/**
 * Return the render-safe current-turn cache metric, or null when the turn is
 * incomplete, still awaiting a prompt boundary, or has no input tokens.
 * @param {object} state
 * @returns {{hitRate: number, readTokens: number, inputTokens: number}|null}
 */
export function cacheMetricFromState(state) {
  ensureCacheState(state);
  const cache = state.cacheTurn;
  if (
    state.cacheNeedsPrompt ||
    cache.complete !== true ||
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
