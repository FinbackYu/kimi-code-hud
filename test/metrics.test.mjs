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
} from '../src/metrics.mjs';

const EVENT_TIME = Date.parse('2026-07-31T00:00:00Z');
const FRESH_NOW = EVENT_TIME + 60_000;

function stepEnd({
  output,
  streamMs,
  ttftMs,
  time = EVENT_TIME,
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
      finishReason: 'end_turn',
      llmFirstTokenLatencyMs: ttftMs,
      llmStreamDurationMs: streamMs,
    },
    time,
  });
}

function turnPrompt(text = 'hello') {
  return JSON.stringify({
    type: 'turn.prompt',
    input: [{ type: 'text', text }],
    origin: { kind: 'user' },
    time: EVENT_TIME,
  });
}

function makeSession({ withPrefix = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-ses-'));
  const id = 'abc123';
  const dir = path.join(root, 'wd_1', withPrefix ? `ses_${id}` : id, 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const wirePath = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wirePath, '');
  return { root, id, wirePath };
}

test('median of odd and even samples', () => {
  assert.equal(median([10]), 10);
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([40, 10, 30, 20]), 25);
  assert.equal(median([]), null);
});

test('processWireChunk computes TPS and keeps last 5 samples', () => {
  const state = { offset: 0, samples: [], lastTtftMs: null };
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
  // first sample 112/2.768≈40.46 drops out once we exceed 5 samples
  assert.equal(state.samples.length, 5);
  assert.equal(state.samples[0], 50);
  assert.equal(state.lastTtftMs, 900);
  assert.equal(state.lastMedian, 150); // median of the kept [50,100,150,200,250]
});

test('processWireChunk rejects unreliable stream durations and implausible TPS', () => {
  const state = { offset: 0, samples: [], lastTtftMs: null };
  const lines = [
    stepEnd({ output: 167, streamMs: 50, ttftMs: 20442 }),   // 3340 t/s: buffered tool call
    stepEnd({ output: 251, streamMs: 250, ttftMs: 500 }),    // 1004 t/s: implausible
    stepEnd({ output: 250, streamMs: 250, ttftMs: 600 }),    // boundary: 1000 t/s
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 700 }),
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.deepEqual(state.samples, [1000, 100]);
  assert.equal(state.lastTtftMs, 700);
});

test('processWireChunk tracks latest thinkingLevel from config.update', () => {
  const state = { offset: 0, samples: [], lastTtftMs: null, thinkingLevel: null };
  const lines = [
    '{"type":"config.update","modelAlias":"kimi-code/k3","thinkingLevel":"on","time":1}',
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }),
    '{"type":"config.update","modelAlias":"kimi-code/k3","time":2}',  // same model, keep sample
    '{"type":"config.update","thinkingLevel":"high","time":3}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.thinkingLevel, 'high');
  assert.equal(state.samples.length, 1); // step.end still processed
});

test('processWireChunk accepts the newer thinkingEffort key', () => {
  const state = { offset: 0, samples: [], lastTtftMs: null, thinkingLevel: null };
  const lines = [
    '{"type":"config.update","modelAlias":"kimi-code/k3-256k","thinkingEffort":"low","time":1}',
    '{"type":"config.update","thinkingEffort":"max","time":2}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.thinkingLevel, 'max');
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

test('getMetrics reads incrementally and survives truncation', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };

  fs.writeFileSync(wirePath, stepEnd({ output: 100, streamMs: 1000, ttftMs: 1200 }) + '\n');
  let m = getMetrics(id, opts);
  assert.equal(m.tps, null);
  assert.equal(m.ttftMs, 1200);

  // append: only new bytes are parsed
  fs.appendFileSync(wirePath, stepEnd({ output: 300, streamMs: 1000, ttftMs: 800 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.tps, null);
  assert.equal(m.ttftMs, 800);

  fs.appendFileSync(wirePath, stepEnd({ output: 200, streamMs: 1000, ttftMs: 700 }) + '\n');
  m = getMetrics(id, opts);
  assert.equal(m.tps, 200); // first display: median(100, 300, 200)

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
  assert.equal(m.samples, undefined); // result only exposes tps/ttftMs
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
  assert.equal(m.tps, null);
  assert.equal(m.tpsStale, false); // last median discarded with the old model
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
  // The gap cleared the live window, but the last median survives (stale)
  // while the new window warms up.
  let m = getMetrics(id, { ...opts, now: EVENT_TIME + 180_002 });
  assert.equal(m.tps, 50);
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
  assert.deepEqual(state.samples, []);
  assert.equal(state.sampleStateV, 1);
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
  assert.equal(state.backfillScanV, 5);
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
  assert.equal(state.backfillScanV, 5);
  assert.equal(state.thinkingScanDone, undefined); // legacy marker dropped
});

test('processWireChunk folds swarm_mode.enter/exit, last one wins', () => {
  const state = { offset: 0, samples: [], lastTtftMs: null, swarmMode: false };
  const lines = [
    '{"type":"swarm_mode.enter","trigger":"manual","time":1}',
    '{"type":"swarm_mode.exit","time":2}',
    '{"type":"swarm_mode.enter","trigger":"prompt","time":3}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.swarmMode, true);
});

test('processWireChunk swarm_mode.exit without enter stays off', () => {
  const state = { offset: 0, samples: [], lastTtftMs: null, swarmMode: false };
  processWireChunk(state, '{"type":"swarm_mode.exit","time":1}\n');
  assert.equal(state.swarmMode, false);
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
  assert.equal(state.backfillScanV, 5);
});

test('getMetrics persists and incrementally updates current-turn cache usage', () => {
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
  assert.equal(persisted.cacheTurn.turnId, '1');
  assert.equal(persisted.cacheTurn.inputTokens, 1000);
  assert.equal(persisted.cacheScanV, 1);
});

test('getMetrics clears the previous cache value as soon as a new prompt arrives', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  const opts = { sessionsRoot: root, stateDir, now: FRESH_NOW };
  fs.writeFileSync(
    wirePath,
    turnPrompt('first') + '\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 500, turnId: '1' }) + '\n',
  );
  assert.notEqual(getMetrics(id, opts).cache, null);

  fs.appendFileSync(wirePath, turnPrompt('second') + '\n');
  assert.equal(getMetrics(id, opts).cache, null);
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
  assert.deepEqual(state.samples, [100, 200, 300, 100]);
});

test('bounded cache migration hides a turn whose prompt lies beyond the 1 MiB tail', () => {
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
  assert.equal(getMetrics(id, opts).cache, null);

  fs.appendFileSync(
    wirePath,
    turnPrompt('next') + '\n' +
      stepEnd({ output: 100, streamMs: 1000, ttftMs: 400, turnId: '2' }) + '\n',
  );
  assert.notEqual(getMetrics(id, opts).cache, null);
});

test('getMetrics returns nulls for unknown sessions', () => {
  const m = getMetrics('nope', {
    sessionsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-empty-')),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-')),
  });
  assert.deepEqual(m, { tps: null, tpsStale: false, ttftMs: null, thinkingLevel: null, goal: null, modelAlias: null, swarmMode: false, cache: null });
});
