import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { median, processWireChunk, getMetrics, findWirePath } from '../src/metrics.mjs';

function stepEnd({ output, streamMs, ttftMs }) {
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
    time: 1780239554281,
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
});

test('processWireChunk tracks latest thinkingLevel from config.update', () => {
  const state = { offset: 0, samples: [], lastTtftMs: null, thinkingLevel: null };
  const lines = [
    '{"type":"config.update","thinkingLevel":"on","time":1}',
    stepEnd({ output: 100, streamMs: 1000, ttftMs: 500 }),
    '{"type":"config.update","modelAlias":"kimi-code/k3","time":2}',  // no level: keep previous
    '{"type":"config.update","thinkingLevel":"high","time":3}',
  ].join('\n') + '\n';
  processWireChunk(state, lines);
  assert.equal(state.thinkingLevel, 'high');
  assert.equal(state.samples.length, 1); // step.end still processed
});

test('findWirePath matches ses_ prefixed and bare dirs', () => {
  const a = makeSession({ withPrefix: true });
  assert.equal(findWirePath(a.id, a.root), a.wirePath);
  const b = makeSession({ withPrefix: false });
  assert.equal(findWirePath(b.id, b.root), b.wirePath);
  assert.equal(findWirePath('missing', a.root), null);
  assert.equal(findWirePath('ses_' + a.id, a.root), a.wirePath);
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
  assert.equal(m.ttftMs, 100);
  assert.equal(m.samples, undefined); // result only exposes tps/ttftMs
  assert.ok(m.tps !== null);
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
  // Second run must not rescan (thinkingScanDone persisted).
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
  assert.equal(state.thinkingScanDone, true);
});

test('getMetrics returns nulls for unknown sessions', () => {
  const m = getMetrics('nope', {
    sessionsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-empty-')),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-')),
  });
  assert.deepEqual(m, { tps: null, ttftMs: null, thinkingLevel: null });
});
