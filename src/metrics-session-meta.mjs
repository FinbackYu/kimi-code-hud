import { resetFleetWindows } from './metrics-throughput.mjs';

/**
 * Adopt the main agent's model alias, discarding the fleet speed windows the
 * moment the model changes — speed readings are not comparable across models.
 * @param {object} state mutated in place
 * @param {unknown} modelAlias raw row value
 */
function adoptModelAlias(state, modelAlias) {
  const alias = typeof modelAlias === 'string' && modelAlias ? modelAlias : null;
  if (!alias || alias === state.modelAlias) return;
  const hasSamples = Object.values(state.agents || {}).some(
    (bucket) => bucket.samples.length > 0 || bucket.lastTtftMs !== null,
  );
  if (state.modelAlias || hasSamples) resetFleetWindows(state);
  state.modelAlias = alias;
}

/** Fold main-wire model/thinking/swarm metadata. */
export function applySessionMetaRow(state, row, agent = 'main') {
  if (agent !== 'main') return;
  if (row?.type === 'config.update' || row?.type === 'profile.bind') {
    // Newer hosts bind the session profile once at start as `profile.bind`
    // (model alias + thinking effort) instead of a `config.update` row; both
    // carry the same modelAlias / thinkingEffort / thinkingLevel fields.
    adoptModelAlias(state, row.modelAlias);
    const level = typeof row.thinkingEffort === 'string'
      ? row.thinkingEffort
      : typeof row.thinkingLevel === 'string' ? row.thinkingLevel : null;
    if (level) state.thinkingLevel = level;
    return;
  }
  if (row?.type === 'llm.request') {
    // Per-request ground truth: hosts stamp every request with the model
    // alias and thinking effort it actually ran with, so an in-session
    // switch that emits no config.update/profile.bind row (the host's own
    // footer can lag behind here) still surfaces on the next request.
    // Last row wins, matching the META-row semantics above.
    adoptModelAlias(state, row.modelAlias);
    if (typeof row.thinkingEffort === 'string' && row.thinkingEffort) {
      state.thinkingLevel = row.thinkingEffort;
    }
    return;
  }
  if (row?.type === 'swarm_mode.enter' || row?.type === 'swarm_mode.exit') {
    state.swarmMode = row.type === 'swarm_mode.enter';
  }
}
