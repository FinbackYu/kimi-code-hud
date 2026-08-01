import { normAgent } from './metrics-agent.mjs';

/** Fold the main user-turn clock without touching TPS samples. */
export function applyTurnRow(state, row, agent = 'main') {
  if (agent !== 'main') return;
  if (!state.agents || typeof state.agents !== 'object') state.agents = {};
  const bucket = normAgent(state.agents.main);
  state.agents.main = bucket;
  const rowTime = Number.isFinite(row?.time) && row.time >= 0 ? row.time : null;
  if (rowTime === null) return;
  if (row?.type === 'turn.prompt') {
    if (bucket.lastTurnPromptAt === null || rowTime > bucket.lastTurnPromptAt) {
      bucket.lastTurnPromptAt = rowTime;
    }
    return;
  }
  if (
    row?.type === 'turn.ended' ||
    (row?.type === 'turn.cancel' && row.target !== 'queued')
  ) {
    if (bucket.lastTurnEndAt === null || rowTime > bucket.lastTurnEndAt) {
      bucket.lastTurnEndAt = rowTime;
    }
    return;
  }
  const event = row?.event;
  if (
    row?.type === 'context.append_loop_event' &&
    event?.type === 'step.end' &&
    event.finishReason === 'end_turn' &&
    (bucket.lastTurnEndAt === null || rowTime > bucket.lastTurnEndAt)
  ) {
    bucket.lastTurnEndAt = rowTime;
  }
}
