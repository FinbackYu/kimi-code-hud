import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMetrics, processWireChunk } from '../src/metrics.mjs';
import { renderHud } from '../src/render.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = 1785456060000;
const TOKEN_COUNTING_ANY = /"type":"token_counting\./;

/** The fixture's token_counting rows only: the rows under test. */
function tokenCountingRows(wireText) {
  return wireText.split('\n').filter((line) => line && TOKEN_COUNTING_ANY.test(line));
}

/** The fixture without token_counting rows: the ignore baseline. */
function baselineWithoutTokenCounting(wireText) {
  return wireText
    .split('\n')
    .filter((line) => line && !TOKEN_COUNTING_ANY.test(line))
    .join('\n') + '\n';
}

/** Run one fixture text through the full getMetrics pipeline. */
function makeSessionMetrics(wireText) {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-tc-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-tc-state-'));
  const agentDir = path.join(
    sessionsRoot,
    'workspace-redacted',
    'ses_abc123',
    'agents',
    'main',
  );
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'wire.jsonl'), wireText);
  const metrics = getMetrics('abc123', { sessionsRoot, stateDir, now: NOW });
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'metrics-abc123.json'), 'utf8'));
  return { metrics, state };
}

/**
 * Drop the per-file read cursors so two independently created sessions can
 * be compared field by field: offsets, inode-based fileIds and tail
 * checksums legitimately differ between the fixture and its baseline copy.
 */
function stripCursors(state) {
  const clone = structuredClone(state);
  delete clone.sessionDir;
  for (const bucket of Object.values(clone.agents || {})) {
    delete bucket.fileId;
    delete bucket.offset;
    delete bucket.tailMarker;
  }
  for (const agentUsage of Object.values(clone.sessionUsage?.agents || {})) {
    delete agentUsage.reader?.fileId;
    delete agentUsage.reader?.offset;
    delete agentUsage.reader?.tailMarker;
  }
  return clone;
}

test('fixture mixes all three persisted token_counting row types into a normal session', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-token-counting.jsonl'),
    'utf8',
  );
  for (const type of ['measured', 'truncated', 'rebased']) {
    assert.ok(wireText.includes(`"type":"token_counting.${type}"`));
  }
  // The non-token-counting rows must stay byte-identical to the reference
  // wire fixture, so the ignore baseline differs on exactly one axis.
  const reference = fs.readFileSync(path.join(FIXTURES, 'wire-events.jsonl'), 'utf8');
  assert.equal(baselineWithoutTokenCounting(wireText), reference);
});

test('processWireChunk folds token_counting rows without touching the state', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-token-counting.jsonl'),
    'utf8',
  );
  const state = {
    v: 7,
    agents: {},
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
  };
  // Establish the normalized main bucket first, so the before/after
  // comparison is limited to what the token_counting rows could change.
  processWireChunk(state, '{"type":"other"}\n');
  const before = structuredClone(state);
  const rows = tokenCountingRows(wireText).join('\n') + '\n';
  assert.doesNotThrow(() => processWireChunk(state, rows));
  assert.deepEqual(state, before);
});

test('persisted token_counting rows leave metrics, state and render identical to baseline', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-token-counting.jsonl'),
    'utf8',
  );
  const withRows = makeSessionMetrics(wireText);
  const withoutRows = makeSessionMetrics(baselineWithoutTokenCounting(wireText));

  // The baseline itself still yields the reference readings, so the
  // comparison covers a live, non-empty session.
  assert.equal(withoutRows.metrics.tps, 30);
  assert.deepEqual(withoutRows.metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });

  assert.deepEqual(withRows.metrics, withoutRows.metrics);
  assert.deepEqual(stripCursors(withRows.state), stripCursors(withoutRows.state));

  const payload = {
    model: 'K3',
    cwd: '/workspace/hud',
    gitBranch: 'main',
    permissionMode: 'manual',
    planMode: false,
    sessionId: 'abc123',
  };
  const base = { payload, quota: null, gitDirty: false, color: false, now: NOW };
  const rendered = renderHud({ ...base, metrics: withRows.metrics });
  assert.deepEqual(renderHud({ ...base, metrics: withoutRows.metrics }), rendered);
  // The rows must not leak into badge state either: no [swarm] badge.
  assert.ok(rendered.every((line) => !line.includes('[swarm]')));
});
