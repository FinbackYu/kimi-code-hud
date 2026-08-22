import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMetrics, processWireChunk } from '../src/metrics.mjs';
import { emptyState } from '../src/metrics-state.mjs';
import { renderHud } from '../src/render.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const WIRE_FIXTURE = path.join(FIXTURES, 'wire-events-tower.jsonl');
const EVENT_TIME = 1785456000000;
const FRESH_NOW = EVENT_TIME + 60_000;
const AFTER_FIXTURE = 1785456011000;

const TOWER_DARK = '\x1b[38;2;91;192;190m[tower]\x1b[0m';
const TOWER_LIGHT = '\x1b[1m\x1b[38;2;20;184;166m[tower]\x1b[0m';

function basePayload(overrides = {}) {
  return {
    model: 'K3',
    cwd: '/workspace/kimi-code-hud',
    gitBranch: 'main',
    permissionMode: 'manual',
    planMode: false,
    sessionId: 'abc123',
    ...overrides,
  };
}

function baseCtx(overrides = {}) {
  return {
    payload: basePayload(),
    metrics: { tps: 47, ttftMs: 1300 },
    gitDirty: false,
    color: false,
    ...overrides,
  };
}

function makeSession({ agents = ['main'] } = {}) {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-tower-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-tower-state-'));
  const id = 'abc123';
  const sessionDir = path.join(sessionsRoot, 'workspace-redacted', `session_${id}`);
  const wires = {};
  for (const agent of agents) {
    const agentDir = path.join(sessionDir, 'agents', agent);
    fs.mkdirSync(agentDir, { recursive: true });
    wires[agent] = path.join(agentDir, 'wire.jsonl');
    fs.writeFileSync(wires[agent], '');
  }
  return { sessionsRoot, stateDir, id, wires };
}

function stepEnd({ output, time, finishReason = 'tool_use' }) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    agentId: 'redacted',
    event: {
      type: 'step.end',
      turnId: 'redacted',
      usage: {
        inputOther: 100,
        output,
        inputCacheRead: 300,
        inputCacheCreation: 100,
      },
      finishReason,
      llmFirstTokenLatencyMs: 100,
      llmStreamDurationMs: 1000,
    },
    time,
  });
}

test('tower reducer accepts tower_mode.enter with or without optional sessionId', () => {
  const [enterLine, exitLine] = fs.readFileSync(WIRE_FIXTURE, 'utf8').trim().split('\n');
  const state = emptyState();
  processWireChunk(state, `${enterLine}\n`);
  assert.equal(state.towerMode, true);
  processWireChunk(state, `${exitLine}\n`);
  assert.equal(state.towerMode, false);
  processWireChunk(
    state,
    '{"type":"tower_mode.enter","agentId":"redacted","time":1785456011000}\n',
  );
  assert.equal(state.towerMode, true);
});

test('tower_mode.enter and exit flow through persisted metrics state', () => {
  const fx = makeSession();
  const [enterLine, exitLine] = fs.readFileSync(WIRE_FIXTURE, 'utf8').trim().split('\n');
  fs.writeFileSync(fx.wires.main, `${enterLine}\n`);
  const on = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    now: AFTER_FIXTURE,
  });
  assert.equal(on.towerMode, true);
  fs.appendFileSync(fx.wires.main, `${exitLine}\n`);
  const off = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    now: AFTER_FIXTURE,
  });
  assert.equal(off.towerMode, false);
});

test('v10 backfill recovers tower mode from a v9 projection', () => {
  const fx = makeSession();
  const [enterLine] = fs.readFileSync(WIRE_FIXTURE, 'utf8').trim().split('\n');
  fs.writeFileSync(fx.wires.main, `${enterLine}\n`);
  const size = fs.statSync(fx.wires.main).size;
  fs.writeFileSync(
    path.join(fx.stateDir, `metrics-${fx.id}.json`),
    JSON.stringify({
      v: 8,
      agents: { main: { offset: size, samples: [], lastMedian: null } },
      modelAlias: null,
      thinkingLevel: null,
      goal: null,
      swarmMode: false,
      backfillScanV: 9,
    }),
  );
  const metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    now: AFTER_FIXTURE,
  });
  assert.equal(metrics.towerMode, true);
  const state = JSON.parse(
    fs.readFileSync(path.join(fx.stateDir, `metrics-${fx.id}.json`), 'utf8'),
  );
  assert.equal(state.towerMode, true);
  assert.equal(state.backfillScanV, 10);
});

test('tower badge renders from wire metrics and payload fallback', () => {
  const metrics = { tps: 47, ttftMs: 1300, towerMode: true };
  const [dark] = renderHud(baseCtx({ color: true, metrics }));
  assert.ok(dark.includes(TOWER_DARK));
  const [light] = renderHud(baseCtx({ color: true, theme: 'light', metrics }));
  assert.ok(light.includes(TOWER_LIGHT));
  const [plain] = renderHud(baseCtx({ metrics }));
  assert.ok(plain.startsWith('[manual] [tower] '));

  const [payloadOnly] = renderHud(baseCtx({ payload: basePayload({ towerMode: true }) }));
  assert.ok(payloadOnly.startsWith('[manual] [tower] '));
  const [both] = renderHud(baseCtx({
    payload: basePayload({ swarmMode: true, towerMode: true }),
  }));
  assert.ok(both.startsWith('[manual] [swarm] [tower] '));
});

test('a 0.38 wire without Tower records keeps the existing render and fleet behavior', () => {
  const withoutField = renderHud(baseCtx());
  const towerOff = renderHud(baseCtx({
    metrics: { tps: 47, ttftMs: 1300, towerMode: false },
  }));
  assert.deepEqual(towerOff, withoutField);
  assert.ok(!towerOff[0].includes('[tower]'));

  const fx = makeSession({ agents: ['main', 'agent-0'] });
  fs.writeFileSync(
    fx.wires.main,
    [0, 1, 2].map((n) => stepEnd({ output: 111, time: EVENT_TIME + n })).join('\n') + '\n',
  );
  fs.writeFileSync(
    fx.wires['agent-0'],
    [0, 1, 2].map((n) => stepEnd({ output: 300, time: EVENT_TIME + n })).join('\n') + '\n',
  );
  const metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    now: FRESH_NOW,
  });
  assert.equal(metrics.towerMode, false);
  assert.equal(metrics.activeAgents, 2);
  assert.equal(metrics.mainActive, true);
  assert.equal(metrics.tpsTotal, 411);
});

test('Tower excludes a parked main and keeps a lone worker in fleet style', () => {
  const fx = makeSession({ agents: ['main', 'agent-0'] });
  const [enterLine] = fs.readFileSync(WIRE_FIXTURE, 'utf8').trim().split('\n');
  fs.writeFileSync(
    fx.wires.main,
    `${enterLine}\n` +
      [0, 1, 2].map((n) => stepEnd({ output: 111, time: EVENT_TIME + n })).join('\n') +
      '\n',
  );
  fs.writeFileSync(
    fx.wires['agent-0'],
    [0, 1, 2].map((n) => stepEnd({ output: 300, time: EVENT_TIME + n })).join('\n') + '\n',
  );
  const metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    now: FRESH_NOW,
  });
  assert.equal(metrics.towerMode, true);
  assert.equal(metrics.activeAgents, 1);
  assert.equal(metrics.mainActive, false);
  assert.equal(metrics.tpsTotal, 300);

  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 300 t/s (1 agent @300)'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 300 (1@300)'));
});
