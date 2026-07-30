/**
 * Goal badge state — reconstructs the host's goal lifecycle from the wire
 * journal. The host persists goal ops as top-level wire.jsonl lines
 * (`goal.create` / `goal.update` / `goal.clear` / `forked`), so an external
 * status line can rebuild the same `[goal ● active · 4m · 7 turns]` badge
 * the built-in footer shows (the status-line payload carries no goal field).
 *
 * Only the fields the badge needs are tracked: status, turns, the optional
 * turn budget, and the wall-clock anchors used for the live elapsed clock.
 */

/**
 * Fold one parsed wire.jsonl row into the goal state.
 * @param {object|null} goal current state (null = no live goal)
 * @param {object} row parsed wire line
 * @returns {object|null} next state (same reference when untouched)
 */
export function applyGoalOp(goal, row) {
  const type = row?.type;
  if (type === 'goal.clear' || type === 'forked') {
    return goal === null ? goal : null;
  }
  if (type === 'goal.create') {
    return {
      status: 'active',
      turnsUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt:
        typeof row.wallClockResumedAt === 'number'
          ? row.wallClockResumedAt
          : typeof row.time === 'number'
            ? row.time
            : null,
      turnBudget: row.budgetLimits?.turnBudget ?? null,
    };
  }
  if (type === 'goal.update') {
    if (goal === null) return goal;
    const next = { ...goal };
    if (typeof row.status === 'string') {
      next.status = row.status;
      if (row.status === 'active') {
        if (typeof row.wallClockResumedAt === 'number') {
          next.wallClockResumedAt = row.wallClockResumedAt;
        } else if (next.wallClockResumedAt === null && typeof row.time === 'number') {
          next.wallClockResumedAt = row.time;
        }
      } else {
        next.wallClockResumedAt = null;
      }
    }
    if (typeof row.turnsUsed === 'number') next.turnsUsed = row.turnsUsed;
    if (typeof row.wallClockMs === 'number') next.wallClockMs = row.wallClockMs;
    if (typeof row.wallClockResumedAt === 'number' && next.status === 'active') {
      next.wallClockResumedAt = row.wallClockResumedAt;
    }
    if (row.budgetLimits && typeof row.budgetLimits.turnBudget === 'number') {
      next.turnBudget = row.budgetLimits.turnBudget;
    }
    return next;
  }
  return goal;
}

/** Host's formatBadgeElapsed: <60s "Ns", <60m "Nm", else "HhMm". */
export function formatGoalElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/**
 * Elapsed wall-clock for the badge. An active goal keeps ticking between
 * wire updates: persisted wallClockMs plus the current resumed interval.
 * Paused/blocked goals show their checkpointed total.
 * @param {object} goal
 * @param {number} now epoch ms
 * @returns {number}
 */
export function goalElapsedMs(goal, now = Date.now()) {
  let ms = typeof goal.wallClockMs === 'number' ? goal.wallClockMs : 0;
  if (goal.status === 'active' && typeof goal.wallClockResumedAt === 'number') {
    ms += Math.max(0, now - goal.wallClockResumedAt);
  }
  return ms;
}

/**
 * Badge parts for a live goal, mirroring the host footer:
 * `[goal ● active · 4m · 7 turns]` — or `3/10 turns` with a turn budget.
 * Returns null for terminal/absent goals (the host clears on complete).
 * @param {object|null} goal
 * @param {number} [now]
 * @returns {{status: string, text: string}|null}
 */
export function formatGoalBadge(goal, now = Date.now()) {
  if (!goal) return null;
  const { status } = goal;
  if (status !== 'active' && status !== 'paused' && status !== 'blocked') return null;
  const turnsUsed = typeof goal.turnsUsed === 'number' ? goal.turnsUsed : 0;
  const turns =
    typeof goal.turnBudget === 'number'
      ? `${turnsUsed}/${goal.turnBudget} turns`
      : `${turnsUsed} ${turnsUsed === 1 ? 'turn' : 'turns'}`;
  const text = `[goal ● ${status} · ${formatGoalElapsed(goalElapsedMs(goal, now))} · ${turns}]`;
  return { status, text };
}
