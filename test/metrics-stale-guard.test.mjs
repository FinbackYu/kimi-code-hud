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
const STALE_GUARD_ANY = /"type":"staleGuard\./;

/** The fixture's staleGuard rows only: the rows under test. */
function staleGuardRows(wireText) {
  return wireText.split('\n').filter((line) => line && STALE_GUARD_ANY.test(line));
}

/** The fixture without staleGuard rows: the ignore baseline. */
function baselineWithoutStaleGuard(wireText) {
  return wireText
    .split('\n')
    .filter((line) => line && !STALE_GUARD_ANY.test(line))
    .join('\n') + '\n';
}

/** Run one fixture text through the full getMetrics pipeline. */
function makeSessionMetrics(wireText) {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-sg-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-sg-state-'));
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

test('fixture interleaves staleGuard.recorded and staleGuard.cleared into a normal session', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-stale-guard.jsonl'),
    'utf8',
  );
  // Both 0.38.0 staleGuard rows appear, and recorded carries the persisted
  // path/mtimeMs payload from upstream staleGuardOps.ts.
  assert.ok(wireText.includes('"type":"staleGuard.recorded"'));
  assert.ok(wireText.includes('"type":"staleGuard.cleared"'));
  for (const line of staleGuardRows(wireText)) {
    const row = JSON.parse(line);
    if (row.type === 'staleGuard.recorded') {
      assert.equal(typeof row.path, 'string');
      assert.ok(Number.isFinite(row.mtimeMs));
    }
  }
  // Fixture rows are sanitized: no real user paths or credentials.
  assert.doesNotMatch(wireText, /\/Users\/|\/home\/|[A-Z]:\\/);
  // The non-staleGuard rows must stay byte-identical to the reference wire
  // fixture, so the ignore baseline differs on exactly one axis.
  const reference = fs.readFileSync(path.join(FIXTURES, 'wire-events.jsonl'), 'utf8');
  assert.equal(baselineWithoutStaleGuard(wireText), reference);
});

test('processWireChunk folds staleGuard rows without touching the state', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-stale-guard.jsonl'),
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
  // comparison is limited to what the staleGuard rows could change.
  processWireChunk(state, '{"type":"other"}\n');
  const before = structuredClone(state);
  const rows = staleGuardRows(wireText).join('\n') + '\n';
  assert.doesNotThrow(() => processWireChunk(state, rows));
  assert.deepEqual(state, before);
});

test('persisted staleGuard rows leave metrics, state and render identical to baseline', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-stale-guard.jsonl'),
    'utf8',
  );
  const withRows = makeSessionMetrics(wireText);
  const withoutRows = makeSessionMetrics(baselineWithoutStaleGuard(wireText));

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
});
