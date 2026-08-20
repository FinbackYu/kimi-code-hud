import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMetrics, processWireChunk } from '../src/metrics.mjs';
import { renderHud } from '../src/render.mjs';

/**
 * Regression fixture for the upstream wire manifest's `agentId` field
 * (MoonshotAI/kimi-code#3103): every durable payload now carries a required
 * top-level `agentId: string`. The HUD must keep folding rows identically —
 * unknown fields are ignored and none of the reducers may key off agentId.
 * The fixture is the reference wire fixture plus the remaining consumed
 * record classes, each row stamped with the field exactly where the manifest
 * places it (right after `_name`/type, before `time`).
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = 1785456060000;
const AGENT_ID_FIELD = ',"agentId":"redacted"';
const SENSITIVE_PATTERN =
  /\/Users\/\S+|\/home\/\S+|[A-Z]:\\Users\\\S+|access_token|authorization|bearer\s+\S+|cookie\s*[:=]/i;

/** The fixture with every top-level agentId field stripped: the baseline. */
function baselineWithoutAgentId(wireText) {
  return wireText.split(AGENT_ID_FIELD).join('');
}

/** The fixture's non-empty rows. */
function rows(wireText) {
  return wireText.split('\n').filter((line) => line);
}

/** The set of record types present in a wire text. */
function rowTypes(wireText) {
  return new Set(rows(wireText).map((line) => JSON.parse(line).type));
}

/** Run one fixture text through the full getMetrics pipeline. */
function makeSessionMetrics(wireText) {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-agent-id-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-agent-id-state-'));
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

test('fixture stamps every row with a top-level agentId and covers all consumed record classes', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-agent-id.jsonl'),
    'utf8',
  );
  const reference = fs.readFileSync(path.join(FIXTURES, 'wire-events.jsonl'), 'utf8');

  // Every row carries the top-level agentId right after its type, mirroring
  // the manifest payload order (_name, agentId, …, time).
  for (const line of rows(wireText)) {
    assert.match(line, /"type":"[a-z_.]+","agentId":"redacted"/);
  }

  // Stripping agentId must reproduce the reference wire fixture exactly,
  // with the extra record classes appended, so the comparison in the other
  // tests differs on exactly one axis.
  assert.ok(baselineWithoutAgentId(wireText).startsWith(reference));

  // All record classes the HUD reducers consume (Issue #17 scope).
  assert.deepEqual(
    [...rowTypes(baselineWithoutAgentId(wireText))].sort(),
    [
      'config.update',
      'context.append_loop_event',
      'full_compaction.begin',
      'full_compaction.cancel',
      'full_compaction.complete',
      'goal.clear',
      'goal.create',
      'goal.update',
      'llm.request',
      'swarm_mode.enter',
      'swarm_mode.exit',
      'task.started',
      'task.terminated',
      'turn.cancel',
      'turn.ended',
      'turn.prompt',
    ],
  );
});

test('processWireChunk folds every row identically with and without agentId', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-agent-id.jsonl'),
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
  const withAgentId = freshState();
  const withoutAgentId = freshState();
  processWireChunk(withAgentId, wireText);
  processWireChunk(withoutAgentId, baselineWithoutAgentId(wireText));
  assert.deepEqual(withAgentId, withoutAgentId);
});

test('top-level agentId leaves metrics, state and render identical to baseline', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-agent-id.jsonl'),
    'utf8',
  );
  const withRows = makeSessionMetrics(wireText);
  const withoutRows = makeSessionMetrics(baselineWithoutAgentId(wireText));

  // The baseline itself still yields the full live readings — including the
  // appended record classes — so the comparison covers a session where every
  // reducer contributed.
  assert.equal(withoutRows.metrics.tps, 30);
  assert.deepEqual(withoutRows.metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });
  assert.equal(withoutRows.metrics.modelAlias, 'kimi-code/k3');
  assert.equal(withoutRows.metrics.thinkingLevel, 'high');
  assert.equal(withoutRows.metrics.compactionMs, 400);
  assert.deepEqual(withoutRows.metrics.tasks, { bash: 1, agents: 0 });

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

test('fixture stays sanitized: no paths, credentials or user content', () => {
  const wireText = fs.readFileSync(
    path.join(FIXTURES, 'wire-events-agent-id.jsonl'),
    'utf8',
  );
  assert.doesNotMatch(wireText, SENSITIVE_PATTERN);
  assert.doesNotMatch(wireText, /"input"\s*:/);
  // Synthetic timestamps only: every row sits on the reference fixture's
  // synthetic axis (1785456000000…1785456060000), never a real-world time.
  for (const line of rows(wireText)) {
    const time = JSON.parse(line).time;
    assert.ok(Number.isInteger(time));
    assert.ok(time >= 1785456000000 && time <= 1785456060000);
  }
});
