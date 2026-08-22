/**
 * Goal badge state — reconstructs the host's goal lifecycle from the wire
 * journal. The host persists goal ops as top-level wire.jsonl lines
 * (`goal.create` / `goal.update` / `goal.clear` / `forked`), so an external
 * status line can rebuild the goal badge (the status-line payload carries
 * no goal field).
 *
 * Only the fields the badge needs are tracked: status, turns, and the
 * optional turn budget. The wire's wall-clock fields are ignored — the HUD
 * badge does not render the elapsed clock.
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
      turnBudget: row.budgetLimits?.turnBudget ?? null,
    };
  }
  if (type === 'goal.update') {
    if (goal === null) return goal;
    const next = { ...goal };
    if (typeof row.status === 'string') next.status = row.status;
    if (typeof row.turnsUsed === 'number') next.turnsUsed = row.turnsUsed;
    if (row.budgetLimits && typeof row.budgetLimits.turnBudget === 'number') {
      next.turnBudget = row.budgetLimits.turnBudget;
    }
    return next;
  }
  return goal;
}

/**
 * Badge parts for a live goal: `[goal 7 turns]` — or `3/10 turns` with a
 * turn budget. The status is carried by color in render.mjs (active blue,
 * blocked amber, paused muted), so the text is just the word plus
 * the turn count. Returns null for terminal/absent goals (the host clears
 * on complete).
 * @param {object|null} goal
 * @returns {{status: string, text: string}|null}
 */
export function formatGoalBadge(goal) {
  if (!goal) return null;
  const { status } = goal;
  if (status !== 'active' && status !== 'paused' && status !== 'blocked') return null;
  const turnsUsed = typeof goal.turnsUsed === 'number' ? goal.turnsUsed : 0;
  const turns =
    typeof goal.turnBudget === 'number'
      ? `${turnsUsed}/${goal.turnBudget} turns`
      : `${turnsUsed} ${turnsUsed === 1 ? 'turn' : 'turns'}`;
  const text = `[goal ${turns}]`;
  return { status, text };
}
