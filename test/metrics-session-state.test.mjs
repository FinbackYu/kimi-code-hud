import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CACHE_BACKFILL_MAX_BYTES,
  findSessionDir,
  findWirePath,
  getMetrics,
} from '../src/metrics.mjs';
import {
  EVENT_TIME,
  FRESH_NOW,
  makeSession as makeWireSession,
  stepEnd as wireStepEnd,
  turnPrompt,
} from './.helpers.mjs';

// Session-state lifecycle: locating session directories, incremental wire reads and rotation, sampling windows, persisted-state migrations and backfills, cumulative cache usage and payload bookkeeping.

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

/**
 * The persisted-state backfill is one generic mechanism: when the current
 * BACKFILL_SCAN_V is newer than the state's marker, the wire journal is
 * re-scanned from byte zero through the ordinary fold path and the missed
 * projections are recovered. Legacy states only come in two shapes — flat
 * top-level cursors (pre-v2) and per-agent buckets (v5+) — so one
 * representative per shape locks the path; the other fields the re-scan can
 * recover (turn timers, swarm mode) fold through the same code and are
 * covered by the current-shape tests below.
 */
test('getMetrics backfill re-scans legacy flat states and picks up missed projections', () => {
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

test('getMetrics backfill re-scans legacy bucketed states and picks up missed projections', () => {
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
