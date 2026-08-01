import { resetFleetWindows } from './metrics-throughput.mjs';

/** Fold main-wire model/thinking/swarm metadata. */
export function applySessionMetaRow(state, row, agent = 'main') {
  if (agent !== 'main') return;
  if (row?.type === 'config.update') {
    const modelAlias = typeof row.modelAlias === 'string' && row.modelAlias
      ? row.modelAlias
      : null;
    if (modelAlias && modelAlias !== state.modelAlias) {
      const hasSamples = Object.values(state.agents || {}).some(
        (bucket) => bucket.samples.length > 0 || bucket.lastTtftMs !== null,
      );
      if (state.modelAlias || hasSamples) resetFleetWindows(state);
      state.modelAlias = modelAlias;
    }
    const level = typeof row.thinkingEffort === 'string'
      ? row.thinkingEffort
      : typeof row.thinkingLevel === 'string' ? row.thinkingLevel : null;
    if (level) state.thinkingLevel = level;
    return;
  }
  if (row?.type === 'swarm_mode.enter' || row?.type === 'swarm_mode.exit') {
    state.swarmMode = row.type === 'swarm_mode.enter';
  }
}
