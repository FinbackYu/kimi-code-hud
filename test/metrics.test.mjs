import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { median, processWireChunk, getMetrics, findWirePath, findSessionDir } from '../src/metrics.mjs';

const NOW = Date.now();

function stepEnd({ output, streamMs, ttftMs, time = NOW }) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      turnId: '6',
      step: 11,
      usage: { inputOther: 952, output, inputCacheRead: 67840, inputCacheCreation: 0 },
      finishReason: 'end_turn',
      llmFirstTokenLatencyMs: ttftMs,
      llmStreamDurationMs: streamMs,
    },
    time,
  });
}

function goalUpdate(fields, time = NOW) {
  return JSON.stringify({ type: 'goal.update', ...fields, time });
}

function makeSession({ withPrefix = true, agents = ['main'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-ses-'));
  const id = 'abc123';
  const sessionDir = path.join(root, 'wd_1', withPrefix ? `ses_${id}` : id);
  const wires = {};
  for (const agent of agents) {
    const dir = path.join(sessionDir, 'agents', agent);
    fs.mkdirSync(dir, { recursive: true });
    const wirePath = path.join(dir, 'wire.jsonl');
    fs.writeFileSync(wirePath, '');
    wires[agent] = wirePath;
  }
  return { root, id, sessionDir, wires, wirePath: wires.main };
}

function makeState() {
  return {
    v: 4,
    agents: {},
    thinkingLevel: null,
    goal: null,
  };
}

test('median of odd and even samples', () => {
  assert.equal(median([10]), 10);
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([40, 10, 30, 20]), 25);
  assert.equal(median([]), null);
});

test('processWireChunk computes TPS with per-agent timestamped samples', () => {
  const state = makeState();
  const lines = [
    '{"type":"other"}',
    'not json',
    stepEnd({ output: 112, streamMs: 2768, ttftMs: 2155 }),
    stepEnd({ output: 0, streamMs: 1000, ttftMs: 300 }),   // skipped: no output
    stepEnd({ output: 100, streamMs: 10, ttftMs: 400 }),   // skipped: too fast
    stepEnd({ output: 50, streamMs: 1000, ttftMs: 500 }),
  ].join('\n') + '\n';
  processWireChunk(state, lines, 'main');
  const bucket = state.agents.main;
  assert.equal(bucket.samples.length, 2);
  assert.ok(Math.abs(bucket.samples[0].v - 112 / 2.768) < 1e-9);
  assert.equal(bucket.samples[1].v, 50);
  assert.equal(bucket.samples[0].t, NOW);
  assert.equal(bucket.lastTtftMs, 500);
  assert.equal(bucket.lastSampleAt, NOW);
  // buckets are per agent
  processWireChunk(state, stepEnd({ output: 200, streamMs: 1000, ttftMs: 100 }) + '\n', 'agent-0');
  assert.equal(state.agents.main.samples.length, 2);
  assert.equal(state.agents['agent-0'].samples.length, 1);
});

test('processWireChunk tracks latest thinkingLevel from config.update', () => {
  const state = makeState();
  const lines = [
    '{"type":"config.update","thinkingLevel":"on","time":1}',
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }),
    '{"type":"config.update","modelAlias":"kimi-code/k3","time":2}',  // no level: keep previous
    '{"type":"config.update","thinkingLevel":"high","time":3}',
  ].join('\n') + '\n';
  processWireChunk(state, lines, 'main');
  assert.equal(state.thinkingLevel, 'high');
  assert.equal(state.agents.main.samples.length, 1); // step.end still processed
});

test('processWireChunk accepts the newer thinkingEffort key', () => {
  const state = makeState();
  const lines = [
    '{"type":"config.update","modelAlias":"kimi-code/k3-256k","thinkingEffort":"low","time":1}',
    '{"type":"config.update","thinkingEffort":"max","time":2}',
  ].join('\n') + '\n';
  processWireChunk(state, lines, 'main');
  assert.equal(state.thinkingLevel, 'max');
});

