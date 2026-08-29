import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getMetrics,
  median,
} from '../src/metrics.mjs';
import {
  EVENT_TIME,
  FRESH_NOW,
  llmRequest,
  makeSession as makeWireSession,
  stepEnd as wireStepEnd,
  toolCall,
  toolResult,
  turnPrompt,
} from './.helpers.mjs';

// Fleet and swarm display aggregation: how getMetrics turns per-agent samples into speed figures, head counts and the swarm parking rules.

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
