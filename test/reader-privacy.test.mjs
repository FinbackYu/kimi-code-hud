import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getMetrics } from '../src/metrics.mjs';
import {
  MAIN_WIRE_SLICE_BYTES,
  MAX_PARTIAL_LINE_BYTES,
  wireTailDigest,
} from '../src/wire-reader.mjs';
import {
  runHousekeeping,
  scrubLegacySessionCaches,
  SESSION_FILE_TTL_MS,
} from '../src/housekeeping.mjs';
import {
  EVENT_TIME,
  makeSession,
  stepEnd as wireStepEnd,
  turnPrompt,
} from './.helpers.mjs';

// H01 privacy persistence: no wire content may reach the HUD cache. Reader
// cursors persist offsets, discard flags and fixed-length digests only, an
// incomplete record stays in the host wire and is re-read from the source,
// and legacy content-bearing caches migrate to the content-free shape.

const PROMPT_MARKER = 'SYNTHETIC_PRIVATE_PROMPT_NEVER_PERSIST';
const TOOL_MARKER = 'SYNTHETIC_PRIVATE_TOOL_ARGS';
const OUTPUT_MARKER = 'SYNTHETIC_PRIVATE_TOOL_OUTPUT';
const REPLY_MARKER = 'SYNTHETIC_PRIVATE_REPLY_TEXT';
const PENDING_MARKER = 'SYNTHETIC_PRIVATE_PENDING_TAIL';
const ALL_MARKERS = [PROMPT_MARKER, TOOL_MARKER, OUTPUT_MARKER, REPLY_MARKER, PENDING_MARKER];
const DIGEST_RE = /^[0-9a-f]{64}$/;
const NOW = EVENT_TIME + 60_000;

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, out));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectStrings(entry, out));
  }
  return out;
}

/**
 * The persisted state must not carry wire content directly or through any
 * reversible encoding: scan the raw JSON, then decode every plausible base64
 * or hex string and search it too.
 */
function assertStateCarriesNoContent(state, markers) {
  const raw = JSON.stringify(state);
  assert.ok(!raw.includes('pendingBase64'), 'legacy pendingBase64 key survived');
  assert.ok(!raw.includes('tailMarker'), 'legacy tailMarker key survived');
  for (const marker of markers) {
    assert.ok(!raw.includes(marker), `state JSON contains wire content: ${marker}`);
  }
  for (const value of collectStrings(state)) {
    if (/^[A-Za-z0-9+/=]{8,}$/.test(value)) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      for (const marker of markers) {
        assert.ok(!decoded.includes(marker), `base64 field decodes to wire content: ${marker}`);
      }
    }
    if (/^[0-9a-f]{16,}$/.test(value) && value.length % 2 === 0) {
      const decoded = Buffer.from(value, 'hex').toString('utf8');
      for (const marker of markers) {
        assert.ok(!decoded.includes(marker), `hex field decodes to wire content: ${marker}`);
      }
    }
  }
}

function usageRecord(model, usage, time = EVENT_TIME) {
  return `${JSON.stringify({
    type: 'usage.record', model, usage, usageScope: 'turn', time,
  })}\n`;
}

