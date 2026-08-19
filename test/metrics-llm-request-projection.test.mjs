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
const PROJECTION_ANY = /,"projection":"strict-media-(?:degraded|stripped)"/;

/** The fixture's llm.request rows only: the rows under test. */
function llmRequestRows(wireText) {
  return wireText.split('\n').filter((line) => line && line.includes('"llm.request"'));
}

/** The fixture with projection fields stripped: the ignore baseline. */
function baselineWithoutProjection(wireText) {
  return wireText.replace(new RegExp(PROJECTION_ANY.source, 'g'), '');
}

/** Run one fixture text through the full getMetrics pipeline. */
function makeSessionMetrics(wireText) {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-proj-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-proj-state-'));
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

test('fixture samples both new strict-media projection values on llm.request rows', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-llm-request-projection.jsonl'),
    'utf8',
  );
  assert.ok(wireText.includes('"projection":"strict-media-degraded"'));
  assert.ok(wireText.includes('"projection":"strict-media-stripped"'));
  // Stripping the projection field must reproduce the reference wire
  // fixture byte-identically, so the comparison differs on exactly one axis.
  const reference = fs.readFileSync(path.join(FIXTURES, 'wire-events.jsonl'), 'utf8');
  assert.equal(baselineWithoutProjection(wireText), reference);
});

test('processWireChunk folds llm.request rows identically with and without projection', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-llm-request-projection.jsonl'),
    'utf8',
  );
  const freshState = () => ({
    v: 7,
    agents: {},
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
  });
  const withProjection = freshState();
  const withoutProjection = freshState();
  processWireChunk(withProjection, llmRequestRows(wireText).join('\n') + '\n');
  processWireChunk(
    withoutProjection,
    llmRequestRows(baselineWithoutProjection(wireText)).join('\n') + '\n',
  );
  assert.deepEqual(withProjection, withoutProjection);
});

test('strict-media projection leaves metrics, state and render identical to baseline', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-llm-request-projection.jsonl'),
    'utf8',
  );
  const withRows = makeSessionMetrics(wireText);
  const withoutRows = makeSessionMetrics(baselineWithoutProjection(wireText));

  // The baseline itself still yields the reference readings, so the
  // comparison covers a live, non-empty session.
  assert.equal(withoutRows.metrics.tps, 30);

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
