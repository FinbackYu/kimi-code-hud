import { normAgent } from './metrics-agent.mjs';

/**
 * Fold the user-turn clock without touching TPS samples. The prompt anchor is
 * main-only (the footer turn timer belongs to the user), but the turn-end
 * marker is kept per agent: a subagent's wire never carries `turn.ended`, so
 * its closing `end_turn` step.end is what lets the fleet summary drop it the
 * moment it finishes instead of waiting out the recency window.
 */
export function applyTurnRow(state, row, agent = 'main') {
  if (!state.agents || typeof state.agents !== 'object') state.agents = {};
  const bucket = normAgent(state.agents[agent]);
  state.agents[agent] = bucket;
  const rowTime = Number.isFinite(row?.time) && row.time >= 0 ? row.time : null;
  if (rowTime === null) return;
  if (agent === 'main' && row?.type === 'turn.prompt') {
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