test('an in-flight prompt persists no content and is recovered exactly once', () => {
  const fx = makeSession({ tmpPrefix: 'kimi-hud-privacy-', stateDir: true });
  const opts = { sessionsRoot: fx.sessionsRoot, stateDir: fx.stateDir, now: NOW };
  const promptRow = turnPrompt(`think hard about ${PROMPT_MARKER}`, EVENT_TIME);
  // The host is mid-write: the record has no newline yet.
  fs.writeFileSync(fx.wires.main, promptRow);

  let metrics = getMetrics(fx.id, opts);
  assert.equal(metrics.turnStartedAt, null, 'the incomplete record must not fold');
  let state = readState(fx.statePath);
  assert.equal(state.agents.main.offset, 0, 'the cursor parks at the record start');
  assert.equal(state.agents.main.tailDigest, null);
  assertStateCarriesNoContent(state, [PROMPT_MARKER]);

  // The record completes; the parked cursor re-reads it from the source.
  fs.appendFileSync(fx.wires.main, '\n');
  metrics = getMetrics(fx.id, opts);
  assert.equal(metrics.turnStartedAt, EVENT_TIME);
  state = readState(fx.statePath);
  assert.equal(state.agents.main.offset, Buffer.byteLength(promptRow) + 1);
  assert.match(state.agents.main.tailDigest, DIGEST_RE);
  assertStateCarriesNoContent(state, [PROMPT_MARKER]);

  // A second, still-incomplete sample record parks too, then folds once.
  const sampleRow = wireStepEnd({
    output: 100, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1000,
  });
  fs.appendFileSync(fx.wires.main, sampleRow);
  metrics = getMetrics(fx.id, opts);
  assert.deepEqual(
    readState(fx.statePath).agents.main.samples,
    [],
    'the incomplete sample record must not fold',
  );
  assertStateCarriesNoContent(readState(fx.statePath), [PROMPT_MARKER]);

  fs.appendFileSync(fx.wires.main, '\n');
  metrics = getMetrics(fx.id, opts);
  assert.equal(metrics.tps, 100);
  state = readState(fx.statePath);
  assert.deepEqual(state.agents.main.samples.map((sample) => sample.v), [100]);
  assertStateCarriesNoContent(state, [PROMPT_MARKER]);
});

test('a full synthetic session leaves no prompt, tool or output content in the cache', () => {
  const fx = makeSession({ tmpPrefix: 'kimi-hud-privacy-', stateDir: true });
  const opts = { sessionsRoot: fx.sessionsRoot, stateDir: fx.stateDir, now: NOW };
  const usage = { inputOther: 100, inputCacheRead: 300, inputCacheCreation: 20, output: 40 };
  const rows = [
    turnPrompt(`user asked about ${PROMPT_MARKER}`, EVENT_TIME) + '\n',
    wireStepEnd({ output: 100, streamMs: 1000, ttftMs: 500, finishReason: 'tool_use' }) + '\n',
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        turnId: '1',
        step: 2,
        toolCallId: 'tool_1',
        name: 'write',
        args: { path: 'notes.txt', content: TOOL_MARKER },
      },
      time: EVENT_TIME + 1000,
    }) + '\n',
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        turnId: '1',
        step: 2,
        toolCallId: 'tool_1',
        result: { output: OUTPUT_MARKER },
      },
      time: EVENT_TIME + 2000,
    }) + '\n',
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        turnId: '1',
        usage,
        finishReason: 'tool_use',
        llmFirstTokenLatencyMs: 500,
        llmStreamDurationMs: 1000,
        replyPreview: REPLY_MARKER,
      },
      time: EVENT_TIME + 3000,
    }) + '\n',
    usageRecord('test-model', usage, EVENT_TIME + 3000),
  ];
  fs.writeFileSync(fx.wires.main, rows.join(''));

  const metrics = getMetrics(fx.id, opts);
  assert.equal(metrics.turnStartedAt, EVENT_TIME, 'the turn anchor still folds');
  const state = readState(fx.statePath);
  assert.deepEqual(
    state.agents.main.samples.map((sample) => sample.v),
    [100, 40],
    'both speed samples fold exactly once',
  );
  assert.deepEqual(metrics.modelUsage, {
    scope: 'session',
    agents: 'all',
    byModel: { 'test-model': usage },
  });

  assert.deepEqual(state.sessionUsage.agents.main.byModel, { 'test-model': usage });
  assertStateCarriesNoContent(state, ALL_MARKERS);
});

