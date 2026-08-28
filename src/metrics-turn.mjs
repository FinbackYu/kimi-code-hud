import { normAgent } from './metrics-agent.mjs';

// Prompt origins that count as user-initiated and therefore move the user
// clock anchoring the gen timer. Task-completion notifications (`task`) and
// goal-mode continuations (`system_trigger`) open their own main turns but
// must never re-anchor it — a tower run injects one notification turn per
// finished worker, and treating those as user prompts kept resetting the
// timer to minutes instead of the full cascade span.
const USER_PROMPT_ORIGINS = new Set(['user', 'skill_activation', 'plugin_command']);

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
    // Records predating the origin field were all user prompts.
    const originKind =
      row?.origin && typeof row.origin === 'object' ? row.origin.kind : undefined;
    if (
      (originKind === undefined || USER_PROMPT_ORIGINS.has(originKind)) &&
      (bucket.lastUserPromptAt === null || rowTime > bucket.lastUserPromptAt)
    ) {
      bucket.lastUserPromptAt = rowTime;
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