test('processWireChunk ignores thinking/goal events from subagent wires', () => {
  const state = makeState();
  const lines = [
    '{"type":"config.update","thinkingEffort":"max","time":1}',
    goalUpdate({ status: 'active', wallClockMs: 1000 }),
  ].join('\n') + '\n';
  processWireChunk(state, lines, 'agent-0');
  assert.equal(state.thinkingLevel, null);
  assert.equal(state.goal, null);
});

test('processWireChunk reconstructs goal state from goal events', () => {
  const state = makeState();
  const t0 = NOW - 60_000;
  const lines = [
    JSON.stringify({ type: 'goal.create', goalId: 'g1', objective: 'do it', time: t0 }),
    goalUpdate({ status: 'active', wallClockMs: 1000, actor: 'user' }, t0 + 1000),
    goalUpdate({ turnsUsed: 3 }, t0 + 2000),
    goalUpdate({ tokensUsed: 12345 }, t0 + 3000),
  ].join('\n') + '\n';
  processWireChunk(state, lines, 'main');
  assert.equal(state.goal.status, 'active');
  assert.equal(state.goal.wallClockMs, 1000);
  assert.equal(state.goal.turnsUsed, 3);
  assert.equal(state.goal.tokensUsed, 12345);
  assert.equal(state.goal.at, t0 + 1000);

  // A new goal resets the counters of the previous one.
  processWireChunk(
    state,
    JSON.stringify({ type: 'goal.create', goalId: 'g2', objective: 'next', time: t0 + 4000 }) + '\n',
    'main',
  );
  assert.equal(state.goal.turnsUsed, null);
  assert.equal(state.goal.tokensUsed, null);
  assert.equal(state.goal.status, null);

  // goal.clear drops the badge entirely.
  processWireChunk(state, JSON.stringify({ type: 'goal.clear', time: t0 + 5000 }) + '\n', 'main');
  assert.equal(state.goal, null);
});

test('findWirePath matches ses_ prefixed and bare dirs', () => {
  const a = makeSession({ withPrefix: true });
  assert.equal(findWirePath(a.id, a.root), a.wirePath);
  const b = makeSession({ withPrefix: false });
  assert.equal(findWirePath(b.id, b.root), b.wirePath);
  assert.equal(findWirePath('missing', a.root), null);
  assert.equal(findWirePath('ses_' + a.id, a.root), a.wirePath);
});

test('findWirePath matches session_ prefixed dirs (newer hosts)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-ses-'));
  const id = 'def456';
  const dir = path.join(root, 'wd_1', `session_${id}`, 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const wirePath = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wirePath, '');
  assert.equal(findWirePath(id, root), wirePath);
  assert.equal(findWirePath(`session_${id}`, root), wirePath);
  assert.equal(findSessionDir(id, root), path.join(root, 'wd_1', `session_${id}`));
});

test('getMetrics reads incrementally and survives truncation', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };

  fs.writeFileSync(wirePath, stepEnd({ output: 100, streamMs: 1000, ttftMs: 1200 }) + '\n');
  let m = getMetrics(id, opts);
  assert.equal(m.tps, 100);
  assert.equal(m.ttftMs, 1200);

  // append: only new bytes are parsed
  fs.appendFileSync(wirePath, stepEnd({ output: 300, streamMs: 1000, ttftMs: 800 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.tps, 200); // median(100, 300)
  assert.equal(m.ttftMs, 800);

  // incomplete trailing line is held for next run
  fs.appendFileSync(wirePath, stepEnd({ output: 999, streamMs: 1000 }).slice(0, 20));
  m = getMetrics(id, opts);
  assert.equal(m.tps, 200);

  // truncation resets the offset
  fs.writeFileSync(wirePath, stepEnd({ output: 60, streamMs: 1000, ttftMs: 100 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.tps, 60);
  assert.equal(m.ttftMs, 100);
  assert.equal(m.samples, undefined); // result only exposes tps/ttftMs/thinkingLevel/goal
});

test('getMetrics discards stale samples when a rotated file grows past the old offset', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };

  fs.writeFileSync(
    wirePath,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 1200 }) + '\n' +
      stepEnd({ output: 300, streamMs: 1000, ttftMs: 800 }) + '\n',
  );
  assert.equal(getMetrics(id, opts).tps, 200);

  const replacement = `${wirePath}.next`;
  fs.writeFileSync(
    replacement,
    stepEnd({ output: 600, streamMs: 1000, ttftMs: 700 }) + '\n' +
      stepEnd({ output: 700, streamMs: 1000, ttftMs: 600 }) + '\n' +
      stepEnd({ output: 800, streamMs: 1000, ttftMs: 500 }) + '\n',
  );
  fs.renameSync(replacement, wirePath);

  const m = getMetrics(id, opts);
  assert.equal(m.tps, 700);
  assert.equal(m.ttftMs, 500);
});

