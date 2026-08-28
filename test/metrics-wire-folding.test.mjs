import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  processWireChunk,
} from '../src/metrics.mjs';
import {
  EVENT_TIME,
  llmRequest,
  makeMetricsState,
  stepEnd as wireStepEnd,
  turnEnded,
  turnPrompt,
} from './.helpers.mjs';

// processWireChunk folds wire-journal text into metrics state: pin the reducer behavior per record class without touching the filesystem.

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

const makeState = () => makeMetricsState();

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