test('an over-long record is discarded under a persisted flag without stalling', () => {
  const fx = makeSession({ tmpPrefix: 'kimi-hud-privacy-', stateDir: true });
  const opts = { sessionsRoot: fx.sessionsRoot, stateDir: fx.stateDir, now: NOW };
  // The marker sits inside the first MAX_PARTIAL_LINE_BYTES: the legacy cache
  // buffered exactly that span into pendingBase64, so this locks the fix.
  const flood = `{"type":"context","pad":"${PROMPT_MARKER}${'x'.repeat(MAX_PARTIAL_LINE_BYTES + 1024 * 1024)}"}`;
  const tail = `${JSON.stringify({ type: 'config.update', modelAlias: 'after-flood', time: 2 })}\n`;
  fs.writeFileSync(fx.wires.main, flood + '\n' + tail);
  const size = fs.statSync(fx.wires.main).size;

  let metrics = null;
  let state = null;
  let previous = 0;
  for (let frame = 0; frame < 40; frame++) {
    metrics = getMetrics(fx.id, opts);
    state = readState(fx.statePath);
    const offset = state.agents.main.offset;
    assert.ok(offset > previous, 'every frame advances: no same-span re-read starvation');
    assert.ok(offset - previous <= MAIN_WIRE_SLICE_BYTES + MAX_PARTIAL_LINE_BYTES);
    previous = offset;
    if (offset === size) break;
  }

  assert.equal(previous, size, 'the flood is skipped in bounded frames');
  assert.equal(state.agents.main.discardingLine, false);
  assert.equal(metrics.modelAlias, 'after-flood', 'records after the flood still fold');
  assertStateCarriesNoContent(state, [PROMPT_MARKER]);
});

test('an in-place truncate-and-regrow resets the reader through the tail digest', () => {
  const fx = makeSession({ tmpPrefix: 'kimi-hud-privacy-', stateDir: true });
  const opts = { sessionsRoot: fx.sessionsRoot, stateDir: fx.stateDir, now: NOW };
  const before = [
    wireStepEnd({ output: 10, streamMs: 1000, ttftMs: 100, time: EVENT_TIME }),
    wireStepEnd({ output: 20, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 1 }),
    wireStepEnd({ output: 30, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 2 }),
  ].join('\n') + '\n';
  fs.writeFileSync(fx.wires.main, before);
  assert.equal(getMetrics(fx.id, opts).tps, 20);
  const committed = readState(fx.statePath).agents.main.offset;
  assert.match(readState(fx.statePath).agents.main.tailDigest, DIGEST_RE);

  // Same inode, grown back past the committed offset: only the digest can
  // detect that the bytes under the cursor were rewritten.
  const after = `${JSON.stringify({ type: 'other', pad: 'y'.repeat(committed) })}\n` + [
    wireStepEnd({ output: 600, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 3 }),
    wireStepEnd({ output: 700, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 4 }),
    wireStepEnd({ output: 800, streamMs: 1000, ttftMs: 100, time: EVENT_TIME + 5 }),
  ].join('\n') + '\n';
  assert.ok(Buffer.byteLength(after) > committed);
  fs.writeFileSync(fx.wires.main, after);

  const metrics = getMetrics(fx.id, opts);
  assert.equal(metrics.tps, 700, 'the rewritten wire is re-read from byte zero');
  const state = readState(fx.statePath);
  assert.deepEqual(state.agents.main.samples.map((sample) => sample.v), [600, 700, 800]);
  assert.equal(
    state.agents.main.tailDigest,
    wireTailDigest(fx.wires.main, state.agents.main.offset),
  );
  assertStateCarriesNoContent(state, ALL_MARKERS);
});

