import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CACHE_BACKFILL_MAX_BYTES,
  median,
  processWireChunk,
  getMetrics,
  findWirePath,
  findSessionDir,
} from '../src/metrics.mjs';
import { summarizeMetrics } from '../src/metrics-summary.mjs';
import { emptyAgent } from '../src/metrics-agent.mjs';

const EVENT_TIME = Date.parse('2026-07-31T00:00:00Z');
const FRESH_NOW = EVENT_TIME + 60_000;

function stepEnd({
  output,
  streamMs,
  ttftMs,
  time = EVENT_TIME,
  finishReason = 'end_turn',
  turnId = '6',
  inputOther = 952,
  inputCacheRead = 67840,
  inputCacheCreation = 0,
}) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      turnId,
      step: 11,
      usage: { inputOther, output, inputCacheRead, inputCacheCreation },
      finishReason,
      llmFirstTokenLatencyMs: ttftMs,
      llmStreamDurationMs: streamMs,
    },
    time,
  });
}

function turnPrompt(text = 'hello', time = EVENT_TIME, originKind = 'user') {
  return JSON.stringify({
    type: 'turn.prompt',
    input: [{ type: 'text', text }],
    // null originKind models pre-origin records, which were all user prompts.
    ...(originKind === null ? {} : { origin: { kind: originKind } }),
    time,
  });
}

function llmRequest({ kind = 'loop', time = EVENT_TIME } = {}) {
  return JSON.stringify({ type: 'llm.request', kind, time });
}

function toolCall({ name = 'AgentSwarm', time = EVENT_TIME } = {}) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'tool.call', turnId: '6', step: 11, toolCallId: 'tool_x', name, args: {} },
    time,
  });
}

function toolResult({ time = EVENT_TIME } = {}) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'tool.result', turnId: '6', step: 11, toolCallId: 'tool_x', result: {} },
    time,
  });
}

function turnEnded({ reason = 'completed', time = EVENT_TIME, turnId = 0 } = {}) {
  return JSON.stringify({ type: 'turn.ended', turnId, reason, time });
}

function compactionBegin({ source = 'manual', time = EVENT_TIME } = {}) {
  return JSON.stringify({ type: 'full_compaction.begin', source, time });
}

function compactionComplete({ time = EVENT_TIME } = {}) {
  return JSON.stringify({ type: 'full_compaction.complete', time });
}

function compactionCancel({ time = EVENT_TIME } = {}) {
  return JSON.stringify({ type: 'full_compaction.cancel', time });
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
    v: 7,
    agents: {},
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
  };
}

test('median of odd and even samples', () => {
  assert.equal(median([10]), 10);
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([40, 10, 30, 20]), 25);
  assert.equal(median([]), null);
});

test('processWireChunk computes TPS with timestamped per-agent samples', () => {
  const state = makeState();
  const lines = [
    '{"type":"other"}',
    'not json',
    stepEnd({ output: 112, streamMs: 2768, ttftMs: 2155 }),
    stepEnd({ output: 0, streamMs: 1000, ttftMs: 300 }),   // skipped: no output
    stepEnd({ output: 100, streamMs: 10, ttftMs: 400 }),   // skipped: too fast
    stepEnd({ output: 50, streamMs: 1000, ttftMs: 500 }),
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 600 }),
    stepEnd({ output: 150, streamMs: 1000, ttftMs: 700 }),
    stepEnd({ output: 200, streamMs: 1000, ttftMs: 800 }),
    stepEnd({ output: 250, streamMs: 1000, ttftMs: 900 }),
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  const bucket = state.agents.main;
  // Storage keeps up to 20 samples; the freshest 5 feed the median.
  assert.equal(bucket.samples.length, 6);
  assert.ok(Math.abs(bucket.samples[0].v - 112 / 2.768) < 1e-9);
  assert.equal(bucket.samples[0].t, EVENT_TIME);
  assert.equal(bucket.samples[1].v, 50);
  assert.equal(bucket.lastTtftMs, 900);
  assert.equal(bucket.lastSampleAt, EVENT_TIME);
  assert.equal(bucket.lastMedian, 150); // median of the freshest [50,100,150,200,250]
});

test('processWireChunk ignores the 0.36 plugin.session_start content snapshot', () => {
  const state = makeState();
  processWireChunk(state, '{"type":"other"}\n');
  const before = structuredClone(state);
  const sensitive = 'do-not-store-session-start-content';
  processWireChunk(state, `${JSON.stringify({
    type: 'plugin.session_start',
    content: sensitive,
    time: EVENT_TIME,
  })}\n`);

  assert.deepEqual(state, before);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(sensitive));
});

test('getMetrics rebuilds complete model usage across main and subagent wires', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const usageRecord = (model, usage) => `${JSON.stringify({
    type: 'usage.record', model, usage, usageScope: 'turn', time: EVENT_TIME,
  })}\n`;
  fs.writeFileSync(wires.main, usageRecord('openai/gpt-5.6', {
    inputOther: 100, inputCacheRead: 200, inputCacheCreation: 0, output: 50,
  }));
  fs.writeFileSync(wires['agent-0'], usageRecord('openai/gpt-5.6', {
    inputOther: 10, inputCacheRead: 20, inputCacheCreation: 0, output: 5,
  }));

  const metrics = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.deepEqual(metrics.modelUsage, {
    scope: 'session',
    agents: 'all',
    byModel: {
      'openai/gpt-5.6': {
        inputOther: 110,
        inputCacheRead: 220,
        inputCacheCreation: 0,
        output: 55,
      },
    },
  });
});

test('processWireChunk bounds the stored per-agent sample array', () => {
  const state = makeState();
  const lines = [];
  for (let i = 0; i < 25; i++) {
    lines.push(stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + i }));
  }
  processWireChunk(state, lines.join('\n') + '\n');
  assert.equal(state.agents.main.samples.length, 20);
  assert.equal(state.agents.main.samples[0].t, EVENT_TIME + 5);
});

test('processWireChunk rejects unreliable stream durations and implausible TPS', () => {
  const state = makeState();
  const lines = [
    stepEnd({ output: 167, streamMs: 50, ttftMs: 20442 }),   // 3340 t/s: buffered tool call
    stepEnd({ output: 251, streamMs: 250, ttftMs: 500 }),    // 1004 t/s: implausible
    stepEnd({ output: 250, streamMs: 250, ttftMs: 600 }),    // boundary: 1000 t/s
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 700 }),
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.deepEqual(state.agents.main.samples.map((s) => s.v), [1000, 100]);
  assert.equal(state.agents.main.lastTtftMs, 700);
});

