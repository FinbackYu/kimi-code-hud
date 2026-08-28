import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { getMetrics } from '../src/metrics.mjs';
import {
  MAIN_WIRE_SLICE_BYTES,
  MAX_PARTIAL_LINE_BYTES,
  WIRE_READ_BUDGET_BYTES,
} from '../src/wire-reader.mjs';
import { EVENT_TIME, makeSession as makeWireSession, stepEnd as wireStepEnd } from './.helpers.mjs';

function makeSession(agents = ['main']) {
  return makeWireSession({
    tmpPrefix: 'kimi-hud-v8-sessions-',
    id: 'v8-session',
    wd: 'wd',
    agents,
    stateDir: true,
    stateTmpPrefix: 'kimi-hud-v8-state-',
  });
}

function stepEnd(output, time = EVENT_TIME) {
  return wireStepEnd({ output, time });
}

function readState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('v8 reader preserves a UTF-8 code point split across frames', () => {
  const fx = makeSession();
  const alias = '模型😀';
  const row = `${JSON.stringify({ type: 'config.update', modelAlias: alias, time: 1 })}\n`;
  const bytes = Buffer.from(row);
  fs.writeFileSync(fx.wires.main, bytes);
  const emojiAt = bytes.indexOf(Buffer.from('😀'));
  const firstBudget = emojiAt + 1;

  let metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    readBudgetBytes: firstBudget,
  });
  assert.equal(metrics.modelAlias, null);
  let state = readState(fx.statePath);
  assert.equal(state.v, 8);
  assert.equal(state.agents.main.offset, firstBudget);
  assert.notEqual(state.agents.main.pendingBase64, '');

  for (let i = 0; i < 10 && metrics.modelAlias !== alias; i++) {
    metrics = getMetrics(fx.id, {
      sessionsRoot: fx.sessionsRoot,
      stateDir: fx.stateDir,
      readBudgetBytes: 7,
    });
  }
  state = readState(fx.statePath);
  assert.equal(metrics.modelAlias, alias);
  assert.equal(state.agents.main.offset, bytes.length);
  assert.equal(state.agents.main.pendingBase64, '');
});

test('v8 enforces one shared wire budget and rotates subagent priority', () => {
  const agents = ['main', ...Array.from({ length: 10 }, (_, i) => `agent-${String(i).padStart(2, '0')}`)];
  const fx = makeSession(agents);
  for (const agent of agents.slice(1)) {
    fs.writeFileSync(fx.wires[agent], Buffer.alloc(200 * 1024, 0x78));
  }

  getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    readBudgetBytes: WIRE_READ_BUDGET_BYTES,
  });
  let state = readState(fx.statePath);
  const firstOffsets = agents.slice(1).map((agent) => state.agents[agent].offset);
  assert.ok(firstOffsets.reduce((sum, offset) => sum + offset, 0) <= WIRE_READ_BUDGET_BYTES);
  assert.deepEqual(firstOffsets.slice(0, 8), Array(8).fill(128 * 1024));
  assert.deepEqual(firstOffsets.slice(8), [0, 0]);
  assert.equal(state.agentCursor, 8);

  getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    readBudgetBytes: WIRE_READ_BUDGET_BYTES,
  });
  state = readState(fx.statePath);
  assert.equal(state.agents['agent-08'].offset, 128 * 1024);
  assert.equal(state.agents['agent-09'].offset, 128 * 1024);
});

test('v7 projection backfill persists its cursor, retries, then swaps atomically', () => {
  const fx = makeSession();
  const historical = Buffer.concat([
    Buffer.alloc(2 * 1024 * 1024, 0x78),
    Buffer.from(`\n${JSON.stringify({ type: 'config.update', modelAlias: 'new-model', time: 2 })}\n`),
  ]);
  fs.writeFileSync(fx.wires.main, historical);
  fs.writeFileSync(fx.statePath, JSON.stringify({
    v: 7,
    agents: { main: { offset: historical.length, samples: [], lastMedian: null } },
    modelAlias: 'old-model',
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
    cacheScanV: 2,
    backfillScanV: 7,
  }));

  let metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    readBudgetBytes: 0,
  });
  let state = readState(fx.statePath);
  assert.equal(metrics.modelAlias, 'old-model');
  assert.equal(state.v, 8);
  assert.equal(state.backfill.reader.offset, 0);
  assert.equal(state.backfillScanV, 7);

  let previous = 0;
  for (let frame = 0; frame < 40 && state.backfill; frame++) {
    metrics = getMetrics(fx.id, {
      sessionsRoot: fx.sessionsRoot,
      stateDir: fx.stateDir,
      readBudgetBytes: 64 * 1024,
    });
    state = readState(fx.statePath);
    if (state.backfill) {
      assert.ok(state.backfill.reader.offset >= previous);
      previous = state.backfill.reader.offset;
      assert.equal(metrics.modelAlias, 'old-model');
    }
  }
  assert.equal(state.backfill, null);
  assert.equal(state.backfillScanV, 10);
  assert.equal(metrics.modelAlias, 'new-model');
  assert.equal(state.sessionDir, fx.sessionDir);
});