test('getMetrics aggregates active subagents: fleet total + per-agent average', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };

  fs.writeFileSync(wires.main, stepEnd({ output: 100, streamMs: 1000, ttftMs: 900 }) + '\n');
  fs.writeFileSync(wires['agent-0'], stepEnd({ output: 300, streamMs: 1000, ttftMs: 400 }) + '\n');
  fs.writeFileSync(wires['agent-1'], '{"type":"metadata","protocol_version":"1.4"}\n');

  const m = getMetrics(id, opts);
  assert.equal(m.tps, 200);        // average: median(100, 300)
  assert.equal(m.tpsTotal, 400);   // fleet total
  assert.equal(m.activeAgents, 2);
  assert.equal(m.ttftMs, 650);     // median across active agents: median(900, 400)

  // A subagent appearing later is picked up incrementally.
  fs.appendFileSync(wires['agent-1'], stepEnd({ output: 500, streamMs: 1000, ttftMs: 100 }) + '\n');
  const m2 = getMetrics(id, opts);
  assert.equal(m2.tps, 300);       // median(100, 300, 500)
  assert.equal(m2.tpsTotal, 900);
  assert.equal(m2.activeAgents, 3);
  assert.equal(m2.ttftMs, 400);    // median(900, 400, 100)
});

test('getMetrics reports a single speed when only one agent is active', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };
  // agent-0's only sample is 5 minutes old: fresh enough for the window,
  // but outside the 2min active window.
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 700, streamMs: 1000, ttftMs: 400, time: NOW - 5 * 60_000 }) + '\n',
  );
  fs.writeFileSync(wires.main, stepEnd({ output: 100, streamMs: 1000, ttftMs: 900 }) + '\n');
  const m = getMetrics(id, opts);
  assert.equal(m.tps, 100);        // only main is active
  assert.equal(m.tpsTotal, null);  // no fleet display
  assert.equal(m.activeAgents, 1);
  assert.equal(m.ttftMs, 900);     // idle agent's TTFT excluded
});

test('getMetrics expires samples older than the freshness window (resume/idle)', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };
  const old = NOW - 11 * 60 * 1000; // beyond the 10min window

  fs.writeFileSync(
    wirePath,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500, time: old }) + '\n',
  );
  let m = getMetrics(id, opts);
  assert.equal(m.tps, null);    // pre-resume sample expired
  assert.equal(m.ttftMs, null);

  fs.appendFileSync(wirePath, stepEnd({ output: 80, streamMs: 1000, ttftMs: 200 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.tps, 80);      // only the fresh sample counts
  assert.equal(m.ttftMs, 200);
});

test('getMetrics keeps the freshest TTFT across agents regardless of scan order', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };
  // Subagent's sample is older than main's, but agent-0 is scanned after main.
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 400, time: NOW - 5 * 60_000 }) + '\n',
  );
  fs.writeFileSync(wires.main, stepEnd({ output: 100, streamMs: 1000, ttftMs: 900 }) + '\n');
  const m = getMetrics(id, opts);
  assert.equal(m.ttftMs, 900); // fresher main sample wins
});