test('processWireChunk buckets samples per agent', () => {
  const state = makeState();
  processWireChunk(
    state,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }) + '\n' +
      stepEnd({ output: 200, streamMs: 1000, ttftMs: 600 }) + '\n',
    'main',
  );
  processWireChunk(state, stepEnd({ output: 800, streamMs: 1000, ttftMs: 100 }) + '\n', 'agent-0');
  assert.equal(state.agents.main.samples.length, 2);
  assert.equal(state.agents['agent-0'].samples.length, 1);
  assert.equal(state.agents['agent-0'].samples[0].v, 800);
  assert.equal(state.agents['agent-0'].lastTtftMs, 100);
});

test('processWireChunk tracks latest thinkingLevel from config.update', () => {
  const state = makeState();
  const lines = [
    '{"type":"config.update","modelAlias":"kimi-code/k3","thinkingLevel":"on","time":1}',
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }),
    '{"type":"config.update","modelAlias":"kimi-code/k3","time":2}',  // same model, keep sample
    '{"type":"config.update","thinkingLevel":"high","time":3}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.thinkingLevel, 'high');
  assert.equal(state.agents.main.samples.length, 1); // step.end still processed
});

test('processWireChunk accepts the newer thinkingEffort key', () => {
  const state = makeState();
  const lines = [
    '{"type":"config.update","modelAlias":"kimi-code/k3-256k","thinkingEffort":"low","time":1}',
    '{"type":"config.update","thinkingEffort":"max","time":2}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.thinkingLevel, 'max');
});

test('processWireChunk tracks model and thinkingEffort from profile.bind', () => {
  const state = makeState();
  const lines = [
    '{"type":"profile.bind","modelAlias":"deepseek/deepseek-v4-flash","profileName":"agent","thinkingEffort":"max","time":1}',
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }),
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.modelAlias, 'deepseek/deepseek-v4-flash');
  assert.equal(state.thinkingLevel, 'max');
  assert.equal(state.agents.main.samples.length, 1); // step.end still processed
});

test('processWireChunk tracks effort and model from llm.request rows', () => {
  const state = makeState();
  const lines = [
    '{"type":"profile.bind","modelAlias":"deepseek/deepseek-v4-flash","thinkingEffort":"high","time":1}',
    // In-session switch with no META row: the next request carries the new effort.
    '{"type":"llm.request","modelAlias":"deepseek/deepseek-v4-flash","model":"deepseek-v4-flash","thinkingEffort":"max","time":2}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.thinkingLevel, 'max');
  assert.equal(state.modelAlias, 'deepseek/deepseek-v4-flash');
});

test('processWireChunk llm.request model switch resets the fleet windows', () => {
  const state = makeState();
  const lines = [
    '{"type":"profile.bind","modelAlias":"deepseek/deepseek-v4-flash","thinkingEffort":"max","time":1}',
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100 }),
    stepEnd({ output: 200, streamMs: 1000, ttftMs: 200 }),
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 300 }),
    // No config.update on the switch — the request row carries the new alias.
    '{"type":"llm.request","modelAlias":"kimi-code/k3-256k","model":"k3-256k","thinkingEffort":"max","time":2}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.modelAlias, 'kimi-code/k3-256k');
  assert.equal(state.agents.main.samples.length, 0);
});

test('processWireChunk llm.request without effort never clobbers the bound level', () => {
  const state = makeState();
  const lines = [
    '{"type":"profile.bind","modelAlias":"deepseek/deepseek-v4-flash","thinkingEffort":"max","time":1}',
    '{"type":"llm.request","modelAlias":"deepseek/deepseek-v4-flash","time":2}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.thinkingLevel, 'max');
  assert.equal(state.modelAlias, 'deepseek/deepseek-v4-flash');
});

test('processWireChunk ignores subagent llm.request model metadata', () => {
  const state = makeState();
  processWireChunk(
    state,
    '{"type":"llm.request","modelAlias":"__secondary__","thinkingEffort":"max","time":1}\n',
    'agent-0',
  );
  assert.equal(state.thinkingLevel, null);
  assert.equal(state.modelAlias, null);
});

test('processWireChunk ignores subagent config/goal/swarm/turn rows', () => {
  const state = makeState();
  const lines = [
    '{"type":"config.update","modelAlias":"kimi-code/k3","thinkingEffort":"max","time":1}',
    '{"type":"goal.create","goalId":"g1","objective":"do it","time":2}',
    '{"type":"swarm_mode.enter","trigger":"manual","time":3}',
    turnPrompt(),
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }),
  ].join('\n') + '\n';
  processWireChunk(state, lines, 'agent-0');
  assert.equal(state.thinkingLevel, null);
  assert.equal(state.modelAlias, null);
  assert.equal(state.goal, null);
  assert.equal(state.swarmMode, false);
  // Turn boundaries are main-agent only...
  assert.equal(state.agents['agent-0'].lastTurnPromptAt, null);
  // ...while the subagent's own speed sample still lands in its bucket.
  assert.equal(state.agents['agent-0'].samples.length, 1);
});

test('processWireChunk tracks in-flight generations and closes them', () => {
  const state = makeState();
  processWireChunk(state, llmRequest() + '\n');
  assert.equal(state.agents.main.lastRequestAt, EVENT_TIME);
  assert.equal(state.agents.main.lastStepEndAt, null);
  // step.end closes the in-flight window.
  processWireChunk(
    state,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1000 }) + '\n',
  );
  assert.equal(state.agents.main.lastStepEndAt, EVENT_TIME + 1000);
});

test('processWireChunk turn.cancel closes an in-flight generation', () => {
  const state = makeState();
  processWireChunk(
    state,
    llmRequest() + '\n' + JSON.stringify({ type: 'turn.cancel', time: EVENT_TIME + 500 }) + '\n',
  );
  assert.equal(state.agents.main.lastRequestAt, EVENT_TIME);
  assert.equal(state.agents.main.lastStepEndAt, EVENT_TIME + 500);
});

test('processWireChunk turn.ended closes the generation and main turn', () => {
  const state = makeState();
  processWireChunk(
    state,
    turnPrompt() + '\n' +
      llmRequest({ time: EVENT_TIME + 100 }) + '\n' +
      turnEnded({ reason: 'failed', time: EVENT_TIME + 500 }) + '\n',
  );
  assert.equal(state.agents.main.lastStepEndAt, EVENT_TIME + 500);
  assert.equal(state.agents.main.lastTurnEndAt, EVENT_TIME + 500);
});

