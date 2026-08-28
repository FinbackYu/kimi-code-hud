import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getMetrics,
  processWireChunk,
} from '../src/metrics.mjs';
import { summarizeMetrics } from '../src/metrics-summary.mjs';
import { emptyAgent } from '../src/metrics-agent.mjs';
import {
  EVENT_TIME,
  FRESH_NOW,
  compactionBegin,
  compactionCancel,
  compactionComplete,
  llmRequest,
  makeMetricsState,
  makeSession as makeWireSession,
  stepEnd as wireStepEnd,
  turnEnded,
  turnPrompt,
} from './.helpers.mjs';

// Turn, generation and compaction timers: how user prompts anchor the clock, and how terminal rows settle the badges.

function stepEnd(options) {
  return wireStepEnd({
    turnId: '6',
    step: 11,
    inputOther: 952,
    inputCacheRead: 67840,
    inputCacheCreation: 0,
    ...options,
  });
}

function makeSession({ withPrefix = true, agents = ['main'] } = {}) {
  return makeWireSession({ prefix: withPrefix ? 'ses_' : '', agents });
}

const makeState = () => makeMetricsState();

test('getMetrics runs the turn timer from the prompt until end_turn or cancel', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(wirePath, turnPrompt() + '\n' + llmRequest() + '\n');
  let m = getMetrics(id, opts);
  // The timer anchors at the user's prompt, not the first request.
  assert.equal(m.turnStartedAt, EVENT_TIME);
  assert.equal(m.activeAgents, 1);

  // A mid-turn tool step keeps the timer running.
  fs.appendFileSync(
    wirePath,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1000, finishReason: 'tool_use' }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.equal(m.turnStartedAt, EVENT_TIME);

  // end_turn stops the timer.
  fs.appendFileSync(
    wirePath,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 2000 }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.equal(m.turnStartedAt, null);

  // A new prompt re-anchors; ESC (turn.cancel) stops it immediately.
  fs.appendFileSync(wirePath, turnPrompt('again', EVENT_TIME + 3000) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.turnStartedAt, EVENT_TIME + 3000);
  fs.appendFileSync(
    wirePath,
    JSON.stringify({ type: 'turn.cancel', time: EVENT_TIME + 4000 }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.equal(m.turnStartedAt, null);
});

test('getMetrics turn.ended stops failed and blocked turn timers', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    turnPrompt() + '\n' +
      llmRequest({ time: EVENT_TIME + 100 }) + '\n' +
      turnEnded({ reason: 'failed', time: EVENT_TIME + 1000 }) + '\n',
  );
  let m = getMetrics(id, opts);
  assert.equal(m.turnStartedAt, null);
  assert.equal(m.activeAgents, 0);

  fs.appendFileSync(
    wirePath,
    turnPrompt('again', EVENT_TIME + 2000) + '\n' +
      llmRequest({ time: EVENT_TIME + 2100 }) + '\n' +
      turnEnded({ reason: 'blocked', time: EVENT_TIME + 3000, turnId: 1 }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.equal(m.turnStartedAt, null);
  assert.equal(m.activeAgents, 0);
});

test('getMetrics never lets task/system prompts re-anchor the user clock (tower replay)', () => {
  // Replays the 2026-08-28 tower run's turn anatomy: the user's prompt opens
  // a turn, main ends it once the workers are dispatched (parked gap), then
  // every worker completion injects an origin=task turn.prompt that opens and
  // closes its own main turn. The gen timer must stay anchored at the user's
  // prompt throughout and settle into the full cascade span at the end.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-1'] });
  const mainWire = wires.main;
  const workerWire = wires['agent-1'];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = (now) => ({ sessionsRoot: root, stateDir, now });

  fs.writeFileSync(
    mainWire,
    turnPrompt('起 tower 执行', EVENT_TIME) + '\n' +
      llmRequest({ time: EVENT_TIME + 100 }) + '\n' +
      turnEnded({ time: EVENT_TIME + 10_000, turnId: 0 }) + '\n',
  );
  // A worker is mid-generation while main is parked between turns.
  fs.writeFileSync(workerWire, llmRequest({ time: EVENT_TIME + 20_000 }) + '\n');

  // Parked gap: the worker keeps the cascade live; the anchor stays at the
  // user's prompt instead of dropping to null (old behavior) until the next
  // notification.
  let m = getMetrics(id, opts(EVENT_TIME + 30_000));
  assert.equal(m.turnStartedAt, EVENT_TIME);
  assert.equal(m.genSettledMs, null);

  // The first worker completion injects an origin=task prompt and main wakes
  // to process it: the timer must NOT re-anchor at the notification.
  fs.appendFileSync(
    mainWire,
    turnPrompt('<notification id="task:agent-1:completed">', EVENT_TIME + 40_000, 'task') + '\n' +
      llmRequest({ time: EVENT_TIME + 40_100 }) + '\n',
  );
  m = getMetrics(id, opts(EVENT_TIME + 50_000));
  assert.equal(m.turnStartedAt, EVENT_TIME);
  assert.equal(m.genSettledMs, null);

  // The worker settles (closing end_turn) and the notification turn ends:
  // the cascade is over, the timer freezes at the full span since the user's
  // prompt instead of the span since the last notification.
  fs.appendFileSync(
    workerWire,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 50_000, finishReason: 'end_turn' }) + '\n',
  );
  fs.appendFileSync(mainWire, turnEnded({ time: EVENT_TIME + 55_000, turnId: 2 }) + '\n');
  m = getMetrics(id, opts(EVENT_TIME + 55_500));
  assert.equal(m.activeAgents, 0);
  assert.equal(m.turnStartedAt, null);
  assert.equal(m.genSettledMs, 55_000);
});