test('getMetrics surfaces goal state reconstructed from wire events', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };

  fs.writeFileSync(
    wirePath,
    JSON.stringify({ type: 'goal.create', goalId: 'g1', objective: 'x', time: NOW - 5000 }) + '\n' +
      goalUpdate({ status: 'active', wallClockMs: 4000 }, NOW - 4000) + '\n' +
      goalUpdate({ turnsUsed: 7 }, NOW - 3000) + '\n',
  );
  let m = getMetrics(id, opts);
  assert.deepEqual(m.goal, {
    status: 'active',
    objective: 'x',
    wallClockMs: 4000,
    turnsUsed: 7,
    tokensUsed: null,
    at: NOW - 4000,
  });

  fs.appendFileSync(wirePath, goalUpdate({ status: 'complete', wallClockMs: 9000, actor: 'model' }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.goal.status, 'complete');

  fs.appendFileSync(wirePath, JSON.stringify({ type: 'goal.clear', time: NOW }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.goal, null);
});

test('getMetrics migrates legacy v2 state and backfills goal', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    JSON.stringify({ type: 'goal.create', goalId: 'g1', objective: 'legacy', time: NOW - 9000 }) + '\n' +
      goalUpdate({ status: 'active', wallClockMs: 8000 }, NOW - 8000) + '\n' +
      '{"type":"config.update","thinkingLevel":"high","time":1}\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }) + '\n',
  );
  // Legacy state: offset already past every event, untimestamped samples.
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({ offset: size, samples: [100], lastTtftMs: 500, thinkingScanV: 2 }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir });
  assert.equal(m.goal.status, 'active');       // goal backfilled despite past offset
  assert.equal(m.goal.objective, 'legacy');
  assert.equal(m.tps, null);                   // untimestamped legacy samples expire
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.v, 4);
  assert.equal(state.agents.main.offset, size); // legacy offset preserved as main's
});

test('getMetrics backfills thinkingLevel once for pre-existing sessions', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    '{"type":"config.update","thinkingLevel":"high","time":1}\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }) + '\n',
  );
  // Simulate a state file whose offset already passed the config.update.
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({ offset: size, samples: [100], lastTtftMs: 500 }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir });
  assert.equal(m.thinkingLevel, 'high');
  // Second run must not rescan (versioned scan marker persisted).
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.thinkingScanV, 2);
});

test('getMetrics v2 backfill re-scans v1 states and picks up thinkingEffort', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    '{"type":"config.update","modelAlias":"kimi-code/k3-256k","thinkingEffort":"low","time":1}\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }) + '\n' +
      '{"type":"config.update","thinkingEffort":"max","time":2}\n',
  );
  // v1 state: scan marked done, level never captured, offset past the events.
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({ offset: size, samples: [100], lastTtftMs: 500, thinkingLevel: null, thinkingScanDone: true }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir });
  assert.equal(m.thinkingLevel, 'max'); // latest config.update wins
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.thinkingScanV, 2);
  assert.equal(state.thinkingScanDone, undefined); // legacy marker dropped
});

test('getMetrics flags in-flight generation and ignores compaction requests', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };

  const req = (kind, time) => JSON.stringify({ type: 'llm.request', kind, time });

  // A loop request with no step.end after it => generating.
  fs.writeFileSync(
    wirePath,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500, time: NOW - 5000 }) + '\n' +
      req('compaction', NOW - 4000) + '\n' +   // must NOT mark generating
      req('loop', NOW - 2000) + '\n',
  );
  let m = getMetrics(id, opts);
  assert.equal(m.generatingSince, NOW - 2000);

  // The step.end completing the request clears the flag.
  fs.appendFileSync(wirePath, stepEnd({ output: 50, streamMs: 1000, ttftMs: 300, time: NOW - 1000 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.generatingSince, null);

  // A stale in-flight marker (aborted generation) expires with the window.
  fs.appendFileSync(wirePath, req('loop', NOW - 11 * 60_000) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.generatingSince, null);
});

test('getMetrics returns nulls for unknown sessions', () => {
  const m = getMetrics('nope', {
    sessionsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-empty-')),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-')),
  });
  assert.deepEqual(m, {
    tps: null, tpsTotal: null, activeAgents: 0, ttftMs: null,
    thinkingLevel: null, goal: null, generatingSince: null,
  });
});