test('processWireChunk subagent turn.ended closes only that agent generation', () => {
  const state = makeState();
  processWireChunk(state, turnPrompt() + '\n');
  processWireChunk(
    state,
    llmRequest({ time: EVENT_TIME + 100 }) + '\n' +
      turnEnded({ reason: 'blocked', time: EVENT_TIME + 500 }) + '\n',
    'agent-0',
  );
  assert.equal(state.agents['agent-0'].lastStepEndAt, EVENT_TIME + 500);
  // The turn-end marker is per agent: agent-0's turn.ended settles its own
  // bucket (so the fleet summary can drop it) without touching main's clock.
  assert.equal(state.agents['agent-0'].lastTurnEndAt, EVENT_TIME + 500);
  assert.equal(state.agents.main.lastTurnEndAt, null);
});

test('processWireChunk queued turn.cancel does not close the active generation or turn', () => {
  const state = makeState();
  processWireChunk(
    state,
    turnPrompt() + '\n' +
      llmRequest({ time: EVENT_TIME + 100 }) + '\n' +
      JSON.stringify({
        type: 'turn.cancel',
        turnId: 1,
        target: 'queued',
        reason: 'user_cancelled',
        time: EVENT_TIME + 500,
      }) + '\n',
  );
  assert.equal(state.agents.main.lastStepEndAt, null);
  assert.equal(state.agents.main.lastTurnEndAt, null);
});

test('processWireChunk tracks turn boundaries on the main agent', () => {
  const state = makeState();
  processWireChunk(state, turnPrompt() + '\n');
  assert.equal(state.agents.main.lastTurnPromptAt, EVENT_TIME);
  assert.equal(state.agents.main.lastTurnEndAt, null);
  // A mid-turn tool step does not end the turn.
  processWireChunk(
    state,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1000, finishReason: 'tool_use' }) + '\n',
  );
  assert.equal(state.agents.main.lastTurnEndAt, null);
  // end_turn closes it.
  processWireChunk(
    state,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 2000 }) + '\n',
  );
  assert.equal(state.agents.main.lastTurnEndAt, EVENT_TIME + 2000);
});

test('processWireChunk compaction never marks generating and its completion closes', () => {
  const state = makeState();
  processWireChunk(state, llmRequest({ kind: 'compaction' }) + '\n');
  assert.equal(state.agents.main.lastRequestAt, null);
  // A real request followed by full_compaction.complete also closes.
  processWireChunk(state, llmRequest({ time: EVENT_TIME + 1000 }) + '\n');
  assert.equal(state.agents.main.lastRequestAt, EVENT_TIME + 1000);
  processWireChunk(
    state,
    JSON.stringify({ type: 'full_compaction.complete', time: EVENT_TIME + 2000 }) + '\n',
  );
  assert.equal(state.agents.main.lastStepEndAt, EVENT_TIME + 2000);
});

test('processWireChunk folds swarm_mode.enter/exit, last one wins', () => {
  const state = makeState();
  const lines = [
    '{"type":"swarm_mode.enter","trigger":"manual","time":1}',
    '{"type":"swarm_mode.exit","time":2}',
    '{"type":"swarm_mode.enter","trigger":"prompt","time":3}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.swarmMode, true);
});

test('processWireChunk swarm_mode.exit without enter stays off', () => {
  const state = makeState();
  processWireChunk(state, '{"type":"swarm_mode.exit","time":1}\n');
  assert.equal(state.swarmMode, false);
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
});

test('findSessionDir locates the session directory across dir spellings', () => {
  const a = makeSession({ withPrefix: true });
  assert.equal(findSessionDir(a.id, a.root), a.sessionDir);
  assert.equal(findSessionDir('ses_' + a.id, a.root), a.sessionDir);
  assert.equal(findSessionDir('missing', a.root), null);
});

test('getMetrics reads incrementally and survives truncation', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };

  fs.writeFileSync(wirePath, stepEnd({ output: 100, streamMs: 1000, ttftMs: 1200 }) + '\n');
  let m = getMetrics(id, opts);
  assert.equal(m.tps, 100); // provisional: a single fresh sample
  assert.equal(m.tpsStale, true);
  assert.equal(m.ttftMs, 1200);
  assert.equal(m.activeAgents, 1);

  // append: only new bytes are parsed
  fs.appendFileSync(wirePath, stepEnd({ output: 300, streamMs: 1000, ttftMs: 800 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.tps, 200); // provisional: median(100, 300)
  assert.equal(m.tpsStale, true);
  assert.equal(m.ttftMs, 800);

  fs.appendFileSync(wirePath, stepEnd({ output: 200, streamMs: 1000, ttftMs: 700 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.tps, 200); // first full reading: median(100, 300, 200)
  assert.equal(m.tpsStale, false);
  assert.equal(m.tpsTotal, 200); // a lone live agent still feeds the fleet figure
  assert.equal(m.tpsAgents, 1);

  // incomplete trailing line is held for next run
  fs.appendFileSync(wirePath, stepEnd({ output: 999, streamMs: 1000 }).slice(0, 20));
  m = getMetrics(id, opts);
  assert.equal(m.tps, 200);

  // truncation resets the offset
  fs.writeFileSync(
    wirePath,
    stepEnd({ output: 40, streamMs: 1000, ttftMs: 300 }) + '\n' +
      stepEnd({ output: 60, streamMs: 1000, ttftMs: 200 }) + '\n' +
      stepEnd({ output: 80, streamMs: 1000, ttftMs: 100 }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.equal(m.tps, 60);
  assert.equal(m.ttftMs, 100);
  assert.equal(m.samples, undefined); // result only exposes the metric fields
});

test('getMetrics discards stale samples when a rotated file grows past the old offset', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };

  fs.writeFileSync(
    wirePath,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 1200 }) + '\n' +
      stepEnd({ output: 200, streamMs: 1000, ttftMs: 1000 }) + '\n' +
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

test('getMetrics main-wire rotation also resets the derived badge state', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    '{"type":"config.update","thinkingEffort":"high","time":1}\n' +
      '{"type":"goal.create","goalId":"g1","objective":"do it","time":2}\n' +
      '{"type":"swarm_mode.enter","trigger":"manual","time":3}\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 100 }) + '\n',
  );
  const before = getMetrics(id, opts);
  assert.equal(before.thinkingLevel, 'high');
  assert.ok(before.goal);
  assert.equal(before.swarmMode, true);

  const replacement = `${wirePath}.next`;
  fs.writeFileSync(
    replacement,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100 }) + '\n' +
      stepEnd({ output: 200, streamMs: 1000, ttftMs: 200 }) + '\n' +
      stepEnd({ output: 300, streamMs: 1000, ttftMs: 300 }) + '\n',
  );
  fs.renameSync(replacement, wirePath);

  const m = getMetrics(id, opts);
  assert.equal(m.thinkingLevel, null);
  assert.equal(m.goal, null);
  assert.equal(m.swarmMode, false);
  assert.equal(m.tps, 200);
});