test('projection backfill catches a main wire that keeps growing between frames', () => {
  const fx = makeSession();
  const historical = Buffer.concat([
    Buffer.alloc(768 * 1024, 0x78),
    Buffer.from(`\n${JSON.stringify({ type: 'config.update', modelAlias: 'caught', time: 2 })}\n`),
  ]);
  fs.writeFileSync(fx.wires.main, historical);
  fs.writeFileSync(fx.statePath, JSON.stringify({
    v: 7,
    agents: { main: { offset: historical.length, samples: [], lastMedian: null } },
    modelAlias: 'old',
    cacheScanV: 2,
    backfillScanV: 7,
  }));

  let metrics;
  let state;
  for (let frame = 0; frame < 4; frame++) {
    fs.appendFileSync(fx.wires.main, Buffer.concat([
      Buffer.alloc(64 * 1024, 0x79),
      Buffer.from('\n'),
    ]));
    metrics = getMetrics(fx.id, {
      sessionsRoot: fx.sessionsRoot,
      stateDir: fx.stateDir,
    });
    state = readState(fx.statePath);
    if (!state.backfill) break;
  }
  assert.equal(state.backfill, null);
  assert.equal(state.backfillScanV, 10);
  assert.equal(metrics.modelAlias, 'caught');
});

test('an inode change abandons an unfinished projection and restarts at byte zero', () => {
  const fx = makeSession();
  const oldWire = Buffer.concat([
    Buffer.alloc(512 * 1024, 0x78),
    Buffer.from(`\n${JSON.stringify({ type: 'config.update', modelAlias: 'old-history', time: 1 })}\n`),
  ]);
  fs.writeFileSync(fx.wires.main, oldWire);
  fs.writeFileSync(fx.statePath, JSON.stringify({
    v: 7,
    agents: { main: { offset: oldWire.length, samples: [], lastMedian: null } },
    modelAlias: 'visible-old',
    cacheScanV: 2,
    backfillScanV: 7,
  }));
  getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    readBudgetBytes: 32 * 1024,
  });
  assert.notEqual(readState(fx.statePath).backfill, null);

  const replacement = `${JSON.stringify({
    type: 'config.update', modelAlias: 'replacement', time: 3,
  })}\n`;
  const nextPath = `${fx.wires.main}.next`;
  fs.writeFileSync(nextPath, replacement);
  fs.renameSync(nextPath, fx.wires.main);
  const metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
  });
  const state = readState(fx.statePath);
  assert.equal(metrics.modelAlias, 'replacement');
  assert.equal(state.backfill, null);
  assert.equal(state.backfillScanV, 10);
  assert.equal(state.agents.main.offset, Buffer.byteLength(replacement));
});

test('an expired deadline returns persisted metrics without consuming new wire bytes', () => {
  const fx = makeSession();
  fs.writeFileSync(
    fx.wires.main,
    [stepEnd(10), stepEnd(20, EVENT_TIME + 1), stepEnd(30, EVENT_TIME + 2)].join('\n') + '\n',
  );
  let metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    now: EVENT_TIME + 1000,
  });
  assert.equal(metrics.tps, 20);
  const oldOffset = readState(fx.statePath).agents.main.offset;
  fs.appendFileSync(fx.wires.main, `${stepEnd(100, EVENT_TIME + 3)}\n`);

  metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    now: EVENT_TIME + 1000,
    deadline: 0,
  });
  assert.equal(metrics.tps, 20);
  assert.equal(readState(fx.statePath).agents.main.offset, oldOffset);
});