test('getMetrics freezes the settled gen total until the next user prompt', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    turnPrompt('quick question', EVENT_TIME) + '\n' +
      llmRequest({ time: EVENT_TIME + 100 }) + '\n' +
      turnEnded({ time: EVENT_TIME + 5000 }) + '\n',
  );
  let m = getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME + 30_000 });
  assert.equal(m.turnStartedAt, null);
  assert.equal(m.genSettledMs, 5000);

  // A task-origin notification alone neither revives nor re-anchors the
  // clock: its open turn anchors at the last USER prompt, and once it ends
  // the settled span simply grows to cover it.
  fs.appendFileSync(
    wirePath,
    turnPrompt('<notification id="task:t:completed">', EVENT_TIME + 40_000, 'task') + '\n' +
      turnEnded({ time: EVENT_TIME + 45_000, turnId: 1 }) + '\n',
  );
  m = getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME + 46_000 });
  assert.equal(m.genSettledMs, 45_000);

  // The next user prompt re-anchors and hands the slot back to the live timer.
  fs.appendFileSync(wirePath, turnPrompt('next', EVENT_TIME + 50_000) + '\n');
  m = getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME + 60_000 });
  assert.equal(m.turnStartedAt, EVENT_TIME + 50_000);
  assert.equal(m.genSettledMs, null);
});

test('a compaction closed after the final turn end takes the slot over genSettledMs', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    turnPrompt('work', EVENT_TIME) + '\n' +
      turnEnded({ time: EVENT_TIME + 10_000 }) + '\n' +
      compactionBegin({ time: EVENT_TIME + 20_000 }) + '\n' +
      compactionComplete({ time: EVENT_TIME + 50_000 }) + '\n',
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.compactionMs, 30_000);
  assert.equal(m.genSettledMs, null);
});