test('getMetrics wire rotation clears an open turn timer', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: EVENT_TIME + 1000 };
  fs.writeFileSync(wirePath, turnPrompt('before rotation', EVENT_TIME) + '\n');
  assert.equal(getMetrics(id, opts).turnStartedAt, EVENT_TIME);

  const replacement = `${wirePath}.next`;
  fs.writeFileSync(replacement, '{"type":"noop","time":1785400001000}\n');
  fs.renameSync(replacement, wirePath);
  assert.equal(getMetrics(id, opts).turnStartedAt, null);
});

test('getMetrics keeps a rolling 5-sample median after the 3-sample warmup', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    [
      stepEnd({ output: 10, streamMs: 1000, ttftMs: 100 }),
      stepEnd({ output: 20, streamMs: 1000, ttftMs: 100 }),
      stepEnd({ output: 30, streamMs: 1000, ttftMs: 100 }),
      stepEnd({ output: 40, streamMs: 1000, ttftMs: 100 }),
      stepEnd({ output: 50, streamMs: 1000, ttftMs: 100 }),
      stepEnd({ output: 60, streamMs: 1000, ttftMs: 100 }),
    ].join('\n') + '\n',
  );
  assert.equal(getMetrics(id, opts).tps, 40); // median(20, 30, 40, 50, 60)
});

test('getMetrics resets TPS and TTFT when modelAlias changes', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    [
      '{"type":"config.update","modelAlias":"kimi-code/k3","thinkingEffort":"high","time":1}',
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 100 }),
      stepEnd({ output: 200, streamMs: 1000, ttftMs: 200 }),
      stepEnd({ output: 300, streamMs: 1000, ttftMs: 300 }),
    ].join('\n') + '\n',
  );
  const before = getMetrics(id, opts);
  assert.equal(before.tps, 200);
  assert.equal(before.modelAlias, 'kimi-code/k3');

  fs.appendFileSync(
    wirePath,
    '{"type":"config.update","modelAlias":"anthropic/claude-opus-5","thinkingEffort":"max","time":2}\n' +
      stepEnd({ output: 400, streamMs: 1000, ttftMs: 400 }) + '\n',
  );
  let m = getMetrics(id, opts);
  assert.equal(m.tps, 400); // provisional: the new model's first sample
  assert.equal(m.tpsStale, true); // old median discarded with the old model
  assert.equal(m.ttftMs, 400);
  assert.equal(m.modelAlias, 'anthropic/claude-opus-5');

  fs.appendFileSync(
    wirePath,
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 500 }) + '\n' +
      stepEnd({ output: 600, streamMs: 1000, ttftMs: 600 }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.equal(m.tps, 500);
});

test('getMetrics modelAlias change resets every agent bucket', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    '{"type":"config.update","modelAlias":"kimi-code/k3","time":1}\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 100 }) + '\n' +
      stepEnd({ output: 200, streamMs: 1000, ttftMs: 200 }) + '\n' +
      stepEnd({ output: 300, streamMs: 1000, ttftMs: 300 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  assert.equal(getMetrics(id, opts).tpsTotal, 700); // fleet of 2

  fs.appendFileSync(
    wires.main,
    '{"type":"config.update","modelAlias":"anthropic/claude-opus-5","time":2}\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.tps, null);
  assert.equal(m.tpsStale, false); // last median discarded for the whole fleet
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.deepEqual(state.agents.main.samples, []);
  assert.deepEqual(state.agents['agent-0'].samples, []);
});

test('getMetrics keeps the last median as stale after the 2-minute TTL', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    [
      stepEnd({ output: 40, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
      stepEnd({ output: 50, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
      stepEnd({ output: 60, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
    ].join('\n') + '\n',
  );
  const opts = { sessionsRoot: root, stateDir };
  const fresh = getMetrics(id, { ...opts, now: EVENT_TIME + 120_000 });
  assert.equal(fresh.tps, 50);
  assert.equal(fresh.tpsStale, false);
  const stale = getMetrics(id, { ...opts, now: EVENT_TIME + 120_001 });
  assert.equal(stale.tps, 50); // last median stays, flagged stale
  assert.equal(stale.tpsStale, true);
  assert.equal(stale.activeAgents, 0);
});

test('getMetrics expires samples older than 10 minutes at read time', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    [
      stepEnd({ output: 40, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
      stepEnd({ output: 50, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
      stepEnd({ output: 60, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
    ].join('\n') + '\n',
  );
  const opts = { sessionsRoot: root, stateDir };
  assert.equal(getMetrics(id, { ...opts, now: FRESH_NOW }).tps, 50);
  // 10 minutes later the samples themselves are gone; only the remembered
  // last median survives (dimmed), and the persisted bucket is pruned.
  const m = getMetrics(id, { ...opts, now: EVENT_TIME + 600_001 });
  assert.equal(m.tps, 50);
  assert.equal(m.tpsStale, true);
  assert.equal(m.activeAgents, 0);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.deepEqual(state.agents.main.samples, []);
});

test('getMetrics starts a new warmup instead of reviving an expired window', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir };
  fs.writeFileSync(
    wirePath,
    [
      stepEnd({ output: 40, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
      stepEnd({ output: 50, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
      stepEnd({ output: 60, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
    ].join('\n') + '\n',
  );
  assert.equal(getMetrics(id, { ...opts, now: EVENT_TIME + 60_000 }).tps, 50);

  fs.appendFileSync(
    wirePath,
    stepEnd({ output: 400, streamMs: 1000, ttftMs: 400, time: EVENT_TIME + 180_001 }) + '\n',
  );
  // The gap cleared the live window; the first fresh sample shows right away
  // as a provisional (dimmed) reading instead of the expired median.
  let m = getMetrics(id, { ...opts, now: EVENT_TIME + 180_002 });
  assert.equal(m.tps, 400);
  assert.equal(m.tpsStale, true);

  fs.appendFileSync(
    wirePath,
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 500, time: EVENT_TIME + 180_003 }) + '\n' +
      stepEnd({ output: 600, streamMs: 1000, ttftMs: 600, time: EVENT_TIME + 180_004 }) + '\n',
  );
  m = getMetrics(id, { ...opts, now: EVENT_TIME + 180_005 });
  assert.equal(m.tps, 500);
  assert.equal(m.tpsStale, false);
});

test('getMetrics drops legacy samples that lack freshness and model metadata', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({
      offset: fs.statSync(wirePath).size,
      samples: [3043, 2500, 1800, 50, 48],
      lastTtftMs: 500,
    }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.tps, null);
  assert.equal(m.ttftMs, null);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.v, 8);
  assert.deepEqual(state.agents.main.samples, []);
  assert.equal(state.sampleStateV, undefined); // legacy marker not carried over
});

test('getMetrics migrates flat states into buckets, preserving window and badges', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(wirePath, stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }) + '\n');
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({
      offset: size,
      samples: [100, 200, 300],
      lastTtftMs: 500,
      lastSampleAt: EVENT_TIME,
      lastMedian: 200,
      sampleStateV: 1,
      modelAlias: 'kimi-code/k3',
      thinkingLevel: 'high',
      goal: { status: 'active', turnsUsed: 1 },
      swarmMode: true,
      backfillScanV: 5,
    }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  // The migrated samples were stamped with lastSampleAt, so the window is
  // still fresh and keeps describing the same session — but the migrated
  // swarmMode flag marks main as parked (no request in flight), so the
  // reading now surfaces through the dimmed stale-median fallback.
  assert.equal(m.tps, 200);
  assert.equal(m.tpsStale, true);
  assert.equal(m.modelAlias, 'kimi-code/k3');
  assert.equal(m.thinkingLevel, 'high');
  assert.deepEqual(m.goal, { status: 'active', turnsUsed: 1 });
  assert.equal(m.swarmMode, true);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.v, 8);
  assert.equal(state.agents.main.offset, size);
  assert.deepEqual(
    state.agents.main.samples,
    [100, 200, 300].map((v) => ({ v, t: EVENT_TIME })),
  );
  assert.equal(state.agents.main.lastMedian, 200);
  assert.equal(state.lastMedian, undefined);
});

test('getMetrics migrates v6 global median into per-agent buckets without cross-agent guessing', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const sample = (v) => ({ v, t: EVENT_TIME });
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({
      v: 6,
      agents: {
        main: { offset: 0, samples: [sample(10), sample(10), sample(10)] },
        'agent-0': { offset: 0, samples: [sample(100), sample(100), sample(100)] },
      },
      lastMedian: 100,
      modelAlias: null,
      thinkingLevel: null,
      goal: null,
      swarmMode: false,
      cacheScanV: 2,
      backfillScanV: 8,
      cache: { readTokens: 0, inputTokens: 0 },
    }),
  );
  getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME });
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.v, 8);
  assert.equal(state.agents.main.lastMedian, 10);
  assert.equal(state.agents['agent-0'].lastMedian, 100);
  assert.equal(state.lastMedian, undefined);
  assert.equal(fs.existsSync(wires.main), true);
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
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.thinkingLevel, 'high');
  // Second run must not rescan (versioned scan marker persisted).
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.backfillScanV, 10);
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
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.thinkingLevel, 'max'); // latest config.update wins
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.backfillScanV, 10);
  assert.equal(state.thinkingScanDone, undefined); // legacy marker dropped
});