test('50 MiB damaged history catches up across frames without duplicate cache or TPS', () => {
  const fx = makeSession();
  const fd = fs.openSync(fx.wires.main, 'w');
  const damaged = Buffer.alloc(5 * 1024 * 1024, 0x78);
  try {
    for (let i = 0; i < 10; i++) {
      fs.writeSync(fd, damaged);
      fs.writeSync(fd, Buffer.from('\n'));
    }
    const tail = [
      JSON.stringify({ type: 'config.update', modelAlias: 'caught-up', time: 1 }),
      stepEnd(10),
      stepEnd(20, EVENT_TIME + 1),
      stepEnd(30, EVENT_TIME + 2),
    ].join('\n') + '\n';
    fs.writeSync(fd, Buffer.from(tail));
  } finally {
    fs.closeSync(fd);
  }
  assert.ok(fs.statSync(fx.wires.main).size >= 50 * 1024 * 1024);

  let previousOffset = 0;
  let metrics = null;
  for (let frame = 0; frame < 260; frame++) {
    metrics = getMetrics(fx.id, {
      sessionsRoot: fx.sessionsRoot,
      stateDir: fx.stateDir,
      now: EVENT_TIME + 1000,
    });
    const state = readState(fx.statePath);
    const offset = state.agents.main.offset;
    assert.ok(offset - previousOffset <= WIRE_READ_BUDGET_BYTES);
    previousOffset = offset;
    if (offset === fs.statSync(fx.wires.main).size) break;
  }

  const state = readState(fx.statePath);
  assert.equal(state.agents.main.offset, fs.statSync(fx.wires.main).size);
  assert.equal(state.agents.main.pendingBase64, '');
  assert.equal(state.agents.main.discardingLine, false);
  assert.equal(metrics.modelAlias, 'caught-up');
  assert.deepEqual(state.agents.main.samples.map((sample) => sample.v), [10, 20, 30]);
  assert.deepEqual(metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });
  assert.equal(metrics.tps, 20);
  assert.ok(MAX_PARTIAL_LINE_BYTES < damaged.length);
});

test('cold start spends the frame budget to catch up in the first frame', () => {
  const fx = makeSession();
  // Pad past one warm slice so a 256 KiB first frame could not reach the tail.
  const padRow = `${JSON.stringify({ type: 'other', pad: 'x'.repeat(1024) })}\n`;
  const padRows = Math.ceil((MAIN_WIRE_SLICE_BYTES + 64 * 1024) / Buffer.byteLength(padRow));
  const tail = [
    JSON.stringify({ type: 'config.update', modelAlias: 'cold-start', time: 1 }),
    stepEnd(10),
    stepEnd(20, EVENT_TIME + 1),
    stepEnd(30, EVENT_TIME + 2),
  ].join('\n') + '\n';
  fs.writeFileSync(fx.wires.main, padRow.repeat(padRows) + tail);
  const size = fs.statSync(fx.wires.main).size;
  assert.ok(size > MAIN_WIRE_SLICE_BYTES);
  assert.ok(size <= WIRE_READ_BUDGET_BYTES);

  const metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    now: EVENT_TIME + 1000,
  });
  assert.equal(metrics.modelAlias, 'cold-start');
  assert.equal(metrics.tps, 20);
  const state = readState(fx.statePath);
  assert.equal(state.agents.main.offset, size);
});

test('cache migration cut short by a small frame budget resumes until complete', () => {
  const fx = makeSession();
  const firstRow = `${stepEnd(10)}\n`;
  const secondRow = `${stepEnd(20, EVENT_TIME + 1)}\n`;
  fs.writeFileSync(fx.wires.main, firstRow + secondRow);
  const historicalBytes = Buffer.byteLength(firstRow) + Buffer.byteLength(secondRow);
  fs.writeFileSync(fx.statePath, JSON.stringify({
    v: 8,
    agents: { main: { offset: historicalBytes, samples: [], lastMedian: null } },
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
    backfillScanV: 10,
  }));

  // The budget reaches only the newest historical row: it counts, but the
  // scan stays unfinished and no done marker is persisted.
  const tailBudget = Buffer.byteLength(secondRow) + 8;
  let metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    readBudgetBytes: tailBudget,
  });
  let state = readState(fx.statePath);
  assert.deepEqual(metrics.cache, { hitRate: 0.6, readTokens: 300, inputTokens: 500 });
  assert.equal(state.cacheScanV, undefined);

  // A larger budget rescans from the reset counters up to the still-saved
  // offset, then folds the appended row live — every row counts exactly once.
  fs.appendFileSync(fx.wires.main, `${stepEnd(30, EVENT_TIME + 2)}\n`);
  metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    readBudgetBytes: WIRE_READ_BUDGET_BYTES,
  });
  state = readState(fx.statePath);
  assert.deepEqual(metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });
  assert.equal(state.cacheScanV, 2);

  // The persisted marker stops further rescans, so nothing is counted twice.
  metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot,
    stateDir: fx.stateDir,
    readBudgetBytes: WIRE_READ_BUDGET_BYTES,
  });
  assert.deepEqual(metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });
});