test('applyTurnRow moves the user clock only for user-initiated prompt origins', () => {
  const state = makeState();
  processWireChunk(state, turnPrompt('typed', EVENT_TIME) + '\n');
  assert.equal(state.agents.main.lastUserPromptAt, EVENT_TIME);

  // Task notifications and goal continuations open main turns (the raw
  // prompt marker follows them) but never move the user clock.
  processWireChunk(state, turnPrompt('<notification>', EVENT_TIME + 1000, 'task') + '\n');
  assert.equal(state.agents.main.lastTurnPromptAt, EVENT_TIME + 1000);
  assert.equal(state.agents.main.lastUserPromptAt, EVENT_TIME);
  processWireChunk(state, turnPrompt('continue the goal', EVENT_TIME + 2000, 'system_trigger') + '\n');
  assert.equal(state.agents.main.lastTurnPromptAt, EVENT_TIME + 2000);
  assert.equal(state.agents.main.lastUserPromptAt, EVENT_TIME);

  // Skill activations and plugin commands are user-initiated.
  processWireChunk(state, turnPrompt('skill body', EVENT_TIME + 3000, 'skill_activation') + '\n');
  assert.equal(state.agents.main.lastUserPromptAt, EVENT_TIME + 3000);
  processWireChunk(state, turnPrompt('plugin cmd', EVENT_TIME + 4000, 'plugin_command') + '\n');
  assert.equal(state.agents.main.lastUserPromptAt, EVENT_TIME + 4000);

  // Pre-origin records (no origin field) were all user prompts.
  processWireChunk(state, turnPrompt('legacy', EVENT_TIME + 5000, null) + '\n');
  assert.equal(state.agents.main.lastUserPromptAt, EVENT_TIME + 5000);
});

test('summarizeMetrics keeps the legacy reading when no user anchor exists yet', () => {
  // State persisted by an older build has no lastUserPromptAt: the timer
  // keeps the pre-anchor behavior (latest prompt of any origin while open,
  // no settled total) until the next user-initiated prompt lands.
  const state = makeState();
  state.agents.main = {
    ...emptyAgent(),
    lastTurnPromptAt: EVENT_TIME,
    lastTurnEndAt: null,
    lastUserPromptAt: null,
  };
  let m = summarizeMetrics(state, { now: FRESH_NOW }).metrics;
  assert.equal(m.turnStartedAt, EVENT_TIME);
  assert.equal(m.genSettledMs, null);

  state.agents.main.lastTurnEndAt = EVENT_TIME + 10_000;
  m = summarizeMetrics(state, { now: FRESH_NOW }).metrics;
  assert.equal(m.turnStartedAt, null);
  assert.equal(m.genSettledMs, null);
});

test('processWireChunk tracks the compaction timer (main agent only)', () => {
  const state = makeState();
  processWireChunk(
    state,
    compactionBegin({ time: EVENT_TIME }) + '\n' +
      compactionComplete({ time: EVENT_TIME + 3000 }) + '\n',
  );
  const bucket = state.agents.main;
  assert.equal(bucket.lastCompactionBeginAt, EVENT_TIME);
  assert.equal(bucket.lastCompactionEndAt, EVENT_TIME + 3000);
  assert.equal(bucket.lastCompactionMs, 3000);

  // Subagent compaction rows never move the user-facing timer.
  processWireChunk(state, compactionBegin({ time: EVENT_TIME + 10_000 }) + '\n', 'agent-0');
  assert.equal(state.agents['agent-0'].lastCompactionBeginAt, null);
  assert.equal(state.agents.main.lastCompactionBeginAt, EVENT_TIME);
});

test('compaction cancel closes the live timer without a duration', () => {
  const state = makeState();
  processWireChunk(
    state,
    compactionBegin({ time: EVENT_TIME }) + '\n' +
      compactionCancel({ time: EVENT_TIME + 2000 }) + '\n',
  );
  const bucket = state.agents.main;
  assert.equal(bucket.lastCompactionBeginAt, EVENT_TIME);
  assert.equal(bucket.lastCompactionEndAt, EVENT_TIME + 2000);
  assert.equal(bucket.lastCompactionMs, null);
});