test('getMetrics v9 backfill re-scans v8 states and picks up request-level effort', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    '{"type":"profile.bind","modelAlias":"deepseek/deepseek-v4-flash","thinkingEffort":"high","time":1}\n' +
      '{"type":"llm.request","modelAlias":"deepseek/deepseek-v4-flash","thinkingEffort":"max","time":2}\n',
  );
  // v8 state: offset already past the rows, scan marked done at the previous
  // version — the request-level effort was never captured.
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({
      v: 8,
      agents: { main: { offset: size, samples: [], lastMedian: null } },
      modelAlias: null,
      thinkingLevel: null,
      goal: null,
      swarmMode: false,
      backfillScanV: 8,
    }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.thinkingLevel, 'max'); // last llm.request wins
  assert.equal(m.modelAlias, 'deepseek/deepseek-v4-flash');
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.backfillScanV, 10);
});

test('getMetrics fresh sessions derive tracked rows without a separate backfill scan', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    '{"type":"config.update","thinkingEffort":"low","time":1}\n' +
      '{"type":"goal.create","goalId":"g1","objective":"do it","time":2}\n' +
      '{"type":"swarm_mode.enter","trigger":"manual","time":3}\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }) + '\n',
  );
  // Cold start (no state file): the incremental pass from offset 0 consumes
  // every row — goal/swarm/thinking arrive without a second full read.
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.thinkingLevel, 'low');
  assert.ok(m.goal);
  assert.equal(m.swarmMode, true);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.backfillScanV, 10); // marker still set, no rescan later
});

test('getMetrics tracks swarm mode from the wire journal', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(wirePath, '{"type":"swarm_mode.enter","trigger":"manual","time":1}\n');
  const on = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(on.swarmMode, true);
  fs.appendFileSync(wirePath, '{"type":"swarm_mode.exit","time":2}\n');
  const off = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(off.swarmMode, false);
});

test('getMetrics v6 backfill re-scans v5 states and anchors the turn timer', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    turnPrompt() + '\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1000, finishReason: 'tool_use' }) + '\n',
  );
  // 0.3.0-era state: offset already past the prompt, turn boundaries never
  // captured, marker at v5.
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
      backfillScanV: 5,
    }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  // The one-time re-scan recovers the open turn: prompt with no later
  // end_turn means the timer is anchored right now.
  assert.equal(m.turnStartedAt, EVENT_TIME);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.backfillScanV, 10);
});

test('getMetrics v7 backfill re-scans v6 states and recovers turn.ended', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    turnPrompt() + '\n' + turnEnded({ reason: 'failed', time: EVENT_TIME + 1000 }) + '\n',
  );
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
      backfillScanV: 6,
    }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.turnStartedAt, null);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.agents.main.lastTurnPromptAt, EVENT_TIME);
  assert.equal(state.agents.main.lastTurnEndAt, EVENT_TIME + 1000);
  assert.equal(state.backfillScanV, 10);
});

test('getMetrics v5 backfill re-scans v4 states and picks up swarm_mode.enter', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wirePath,
    '{"type":"swarm_mode.enter","trigger":"manual","time":1}\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }) + '\n',
  );
  // v4 state: offset already past the event, swarm flag never captured.
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({ offset: size, samples: [100], lastTtftMs: 500, backfillScanV: 4 }),
  );
  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.swarmMode, true);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.backfillScanV, 10);
});

test('getMetrics aggregates an active fleet: total, average, count, TTFT median', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 600, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-1'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 600_000, finishReason: 'tool_use' }) + '\n', // stuck retry
  );
  const m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 3);
  assert.equal(m.tpsAgents, 3);
  assert.equal(m.tpsTotal, 900);
  assert.equal(m.tps, 300); // true per-agent average, not the median
  assert.equal(m.tpsStale, false);
  // TTFT is the median across active agents: the stuck one cannot poison it.
  assert.equal(m.ttftMs, 600);
  // The main agent feeds the figures, so the renderer labels them "main+N".
  assert.equal(m.mainActive, true);
  assert.equal(m.mainSpeed, true);
});

