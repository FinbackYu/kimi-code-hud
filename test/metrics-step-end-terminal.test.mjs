import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMetrics, processWireChunk } from '../src/metrics.mjs';
import { renderHud } from '../src/render.mjs';
import { applySessionUsageRow } from '../src/session-usage.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = 1785456060000;
const TERMINAL_RE = /"finishReason":"(?:error|interrupted)"/;
const SENSITIVE_PATTERN =
  /\/Users\/\S+|\/home\/\S+|[A-Z]:\\Users\\\S+|access_token|authorization|bearer\s+\S+|cookie\s*[:=]/i;

const WIRE_TEXT = fs.readFileSync(
  path.join(FIXTURES, 'wire-events-step-end-terminal.jsonl'),
  'utf8',
);
const REFERENCE = fs.readFileSync(path.join(FIXTURES, 'wire-events.jsonl'), 'utf8');

/**
 * The fixture's error/interrupted step.end rows only: the rows under test.
 * Upstream PR #3095 (MoonshotAI/kimi-code) makes failed or interrupted steps
 * append a step.end with finishReason 'error' | 'interrupted'. Its catch
 * branch carries no usage or timing fields at all; the fixture deliberately
 * gives the rows complete-but-zero usage fields, so the regression locks the
 * stronger guarantee: even when such a row does carry usage, no HUD
 * projection may change (a non-zero step.end usage would legitimately feed
 * the TPS and cache counters, so zero is the only shape that keeps the
 * ignore baseline comparison on exactly one axis).
 */
function terminalRows(wireText) {
  return wireText.split('\n').filter((line) => line && TERMINAL_RE.test(line));
}

/** The fixture with the terminal rows stripped: the ignore baseline. */
function baselineWithoutTerminal(wireText) {
  return wireText.split('\n').filter((line) => !TERMINAL_RE.test(line)).join('\n');
}

/** Run one fixture text through the full getMetrics pipeline. */
function makeSessionMetrics(wireText) {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-step-end-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-step-end-state-'));
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

const freshState = () => ({
  v: 7,
  agents: {},
  modelAlias: null,
  thinkingLevel: null,
  goal: null,
  swarmMode: false,
});

test('fixture adds exactly one error and one interrupted step.end to the reference wire', () => {
  const terminal = terminalRows(WIRE_TEXT);
  assert.equal(terminal.length, 2);
  assert.ok(terminal.some((line) => line.includes('"finishReason":"error"')));
  assert.ok(terminal.some((line) => line.includes('"finishReason":"interrupted"')));
  // Stripping the terminal rows must reproduce the reference wire fixture
  // byte-identically, so the comparison differs on exactly one axis.
  assert.equal(baselineWithoutTerminal(WIRE_TEXT), REFERENCE);
  assert.doesNotMatch(WIRE_TEXT, SENSITIVE_PATTERN);
  assert.doesNotMatch(WIRE_TEXT, /"input"\s*:/);
});

test('terminal step.end rows never fold into the session usage ledger', () => {
  const agentUsage = { reader: {}, byModel: {} };
  for (const line of terminalRows(WIRE_TEXT)) {
    assert.equal(applySessionUsageRow(agentUsage, JSON.parse(line)), false);
  }
  assert.deepEqual(agentUsage.byModel, {});
});

test('terminal step.end rows do not close a subagent turn; end_turn still does', () => {
  // A subagent's wire never carries turn.ended, so its closing end_turn
  // step.end is the only turn-end marker (metrics-turn). An error or
  // interrupted step.end must leave the bucket untouched.
  const withRows = freshState();
  const withoutRows = freshState();
  processWireChunk(withRows, WIRE_TEXT, 'sub');
  processWireChunk(withoutRows, baselineWithoutTerminal(WIRE_TEXT), 'sub');
  assert.deepEqual(withRows, withoutRows);
  assert.equal(withRows.agents.sub.lastTurnEndAt, null);

  // Positive control: the same terminal rows followed by a real closing
  // end_turn step.end still settle the turn at the end_turn row only.
  const endTurnLine = JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      turnId: 'redacted',
      usage: { inputOther: 100, output: 40, inputCacheRead: 300, inputCacheCreation: 100 },
      finishReason: 'end_turn',
      llmFirstTokenLatencyMs: 700,
      llmStreamDurationMs: 1000,
    },
    time: 1785456007500,
  });
  const withEndTurn = freshState();
  const withoutEndTurn = freshState();
  processWireChunk(withEndTurn, terminalRows(WIRE_TEXT).join('\n') + '\n' + endTurnLine + '\n', 'sub');
  processWireChunk(withoutEndTurn, endTurnLine + '\n', 'sub');
  assert.deepEqual(withEndTurn, withoutEndTurn);
  assert.equal(withEndTurn.agents.sub.lastTurnEndAt, 1785456007500);
});

test('terminal step.end rows leave metrics, state and render identical to the reference sequence', () => {
  const withRows = makeSessionMetrics(WIRE_TEXT);
  const withoutRows = makeSessionMetrics(baselineWithoutTerminal(WIRE_TEXT));

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