test('a legacy pendingBase64 cache migrates and recovers the pending record once', () => {
  const fx = makeSession({ tmpPrefix: 'kimi-hud-privacy-', stateDir: true });
  const opts = { sessionsRoot: fx.sessionsRoot, stateDir: fx.stateDir, now: NOW };
  const usage = { inputOther: 100, inputCacheRead: 300, inputCacheCreation: 20, output: 40 };
  const sampleRow = wireStepEnd({ output: 100, streamMs: 1000, ttftMs: 100 }) + '\n';
  const usageRow = usageRecord('test-model', usage);
  const rescued = JSON.stringify({
    type: 'goal.create',
    objective: `finish the ${PENDING_MARKER} migration`,
    budgetLimits: { turnBudget: 9 },
    time: EVENT_TIME + 2000,
  });
  fs.writeFileSync(fx.wires.main, sampleRow + usageRow + rescued + '\n');
  const wireBytes = fs.readFileSync(fx.wires.main);
  const size = wireBytes.length;
  const usageRowStart = Buffer.byteLength(sampleRow);
  const rescuedStart = usageRowStart + Buffer.byteLength(usageRow);

  // The v8 writer committed its cursor past the pending bytes and persisted
  // them base64-encoded; both the main and the usage readers did so.
  const mainOffset = size - 1;
  const usagePendingLen = usageRow.indexOf(PENDING_MARKER) + PENDING_MARKER.length;
  fs.writeFileSync(fx.statePath, JSON.stringify({
    v: 8,
    agents: {
      main: {
        offset: mainOffset,
        fileId: null,
        pendingBase64: wireBytes.subarray(rescuedStart, mainOffset).toString('base64'),
        discardingLine: false,
        tailMarker: wireBytes.subarray(mainOffset - 32, mainOffset).toString('base64'),
        samples: [
          { v: 50, t: EVENT_TIME - 2000 },
          { v: 60, t: EVENT_TIME - 1000 },
          { v: 70, t: EVENT_TIME - 500 },
        ],
        lastMedian: 60,
        lastTtftMs: 100,
        lastSampleAt: EVENT_TIME - 500,
      },
    },
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
    cacheScanV: 2,
    backfillScanV: 10,
    sessionUsage: {
      v: 1,
      complete: false,
      agents: {
        main: {
          reader: {
            offset: usageRowStart + usagePendingLen,
            fileId: null,
            pendingBase64: wireBytes.subarray(usageRowStart, usageRowStart + usagePendingLen)
              .toString('base64'),
            discardingLine: false,
            tailMarker: 'legacy==',
          },
          byModel: { 'already-counted-model': usage },
        },
      },
    },
  }));

  const metrics = getMetrics(fx.id, opts);
  const state = readState(fx.statePath);

  // Upgraded in place: content-free cursors, derived metrics never reset.
  assert.equal(state.v, 9);
  assert.deepEqual(metrics.goal, {
    status: 'active', turnsUsed: 0, turnBudget: 9,
  }, 'the pending record folds from the source, its objective text does not persist');
  assert.deepEqual(
    state.agents.main.samples.map((sample) => sample.v),
    [50, 60, 70],
    'already-counted records are not re-counted',
  );
  assert.equal(state.agents.main.offset, size);
  assert.match(state.agents.main.tailDigest, DIGEST_RE);
  assert.deepEqual(state.sessionUsage.agents.main.byModel, {
    'already-counted-model': usage,
    'test-model': usage,
  }, 'the usage ledger keeps its tally and recovers the pending record once');
  assert.equal(state.sessionUsage.complete, true);

  assertStateCarriesNoContent(state, [PENDING_MARKER]);
});

test('a legacy backfill reader migrates without persisting its pending content', () => {
  const fx = makeSession({ tmpPrefix: 'kimi-hud-privacy-', stateDir: true });
  const history = `${JSON.stringify({
    type: 'config.update', modelAlias: 'backfilled-model', time: 1,
  })}\n`;
  fs.writeFileSync(fx.wires.main, history);
  const stat = fs.statSync(fx.wires.main);
  const fileId = `${stat.dev}:${stat.ino}`;
  const historyBytes = Buffer.from(history);
  const cut = historyBytes.length - 8;
  fs.writeFileSync(fx.statePath, JSON.stringify({
    v: 8,
    agents: { main: { offset: historyBytes.length, samples: [], lastMedian: null } },
    modelAlias: 'visible-old',
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
    cacheScanV: 2,
    backfillScanV: 8,
    backfill: {
      version: 10,
      fileId,
      targetOffset: historyBytes.length,
      reader: {
        offset: cut,
        fileId,
        // The legacy reader held the record's first bytes as pending content.
        pendingBase64: historyBytes.subarray(0, cut).toString('base64'),
        discardingLine: false,
        tailMarker: historyBytes.subarray(Math.max(0, cut - 32), cut).toString('base64'),
      },
      shadow: { agents: {} },
    },
  }));

  const metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot, stateDir: fx.stateDir, now: NOW,
  });
  assert.equal(metrics.modelAlias, 'backfilled-model', 'the projection rebuild still lands');
  const state = readState(fx.statePath);
  assert.equal(state.backfill, null);
  assert.equal(state.backfillScanV, 10);
  assertStateCarriesNoContent(state, ['"type":"config.update"']);
});