test('getMetrics fleet of subagents only leaves the main flags off', () => {
  // Mid-swarm the main agent waits without producing samples, so the head
  // count is a pure subagent figure and needs no "main+" label.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-1'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 2);
  assert.equal(m.tpsAgents, 2);
  assert.equal(m.tpsTotal, 800);
  assert.equal(m.mainActive, false);
  assert.equal(m.mainSpeed, false);
});

test('getMetrics fleet members contribute speed with a single fresh sample', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100 }) + '\n' +
      stepEnd({ output: 200, streamMs: 1000, ttftMs: 100 }) + '\n' +
      stepEnd({ output: 300, streamMs: 1000, ttftMs: 100 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 2);
  assert.equal(m.tpsAgents, 2);
  assert.equal(m.tpsTotal, 700);
  assert.equal(m.tps, 350); // mean of the main median (200) and the subagent sample
});

test('getMetrics fleet speed head count excludes agents without samples', () => {
  // Reproduces "124 t/s (3 agents @62)": the third agent had a request in
  // flight but no step.end yet, so only two speeds fed the 124 total.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    stepEnd({ output: 62, streamMs: 1000, ttftMs: 100 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 62, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(wires['agent-1'], llmRequest() + '\n'); // generating, no sample
  const m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 3); // every live agent (gen ticker head count)
  assert.equal(m.tpsAgents, 2); // only agents feeding the speed figure
  assert.equal(m.tpsTotal, 124);
  assert.equal(m.tps, 62);
});

test('getMetrics fleet with a single speed reading reports tpsAgents 1', () => {
  // Reproduces "68 t/s (2 agents @68)": two live agents, one with a reading.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    stepEnd({ output: 68, streamMs: 1000, ttftMs: 100 }) + '\n',
  );
  fs.writeFileSync(wires['agent-0'], llmRequest() + '\n');
  const m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 2);
  assert.equal(m.tpsAgents, 1);
  assert.equal(m.tpsTotal, 68);
  assert.equal(m.tps, 68);
});

test('fleet-to-solo fallback uses the remaining agent median', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(
    wires.main,
    [0, 1, 2].map((n) => stepEnd({
      output: 10, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n,
    })).join('\n') + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    [0, 1, 2].map((n) => stepEnd({
      output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n, finishReason: 'tool_use',
    })).join('\n') + '\n',
  );
  const fleet = getMetrics(id, {
    sessionsRoot: root, stateDir, now: EVENT_TIME + 2,
  });
  assert.equal(fleet.tps, 55);
  assert.equal(fleet.tpsTotal, 110);

  fs.appendFileSync(
    wires.main,
    llmRequest({ time: EVENT_TIME + 130_000 }) + '\n',
  );
  const solo = getMetrics(id, {
    sessionsRoot: root, stateDir, now: EVENT_TIME + 130_000,
  });
  assert.equal(solo.activeAgents, 1);
  assert.equal(solo.tps, 10);
  assert.equal(solo.tpsStale, true);
});

test('getMetrics lone live subagent still reports the one-agent fleet figure', () => {
  // A swarm that has run down to its last member: agent-0 keeps streaming
  // while main waits idle. The renderer needs tpsTotal/tpsAgents here to
  // keep fleet style, so the lone reading is exposed as a one-agent fleet
  // figure instead of a bare solo tps.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires['agent-0'],
    [0, 1, 2].map((n) => stepEnd({
      output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n, finishReason: 'tool_use',
    })).join('\n') + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 1);
  assert.equal(m.tpsAgents, 1);
  assert.equal(m.tpsTotal, 100);
  assert.equal(m.tps, 100);
  assert.equal(m.mainActive, false);
  assert.equal(m.mainSpeed, false);
});

test('getMetrics drops a subagent from the fleet the moment its turn ends', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-1'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  let m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 3);
  assert.equal(m.tpsTotal, 900);

  // A subagent wire never carries turn.ended; its closing end_turn step.end
  // settles it, so it leaves the head count and stops feeding the
  // total/average immediately instead of lingering on the recency window.
  fs.appendFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1000 }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 2);
  assert.equal(m.tpsAgents, 2);
  assert.equal(m.tpsTotal, 600);
  assert.equal(m.tps, 300);
});

test('getMetrics re-activates a settled subagent when a later request arrives', () => {
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n' +
      stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1000 }) + '\n',
  );
  // end_turn settles agent-0: only main stays active, and its single sample
  // below MIN_SAMPLES shows as a provisional (dimmed) one-agent reading.
  let m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 1);
  assert.equal(m.tps, 100);
  assert.equal(m.tpsStale, true);
  assert.equal(m.tpsAgents, 1);
  assert.equal(m.tpsTotal, 100);

  // A resumed run (resume_agent_ids) starts a fresh request, so the subagent
  // re-joins the fleet even before its next sample lands.
  fs.appendFileSync(wires['agent-0'], llmRequest({ time: EVENT_TIME + 2000 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 2);
  assert.equal(m.tpsAgents, 2);
  assert.equal(m.tpsTotal, 600);
  assert.equal(m.tps, 300);
});

test('getMetrics swarm mode drops a parked main from the fleet', () => {
  // User report: with swarm mode on, main is blocked inside the AgentSwarm
  // tool — no request in flight, no new samples — yet its pre-swarm samples
  // kept it counted (and summed into the total) for the whole recency
  // window, rendering e.g. "333 t/s (main+2 agents @111)" while only the two
  // subagents were actually generating. A parked main must leave the fleet
  // immediately, like a settled subagent.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    `{"type":"swarm_mode.enter","trigger":"prompt","time":${EVENT_TIME - 1000}}\n` +
      [0, 1, 2].map((n) => stepEnd({
        output: 111, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n, finishReason: 'tool_use',
      })).join('\n') + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-1'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.swarmMode, true);
  assert.equal(m.activeAgents, 2);
  assert.equal(m.tpsAgents, 2);
  assert.equal(m.tpsTotal, 800);
  assert.equal(m.tps, 400);
  assert.equal(m.mainActive, false);
  assert.equal(m.mainSpeed, false);
});