test('mid-turn (auto) compaction is never tracked by the compaction timer', () => {
  const state = makeState();
  processWireChunk(
    state,
    turnPrompt('work', EVENT_TIME) + '\n' +
      llmRequest({ time: EVENT_TIME + 1000 }) + '\n' +
      compactionBegin({ source: 'auto', time: EVENT_TIME + 2000 }) + '\n' +
      compactionComplete({ time: EVENT_TIME + 32_000 }) + '\n' +
      turnEnded({ time: EVENT_TIME + 40_000 }) + '\n',
  );
  const bucket = state.agents.main;
  assert.equal(bucket.lastCompactionBeginAt, null);
  assert.equal(bucket.lastCompactionEndAt, null);
  assert.equal(bucket.lastCompactionMs, null);
  // The completion still closes the in-flight generation as before (the
  // later turn.ended then takes over as the final terminal record).
  assert.equal(bucket.lastStepEndAt, EVENT_TIME + 40_000);
});

test('a compaction after the turn ended is tracked normally', () => {
  const state = makeState();
  processWireChunk(
    state,
    turnPrompt('work', EVENT_TIME) + '\n' +
      turnEnded({ time: EVENT_TIME + 10_000 }) + '\n' +
      compactionBegin({ time: EVENT_TIME + 20_000 }) + '\n' +
      compactionComplete({ time: EVENT_TIME + 50_000 }) + '\n',
  );
  const bucket = state.agents.main;
  assert.equal(bucket.lastCompactionBeginAt, EVENT_TIME + 20_000);
  assert.equal(bucket.lastCompactionEndAt, EVENT_TIME + 50_000);
  assert.equal(bucket.lastCompactionMs, 30_000);
});

test('getMetrics anchors a live compaction timer at full_compaction.begin', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(wirePath, compactionBegin({ time: EVENT_TIME }) + '\n');
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME + 5000 });
  assert.equal(m.compactingSince, EVENT_TIME);
  assert.equal(m.compactionMs, null);
});

test('getMetrics keeps the finished compaction duration until the next prompt', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    compactionBegin({ time: EVENT_TIME }) + '\n' +
      compactionComplete({ time: EVENT_TIME + 30_000 }) + '\n',
  );
  let m = getMetrics(id, opts);
  assert.equal(m.compactingSince, null);
  assert.equal(m.compactionMs, 30_000);
  // A new prompt takes over the slot; the stale duration drops out.
  fs.appendFileSync(wirePath, turnPrompt('next', EVENT_TIME + 40_000) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.compactionMs, null);
  assert.equal(m.turnStartedAt, EVENT_TIME + 40_000);
});

test('getMetrics hides an auto compaction that ran inside a turn', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    turnPrompt('work', EVENT_TIME) + '\n' +
      compactionBegin({ source: 'auto', time: EVENT_TIME + 1000 }) + '\n' +
      compactionComplete({ time: EVENT_TIME + 31_000 }) + '\n' +
      turnEnded({ time: EVENT_TIME + 40_000 }) + '\n',
  );
  // The turn is over, yet neither a live timer nor a duration shows up.
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.turnStartedAt, null);
  assert.equal(m.compactingSince, null);
  assert.equal(m.compactionMs, null);
});

test('getMetrics drops a compaction begin whose close record was lost', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(wirePath, compactionBegin({ time: EVENT_TIME }) + '\n');
  const m = getMetrics(id, {
    sessionsRoot: root, stateDir, now: EVENT_TIME + 11 * 60_000,
  });
  assert.equal(m.compactingSince, null);
  assert.equal(m.compactionMs, null);
});

test('getMetrics v8 backfill recovers an in-flight compaction', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(wirePath, compactionBegin({ time: EVENT_TIME }) + '\n');
  // Pre-v8 state: offset already past the begin row, never scanned for it.
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({
      v: 6,
      agents: {
        main: {
          offset: size, fileId: null, samples: [], lastTtftMs: null,
          lastSampleAt: null, lastRequestAt: null, lastStepEndAt: null,
          lastTurnPromptAt: null, lastTurnEndAt: null,
        },
      },
      backfillScanV: 7,
    }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME + 5000 });
  assert.equal(m.compactingSince, EVENT_TIME);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.backfillScanV, 10);
});