test('a legacy cache whose session is gone is still scrubbed on disk', () => {
  const fx = makeSession({ tmpPrefix: 'kimi-hud-privacy-', stateDir: true });
  // The host data is already deleted: this session can never be reopened,
  // so migration-on-read alone would keep its body copy until the TTL.
  fs.rmSync(fx.sessionDir, { recursive: true, force: true });
  fs.writeFileSync(fx.statePath, JSON.stringify({
    v: 8,
    agents: {
      main: {
        offset: 4096,
        fileId: null,
        pendingBase64: Buffer.from(`tail of ${PENDING_MARKER}`).toString('base64'),
        discardingLine: false,
        tailMarker: Buffer.from('raw bytes before the cursor').toString('base64'),
        samples: [],
        lastMedian: null,
      },
    },
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
    sessionUsage: {
      v: 1,
      complete: false,
      agents: {
        main: {
          reader: {
            offset: 128,
            fileId: null,
            pendingBase64: Buffer.from(PENDING_MARKER).toString('base64'),
            discardingLine: false,
            tailMarker: 'legacy==',
          },
          byModel: {},
        },
      },
    },
  }));

  const metrics = getMetrics(fx.id, {
    sessionsRoot: fx.sessionsRoot, stateDir: fx.stateDir, now: NOW,
  });
  assert.equal(metrics.tps, null, 'a missing session keeps the empty projection');
  assert.equal(metrics.turnStartedAt, null);
  const state = readState(fx.statePath);
  assert.equal(state.v, 9, 'the migrated state is persisted without its session');
  assertStateCarriesNoContent(state, [PENDING_MARKER]);

  const settled = fs.readFileSync(fx.statePath, 'utf8');
  getMetrics(fx.id, { sessionsRoot: fx.sessionsRoot, stateDir: fx.stateDir, now: NOW });
  assert.equal(
    fs.readFileSync(fx.statePath, 'utf8'),
    settled,
    'the scrubbed cache is not rewritten on every later frame',
  );
});

test('housekeeping retires stale legacy caches; the cleanup entry clears fresh ones', () => {
  const now = Date.now();
  const hudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-privacy-hk-'));
  const sessionStateDir = path.join(hudDir, 'sessions');
  fs.mkdirSync(sessionStateDir, { recursive: true });
  const legacyCache = JSON.stringify({
    v: 8,
    agents: { main: { offset: 10, pendingBase64: Buffer.from(PENDING_MARKER).toString('base64') } },
  });
  const stale = path.join(sessionStateDir, 'metrics-stale.json');
  const fresh = path.join(sessionStateDir, 'metrics-fresh.json');
  fs.writeFileSync(stale, legacyCache);
  fs.writeFileSync(fresh, legacyCache);
  const old = new Date(now - SESSION_FILE_TTL_MS - 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);

  assert.equal(runHousekeeping({ hudDir, sessionStateDir, now }), true);
  assert.ok(!fs.existsSync(stale), 'a never-reopened legacy cache ages out with the retention window');
  assert.ok(fs.existsSync(fresh), 'the daily sweep never rewrites a fresh cache');
  assert.match(
    fs.readFileSync(fresh, 'utf8'),
    /pendingBase64/,
    'waiting for the retention window alone is not the cleanup path',
  );

  // The explicit cleanup entry migrates the fresh legacy cache in place —
  // no session reopen and no retention wait required.
  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 1, cleaned: 1, removed: 0 },
  );
  const migrated = JSON.parse(fs.readFileSync(fresh, 'utf8'));
  assert.equal(migrated.v, 9);
  assert.equal(migrated.agents.main.offset, 10, 'the cursor survives the migration');
  assertStateCarriesNoContent(migrated, [PENDING_MARKER]);

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 1, cleaned: 0, removed: 0 },
    'a second pass finds nothing left to migrate',
  );
});