test('getMetrics swarm mode keeps a generating main in the fleet', () => {
  // Main talking between swarm waves has a request in flight (newer than its
  // latest step.end): it still feeds the fleet and the "main+" label.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    `{"type":"swarm_mode.enter","trigger":"prompt","time":${EVENT_TIME - 1000}}\n` +
      stepEnd({ output: 111, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n' +
      llmRequest({ time: EVENT_TIME + 10 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-1'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.swarmMode, true);
  assert.equal(m.activeAgents, 3);
  assert.equal(m.tpsAgents, 3);
  assert.equal(m.tpsTotal, 911);
  assert.equal(m.tps, 911 / 3);
  assert.equal(m.mainActive, true);
  assert.equal(m.mainSpeed, true);
});

test('getMetrics swarm mode drops a main blocked inside a long tool call', () => {
  // Regression: the real wire journals a blocking tool_use step as
  // llm.request at the step start and step.end only when the tool returns
  // (the reported AgentSwarm block lasted ~7 minutes), so
  // `lastRequestAt > lastStepEndAt` — and the old request-based parked check
  // never fired while the HUD showed "main+7". The step's tool.call row is
  // the moment the LLM actually stopped generating: a request superseded by
  // an unanswered tool.call is waiting, not generating.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    `{"type":"swarm_mode.enter","trigger":"prompt","time":${EVENT_TIME - 1000}}\n` +
      [0, 1, 2].map((n) => stepEnd({
        output: 111, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n, finishReason: 'tool_use',
      })).join('\n') + '\n' +
      llmRequest({ time: EVENT_TIME + 10 }) + '\n' +
      toolCall({ name: 'AgentSwarm', time: EVENT_TIME + 20 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-1'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  let m = getMetrics(id, opts);
  assert.equal(m.swarmMode, true);
  assert.equal(m.activeAgents, 2);
  assert.equal(m.tpsAgents, 2);
  assert.equal(m.tpsTotal, 800);
  assert.equal(m.mainActive, false);
  assert.equal(m.mainSpeed, false);

  // The swarm returns: tool.result and the closing step.end land together,
  // the next request starts streaming, and main re-joins the fleet with its
  // pre-block samples still fresh.
  fs.appendFileSync(
    wires.main,
    toolResult({ time: EVENT_TIME + 30 }) + '\n' +
      stepEnd({
        output: 500, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 30, finishReason: 'tool_use',
      }) + '\n' +
      llmRequest({ time: EVENT_TIME + 40 }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 3);
  assert.equal(m.tpsAgents, 3);
  assert.equal(m.mainActive, true);
  assert.equal(m.mainSpeed, true);
});

test('getMetrics swarm mode keeps a main whose latest request postdates its tool call', () => {
  // Between waves main streams a fresh step: its llm.request is newer than
  // the previous step's (already answered) tool.call, so it is generating,
  // not parked — only an unanswered tool.call newer than the request parks
  // the main agent.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0', 'agent-1'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    `{"type":"swarm_mode.enter","trigger":"prompt","time":${EVENT_TIME - 1000}}\n` +
      stepEnd({ output: 111, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n' +
      toolCall({ name: 'Read', time: EVENT_TIME + 10 }) + '\n' +
      toolResult({ time: EVENT_TIME + 20 }) + '\n' +
      stepEnd({
        output: 111, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 20, finishReason: 'tool_use',
      }) + '\n' +
      llmRequest({ time: EVENT_TIME + 30 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-1'],
    stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.swarmMode, true);
  assert.equal(m.activeAgents, 3);
  assert.equal(m.tpsAgents, 3);
  assert.equal(m.mainActive, true);
  assert.equal(m.mainSpeed, true);
});

test('getMetrics swarm mode with every subagent settled falls back to the stale main median', () => {
  // The swarm has wound down but not exited yet: all subagents settled, main
  // still parked. The display falls back to main's dimmed last median
  // instead of a live one-agent fleet figure.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    `{"type":"swarm_mode.enter","trigger":"prompt","time":${EVENT_TIME - 1000}}\n` +
      [0, 1, 2].map((n) => stepEnd({
        output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n, finishReason: 'tool_use',
      })).join('\n') + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    [0, 1, 2].map((n) => stepEnd({
      output: 500, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n, finishReason: 'tool_use',
    })).join('\n') + '\n' +
      stepEnd({ output: 500, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1000 }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 0);
  assert.equal(m.tpsAgents, 0);
  assert.equal(m.tpsTotal, null);
  assert.equal(m.tps, 100);
  assert.equal(m.tpsStale, true);
  assert.equal(m.mainActive, false);
});

test('getMetrics after swarm_mode.exit the just-finished main speed stays live as before', () => {
  // The parked-main drop only applies while swarm mode is on. Once the swarm
  // exits, a solo main keeps the old exemption: its just-finished reading
  // survives live until the stale TTL.
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    `{"type":"swarm_mode.enter","trigger":"prompt","time":${EVENT_TIME - 2000}}\n` +
      `{"type":"swarm_mode.exit","time":${EVENT_TIME - 1000}}\n` +
      [0, 1, 2].map((n) => stepEnd({
        output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n, finishReason: 'tool_use',
      })).join('\n') + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.swarmMode, false);
  assert.equal(m.activeAgents, 1);
  assert.equal(m.tps, 100);
  assert.equal(m.tpsStale, false);
  assert.equal(m.mainActive, true);
});

test('getMetrics drops a solo main blocked in a single Agent tool call (non-swarm)', () => {
  // Bug report: with swarm mode off, main directly calling a single `Agent`
  // tool blocks the same way — llm.request lands at the step start and
  // step.end only when the tool returns — so `generating` reads true for the
  // whole block. The old parked check required swarmMode===true, leaving main
  // counted (and summed into the fleet) as a live agent. A main waiting on an
  // unanswered tool.call while its own turn is still open must drop out.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    turnPrompt({ time: EVENT_TIME - 10 }) + '\n' +
      [0, 1, 2].map((n) => stepEnd({
        output: 111, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + n, finishReason: 'tool_use',
      })).join('\n') + '\n' +
      llmRequest({ time: EVENT_TIME + 10 }) + '\n' +
      toolCall({ name: 'Agent', time: EVENT_TIME + 20 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.swarmMode, false);
  assert.equal(m.activeAgents, 1);
  assert.equal(m.tpsAgents, 1);
  assert.equal(m.tpsTotal, 300);
  assert.equal(m.mainActive, false);
  assert.equal(m.mainSpeed, false);
});

test('getMetrics keeps a solo main whose tool.call has already been answered (non-swarm)', () => {
  // A tool_use step that has fully returned (tool.result and the closing
  // step.end landed) is not a block: the request postdates the tool.call, so
  // the step is generating again. The "unanswered tool.call" gate must not
  // misjudge an answered one — main stays in the fleet and in the total.
  const { root, id, wires } = makeSession({ agents: ['main', 'agent-0'] });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wires.main,
    stepEnd({ output: 111, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n' +
      toolCall({ name: 'Read', time: EVENT_TIME + 10 }) + '\n' +
      toolResult({ time: EVENT_TIME + 20 }) + '\n' +
      stepEnd({
        output: 111, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 20, finishReason: 'tool_use',
      }) + '\n' +
      llmRequest({ time: EVENT_TIME + 30 }) + '\n',
  );
  fs.writeFileSync(
    wires['agent-0'],
    stepEnd({ output: 300, streamMs: 1000, ttftMs: 100, finishReason: 'tool_use' }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.swarmMode, false);
  assert.equal(m.activeAgents, 2);
  assert.equal(m.tpsAgents, 2);
  assert.equal(m.tpsTotal, 411);
  assert.equal(m.tps, 411 / 2);
  assert.equal(m.mainActive, true);
  assert.equal(m.mainSpeed, true);
});

test('getMetrics solo display shows a provisional reading below MIN_SAMPLES', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 100 }) + '\n' +
      stepEnd({ output: 200, streamMs: 1000, ttftMs: 200 }) + '\n',
  );
  const m = getMetrics(id, opts);
  assert.equal(m.activeAgents, 1);
  assert.equal(m.tps, 150); // provisional: median(100, 200) below MIN_SAMPLES
  assert.equal(m.tpsStale, true); // dimmed until the full median takes over
  assert.equal(m.ttftMs, 200);
});

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

test('getMetrics persists and incrementally updates session-cumulative cache usage', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    turnPrompt() + '\n' +
      stepEnd({
        output: 100,
        streamMs: 1000,
        ttftMs: 500,
        turnId: '1',
        inputOther: 100,
        inputCacheRead: 300,
        inputCacheCreation: 100,
      }) + '\n',
  );

  let m = getMetrics(id, opts);
  assert.deepEqual(m.cache, { hitRate: 0.6, readTokens: 300, inputTokens: 500 });

  fs.appendFileSync(
    wirePath,
    stepEnd({
      output: 100,
      streamMs: 1000,
      ttftMs: 400,
      turnId: '1',
      inputOther: 400,
      inputCacheRead: 100,
      inputCacheCreation: 0,
    }) + '\n',
  );
  m = getMetrics(id, opts);
  assert.deepEqual(m.cache, { hitRate: 0.4, readTokens: 400, inputTokens: 1000 });

  const persisted = JSON.parse(
    fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'),
  );
  assert.equal(persisted.cache.readTokens, 400);
  assert.equal(persisted.cache.inputTokens, 1000);
  assert.equal(persisted.cacheScanV, 2);
});

test('getMetrics keeps the session cache value unchanged across a new prompt', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    turnPrompt('first') + '\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 500, turnId: '1' }) + '\n',
  );
  const expected = {
    hitRate: 67840 / 68792,
    readTokens: 67840,
    inputTokens: 68792,
  };
  assert.deepEqual(getMetrics(id, opts).cache, expected);

  fs.appendFileSync(wirePath, turnPrompt('second') + '\n');
  assert.deepEqual(getMetrics(id, opts).cache, expected);
});

test('cache migration restores only usage before the old offset then reads new bytes once', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const first = turnPrompt() + '\n' + stepEnd({
    output: 100,
    streamMs: 1000,
    ttftMs: 500,
    turnId: '1',
    inputOther: 100,
    inputCacheRead: 300,
    inputCacheCreation: 100,
  }) + '\n';
  fs.writeFileSync(wirePath, first);
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({
      offset: Buffer.byteLength(first),
      samples: [100, 200, 300],
      lastTtftMs: 500,
      lastSampleAt: EVENT_TIME,
      lastMedian: 200,
      sampleStateV: 1,
      backfillScanV: 5,
    }),
  );
  fs.appendFileSync(
    wirePath,
    stepEnd({
      output: 100,
      streamMs: 1000,
      ttftMs: 400,
      turnId: '1',
      inputOther: 400,
      inputCacheRead: 100,
      inputCacheCreation: 0,
    }) + '\n',
  );

  const m = getMetrics(id, { sessionsRoot: root, stateDir, now: FRESH_NOW });
  assert.equal(m.tps, 150); // only the newly appended TPS row was added
  assert.deepEqual(m.cache, { hitRate: 0.4, readTokens: 400, inputTokens: 1000 });
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.deepEqual(state.agents.main.samples.map((s) => s.v), [100, 200, 300, 100]);
});

test('bounded cache migration counts tail step.end rows without their prompt', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const oversized = JSON.stringify({
    type: 'other',
    data: 'x'.repeat(CACHE_BACKFILL_MAX_BYTES),
  });
  fs.writeFileSync(
    wirePath,
    turnPrompt() + '\n' + oversized + '\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 500, turnId: '1' }) + '\n',
  );
  const size = fs.statSync(wirePath).size;
  fs.writeFileSync(
    path.join(stateDir, `metrics-${id}.json`),
    JSON.stringify({
      offset: size,
      samples: [],
      sampleStateV: 1,
      backfillScanV: 5,
    }),
  );

  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  // The prompt lies beyond the 1 MiB tail, but the step.end inside the tail
  // still counts toward the cumulative session ratio.
  const restored = getMetrics(id, opts).cache;
  assert.notEqual(restored, null);

  fs.appendFileSync(
    wirePath,
    turnPrompt('next') + '\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 400, turnId: '2' }) + '\n',
  );
  const m = getMetrics(id, opts).cache;
  // The new step.end folds in cumulatively; identical usage doubles the
  // session counters.
  assert.equal(m.inputTokens, restored.inputTokens * 2);
  assert.equal(m.readTokens, restored.readTokens * 2);
});

test('getMetrics persists and reports the host version from the payload', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  fs.writeFileSync(wirePath, '');
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW, hostVersion: '0.31.1' };
  let m = getMetrics(id, opts);
  assert.equal(m.hostVersion, '0.31.1');
  let state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.hostVersion, '0.31.1');
  m = getMetrics(id, { ...opts, hostVersion: '0.33.0' });
  assert.equal(m.hostVersion, '0.33.0');
  state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.hostVersion, '0.33.0');
});

test('getMetrics returns nulls for unknown sessions', () => {
  const m = getMetrics('nope', {
    sessionsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-empty-')),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-')),
  });
  assert.deepEqual(m, {
    tps: null, tpsStale: false, ttftMs: null, thinkingLevel: null, goal: null,
    modelAlias: null, swarmMode: false, towerMode: false, hostVersion: null,
    cache: null, modelUsage: null,
    tpsTotal: null, tpsAgents: 0, activeAgents: 0, mainActive: false, mainSpeed: false,
    turnStartedAt: null, compactingSince: null, compactionMs: null, genSettledMs: null,
    tasks: { bash: 0, agents: 0 },
  });
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
