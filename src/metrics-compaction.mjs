import { normAgent } from './metrics-agent.mjs';

/** Fold manual/between-turn full-compaction timing for the main agent. */
export function applyCompactionRow(state, row, agent = 'main') {
  if (agent !== 'main') return;
  if (!state.agents || typeof state.agents !== 'object') state.agents = {};
  const bucket = normAgent(state.agents.main);
  state.agents.main = bucket;
  const rowTime = Number.isFinite(row?.time) && row.time >= 0 ? row.time : null;
  if (rowTime === null) return;

  if (row?.type === 'full_compaction.begin') {
    const turnInFlight =
      bucket.lastTurnPromptAt !== null &&
      (bucket.lastTurnEndAt === null || bucket.lastTurnPromptAt > bucket.lastTurnEndAt);
    if (
      !turnInFlight &&
      (bucket.lastCompactionBeginAt === null || rowTime > bucket.lastCompactionBeginAt)
    ) {
      bucket.lastCompactionBeginAt = rowTime;
    }
    return;
  }
  const open =
    bucket.lastCompactionBeginAt !== null &&
    (bucket.lastCompactionEndAt === null ||
      bucket.lastCompactionBeginAt > bucket.lastCompactionEndAt);
  if (row?.type === 'full_compaction.cancel') {
    if (open) bucket.lastCompactionEndAt = rowTime;
    return;
  }
  if (
    row?.type === 'full_compaction.complete' &&
    open &&
    rowTime >= bucket.lastCompactionBeginAt
  ) {
    bucket.lastCompactionEndAt = rowTime;
    bucket.lastCompactionMs = rowTime - bucket.lastCompactionBeginAt;
  }
}
