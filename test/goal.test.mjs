import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyGoalOp,
  formatGoalBadge,
  formatGoalElapsed,
  goalElapsedMs,
} from '../src/goal.mjs';
import { getMetrics } from '../src/metrics.mjs';

function makeSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-ses-'));
  const id = 'goal123';
  const dir = path.join(root, 'wd_1', `session_${id}`, 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const wirePath = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wirePath, '');
  return { root, id, wirePath };
}

test('applyGoalOp lifecycle: create → update → clear', () => {
  let goal = null;
  goal = applyGoalOp(goal, {
    type: 'goal.create',
    goalId: 'g1',
    objective: 'ship it',
    wallClockResumedAt: 1000,
    time: 1000,
  });
  assert.equal(goal.status, 'active');
  assert.equal(goal.turnsUsed, 0);
  assert.equal(goal.wallClockResumedAt, 1000);

  goal = applyGoalOp(goal, { type: 'goal.update', turnsUsed: 7, time: 2000 });
  assert.equal(goal.turnsUsed, 7);
  assert.equal(goal.status, 'active');

  goal = applyGoalOp(goal, {
    type: 'goal.update',
    status: 'paused',
    wallClockMs: 61000,
    time: 3000,
  });
  assert.equal(goal.status, 'paused');
  assert.equal(goal.wallClockMs, 61000);
  assert.equal(goal.wallClockResumedAt, null); // clock anchor cleared off-active

  goal = applyGoalOp(goal, { type: 'goal.clear' });
  assert.equal(goal, null);
  // Idempotent when already null.
  assert.equal(applyGoalOp(null, { type: 'goal.clear' }), null);
  assert.equal(applyGoalOp(null, { type: 'goal.update', turnsUsed: 3 }), null);
});

test('applyGoalOp: forked clears; create falls back to row.time anchor', () => {
  let goal = applyGoalOp(null, { type: 'goal.create', goalId: 'g1', time: 5000 });
  assert.equal(goal.wallClockResumedAt, 5000);
  goal = applyGoalOp(goal, { type: 'forked' });
  assert.equal(goal, null);
});

test('applyGoalOp picks up the turn budget', () => {
  let goal = applyGoalOp(null, { type: 'goal.create', goalId: 'g1', time: 1 });
  assert.equal(goal.turnBudget, null);
  goal = applyGoalOp(goal, { type: 'goal.update', budgetLimits: { turnBudget: 10 } });
  assert.equal(goal.turnBudget, 10);
});

test('formatGoalElapsed mirrors the host badge clock', () => {
  assert.equal(formatGoalElapsed(42_000), '42s');
  assert.equal(formatGoalElapsed(4 * 60_000), '4m');
  assert.equal(formatGoalElapsed(3 * 3_600_000 + 38 * 60_000), '3h38m');
});

test('goalElapsedMs: active keeps ticking, paused is frozen', () => {
  const active = { status: 'active', wallClockMs: 60_000, wallClockResumedAt: 10_000 };
  assert.equal(goalElapsedMs(active, 40_000), 90_000);
  const paused = { status: 'paused', wallClockMs: 60_000, wallClockResumedAt: null };
  assert.equal(goalElapsedMs(paused, 40_000), 60_000);
});

test('formatGoalBadge matches the host format', () => {
  const goal = { status: 'active', turnsUsed: 7, wallClockMs: 0, wallClockResumedAt: 0 };
  const badge = formatGoalBadge(goal, 4 * 60_000);
  assert.equal(badge.status, 'active');
  assert.equal(badge.text, '[goal ● active · 4m · 7 turns]');

  assert.equal(
    formatGoalBadge({ status: 'paused', turnsUsed: 1, wallClockMs: 30_000 }, 0).text,
    '[goal ● paused · 30s · 1 turn]',
  );
  assert.equal(
    formatGoalBadge(
      { status: 'blocked', turnsUsed: 3, turnBudget: 10, wallClockMs: 0 },
      0,
    ).text,
    '[goal ● blocked · 0s · 3/10 turns]',
  );
  // Terminal/absent goals render nothing (the host clears on complete).
  assert.equal(formatGoalBadge({ status: 'complete', turnsUsed: 9, wallClockMs: 0 }), null);
  assert.equal(formatGoalBadge(null), null);
});

test('getMetrics rebuilds goal state from the wire journal', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    '{"type":"goal.create","goalId":"g1","objective":"test","wallClockResumedAt":1785400000000,"time":1785400000000}\n' +
      '{"type":"goal.update","turnsUsed":3,"time":1785400060000}\n',
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir });
  assert.equal(m.goal.status, 'active');
  assert.equal(m.goal.turnsUsed, 3);

  // Incremental path: append a pause, re-run.
  fs.appendFileSync(
    wirePath,
    '{"type":"goal.update","status":"paused","wallClockMs":60000,"time":1785400061000}\n',
  );
  const m2 = getMetrics(id, { sessionsRoot: root, stateDir });
  assert.equal(m2.goal.status, 'paused');
  assert.equal(m2.goal.turnsUsed, 3);

  // Clear removes the badge state.
  fs.appendFileSync(wirePath, '{"type":"goal.clear","time":1785400062000}\n');
  const m3 = getMetrics(id, { sessionsRoot: root, stateDir });
  assert.equal(m3.goal, null);
});

test('getMetrics current backfill picks up goal ops from before the offset', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    '{"type":"goal.create","goalId":"g1","wallClockResumedAt":1000,"time":1000}\n' +
      '{"type":"goal.update","turnsUsed":5,"time":2000}\n',
  );
  // v2 state: offset already past the goal ops, goal never captured.
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({ offset: size, samples: [], lastTtftMs: null, thinkingLevel: null, thinkingScanV: 2 }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir });
  assert.equal(m.goal.turnsUsed, 5);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.backfillScanV, 9);
  assert.equal(state.thinkingScanV, undefined); // legacy marker dropped
});
