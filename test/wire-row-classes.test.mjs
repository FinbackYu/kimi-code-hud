import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMetrics, processWireChunk } from '../src/metrics.mjs';
import { renderHud } from '../src/render.mjs';
import { applySessionUsageRow } from '../src/session-usage.mjs';
import { makeMetricsState, makeSession } from './.helpers.mjs';

/**
 * Neutral-row-class regressions. Upstream keeps adding wire record classes
 * and fields (persisted staleGuard rows, llm.request projection values,
 * token_counting rows, terminal error/interrupted step.end, the required
 * top-level agentId of MoonshotAI/kimi-code#3103). None of them may change
 * any HUD projection, so each scenario below proves its rows are ignored by
 * folding a fixture and its stripped baseline through the same pipeline and
 * comparing metrics, persisted state and rendered lines.
 *
 * Every scenario adds exactly one axis on top of the shared reference wire
 * fixture `wire-events.jsonl`, so each baseline differs from its fixture on
 * that axis alone.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = 1785456060000;
const REFERENCE = fs.readFileSync(path.join(FIXTURES, 'wire-events.jsonl'), 'utf8');
const SENSITIVE_PATTERN =
  /\/Users\/\S+|\/home\/\S+|[A-Z]:\\Users\\\S+|access_token|authorization|bearer\s+\S+|cookie\s*[:=]/i;

/** Run one fixture text through the full getMetrics pipeline. */
function makeSessionMetrics(wireText) {
  const { sessionsRoot, stateDir, id, sessionDir } = makeSession({
    tmpPrefix: 'kimi-hud-row-class-',
    wd: 'workspace-redacted',
    stateDir: true,
  });
  fs.writeFileSync(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), wireText);
  const metrics = getMetrics(id, { sessionsRoot, stateDir, now: NOW });
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `metrics-${id}.json`), 'utf8'));
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

const freshState = () => makeMetricsState();

const SCENARIOS = [
  {
    label: 'staleGuard rows',
    fixture: 'wire-events-stale-guard.jsonl',
    fixtureTitle:
      'fixture interleaves staleGuard.recorded and staleGuard.cleared into a normal session',
    fold: 'noop',
    foldTitle: 'processWireChunk folds staleGuard rows without touching the state',
    baselineTitle: 'persisted staleGuard rows leave metrics, state and render identical to baseline',
    rowsUnder(wireText) {
      return wireText.split('\n').filter((line) => line && /"type":"staleGuard\./.test(line));
    },
    baseline(wireText) {
      return wireText
        .split('\n')
        .filter((line) => line && !/"type":"staleGuard\./.test(line))
        .join('\n') + '\n';
    },
    fixtureChecks(wireText, baselineText) {
      // Both 0.38.0 staleGuard rows appear, and recorded carries the persisted
      // path/mtimeMs payload from upstream staleGuardOps.ts.
      assert.ok(wireText.includes('"type":"staleGuard.recorded"'));
      assert.ok(wireText.includes('"type":"staleGuard.cleared"'));
      for (const line of this.rowsUnder(wireText)) {
        const row = JSON.parse(line);
        if (row.type === 'staleGuard.recorded') {
          assert.equal(typeof row.path, 'string');
          assert.ok(Number.isFinite(row.mtimeMs));
        }
      }
      // Fixture rows are sanitized: no real user paths or credentials.
      assert.doesNotMatch(wireText, /\/Users\/|\/home\/|[A-Z]:\\/);
      assert.equal(baselineText, REFERENCE);
    },
    baselineReadings(metrics) {
      assert.equal(metrics.tps, 30);
      assert.deepEqual(metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });
    },
  },
  {
    label: 'strict-media projection',
    fixture: 'wire-events-llm-request-projection.jsonl',
    fixtureTitle: 'fixture samples both new strict-media projection values on llm.request rows',
    fold: 'equivalence',
    foldRows: 'under',
    foldTitle: 'processWireChunk folds llm.request rows identically with and without projection',
    baselineTitle: 'strict-media projection leaves metrics, state and render identical to baseline',
    rowsUnder(wireText) {
      return wireText.split('\n').filter((line) => line && line.includes('"llm.request"'));
    },
    baseline(wireText) {
      return wireText.replace(/,"projection":"strict-media-(?:degraded|stripped)"/g, '');
    },
    fixtureChecks(wireText, baselineText) {
      assert.ok(wireText.includes('"projection":"strict-media-degraded"'));
      assert.ok(wireText.includes('"projection":"strict-media-stripped"'));
      // Stripping the projection field must reproduce the reference wire
      // fixture byte-identically, so the comparison differs on exactly one axis.
      assert.equal(baselineText, REFERENCE);
    },
    baselineReadings(metrics) {
      assert.equal(metrics.tps, 30);
    },
  },
  {
    label: 'token_counting rows',
    fixture: 'wire-events-token-counting.jsonl',
    fixtureTitle: 'fixture mixes all three persisted token_counting row types into a normal session',
    fold: 'noop',
    foldTitle: 'processWireChunk folds token_counting rows without touching the state',
    baselineTitle:
      'persisted token_counting rows leave metrics, state and render identical to baseline',
    rowsUnder(wireText) {
      return wireText.split('\n').filter((line) => line && /"type":"token_counting\./.test(line));
    },
    baseline(wireText) {
      return wireText
        .split('\n')
        .filter((line) => line && !/"type":"token_counting\./.test(line))
        .join('\n') + '\n';
    },
    fixtureChecks(wireText, baselineText) {
      for (const type of ['measured', 'truncated', 'rebased']) {
        assert.ok(wireText.includes(`"type":"token_counting.${type}"`));
      }
      // The non-token-counting rows must stay byte-identical to the reference
      // wire fixture, so the ignore baseline differs on exactly one axis.
      assert.equal(baselineText, REFERENCE);
    },
    baselineReadings(metrics) {
      assert.equal(metrics.tps, 30);
      assert.deepEqual(metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });
    },
    renderChecks(rendered) {
      // The rows must not leak into badge state either: no [swarm] badge.
      assert.ok(rendered.every((line) => !line.includes('[swarm]')));
    },
  },
  {
    label: 'terminal step.end rows',
    fixture: 'wire-events-step-end-terminal.jsonl',
    fixtureTitle: 'fixture adds exactly one error and one interrupted step.end to the reference wire',
    baselineTitle:
      'terminal step.end rows leave metrics, state and render identical to the reference sequence',
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
    rowsUnder(wireText) {
      return wireText.split('\n').filter((line) => line && /"finishReason":"(?:error|interrupted)"/.test(line));
    },
    baseline(wireText) {
      return wireText
        .split('\n')
        .filter((line) => !/"finishReason":"(?:error|interrupted)"/.test(line))
        .join('\n');
    },
    fixtureChecks(wireText, baselineText) {
      const terminal = this.rowsUnder(wireText);
      assert.equal(terminal.length, 2);
      assert.ok(terminal.some((line) => line.includes('"finishReason":"error"')));
      assert.ok(terminal.some((line) => line.includes('"finishReason":"interrupted"')));
      assert.equal(baselineText, REFERENCE);
      assert.doesNotMatch(wireText, SENSITIVE_PATTERN);
      assert.doesNotMatch(wireText, /"input"\s*:/);
    },
    baselineReadings(metrics) {
      assert.equal(metrics.tps, 30);
    },
  },
  {
    /**
     * Regression fixture for the upstream wire manifest's `agentId` field
     * (MoonshotAI/kimi-code#3103): every durable payload now carries a required
     * top-level `agentId: string`. The HUD must keep folding rows identically —
     * unknown fields are ignored and none of the reducers may key off agentId.
     * The fixture is the reference wire fixture plus the remaining consumed
     * record classes, each row stamped with the field exactly where the manifest
     * places it (right after `_name`/type, before `time`).
     */
    label: 'top-level agentId',
    fixture: 'wire-events-agent-id.jsonl',
    fixtureTitle:
      'fixture stamps every row with a top-level agentId and covers all consumed record classes',
    fold: 'equivalence',
    foldRows: 'all',
    foldTitle: 'processWireChunk folds every row identically with and without agentId',
    baselineTitle: 'top-level agentId leaves metrics, state and render identical to baseline',
    agentIdField: ',"agentId":"redacted"',
    rowsUnder(wireText) {
      return wireText.split('\n').filter((line) => line);
    },
    baseline(wireText) {
      return wireText.split(this.agentIdField).join('');
    },
    fixtureChecks(wireText, baselineText) {
      // Every row carries the top-level agentId right after its type, mirroring
      // the manifest payload order (_name, agentId, …, time).
      for (const line of this.rowsUnder(wireText)) {
        assert.match(line, /"type":"[a-z_.]+","agentId":"redacted"/);
      }

      // Stripping agentId must reproduce the reference wire fixture exactly,
      // with the extra record classes appended, so the comparison in the other
      // tests differs on exactly one axis.
      assert.ok(baselineText.startsWith(REFERENCE));

      // All record classes the HUD reducers consume (Issue #17 scope).
      const rowTypes = new Set(baselineText.split('\n').filter(Boolean).map((line) => JSON.parse(line).type));
      assert.deepEqual(
        [...rowTypes].sort(),
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
    },
    baselineReadings(metrics) {
      // The baseline itself still yields the full live readings — including the
      // appended record classes — so the comparison covers a session where every
      // reducer contributed.
      assert.equal(metrics.tps, 30);
      assert.deepEqual(metrics.cache, { hitRate: 0.6, readTokens: 900, inputTokens: 1500 });
      assert.equal(metrics.modelAlias, 'kimi-code/k3');
      assert.equal(metrics.thinkingLevel, 'high');
      assert.equal(metrics.compactionMs, 400);
      assert.deepEqual(metrics.tasks, { bash: 1, agents: 0 });
    },
  },
];

const readFixture = (scenario) => fs.readFileSync(path.join(FIXTURES, scenario.fixture), 'utf8');

for (const scenario of SCENARIOS) {
  test(scenario.fixtureTitle, () => {
    const wireText = readFixture(scenario);
    scenario.fixtureChecks(wireText, scenario.baseline(wireText));
  });

  if (scenario.fold === 'noop') {
    test(scenario.foldTitle, () => {
      const wireText = readFixture(scenario);
      const state = freshState();
      // Establish the normalized main bucket first, so the before/after
      // comparison is limited to what the rows under test could change.
      processWireChunk(state, '{"type":"other"}\n');
      const before = structuredClone(state);
      const rows = scenario.rowsUnder(wireText).join('\n') + '\n';
      assert.doesNotThrow(() => processWireChunk(state, rows));
      assert.deepEqual(state, before);
    });
  }

  if (scenario.fold === 'equivalence') {
    test(scenario.foldTitle, () => {
      const wireText = readFixture(scenario);
      const textWithRows =
        scenario.foldRows === 'under' ? scenario.rowsUnder(wireText).join('\n') + '\n' : wireText;
      const baselineText = scenario.baseline(wireText);
      const textWithoutRows =
        scenario.foldRows === 'under'
          ? scenario.rowsUnder(baselineText).join('\n') + '\n'
          : baselineText;
      const withRows = freshState();
      const withoutRows = freshState();
      processWireChunk(withRows, textWithRows);
      processWireChunk(withoutRows, textWithoutRows);
      assert.deepEqual(withRows, withoutRows);
    });
  }

  test(scenario.baselineTitle, () => {
    const wireText = readFixture(scenario);
    const withRows = makeSessionMetrics(wireText);
    const withoutRows = makeSessionMetrics(scenario.baseline(wireText));

    // The baseline itself still yields the reference readings, so the
    // comparison covers a live, non-empty session.
    scenario.baselineReadings(withoutRows.metrics);

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
    scenario.renderChecks?.(rendered);
  });
}

// --- terminal step.end specifics, beyond the shared baseline comparison ---

const TERMINAL = SCENARIOS.find((scenario) => scenario.label === 'terminal step.end rows');
const terminalWireText = readFixture(TERMINAL);
const terminalRows = (wireText) => TERMINAL.rowsUnder(wireText);
const baselineWithoutTerminal = (wireText) => TERMINAL.baseline(wireText);

test('terminal step.end rows never fold into the session usage ledger', () => {
  const agentUsage = { reader: {}, byModel: {} };
  for (const line of terminalRows(terminalWireText)) {
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
  processWireChunk(withRows, terminalWireText, 'sub');
  processWireChunk(withoutRows, baselineWithoutTerminal(terminalWireText), 'sub');
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
  processWireChunk(
    withEndTurn,
    terminalRows(terminalWireText).join('\n') + '\n' + endTurnLine + '\n',
    'sub',
  );
  processWireChunk(withoutEndTurn, endTurnLine + '\n', 'sub');
  assert.deepEqual(withEndTurn, withoutEndTurn);
  assert.equal(withEndTurn.agents.sub.lastTurnEndAt, 1785456007500);
});

// --- agentId fixture sanitization ---

test('fixture stays sanitized: no paths, credentials or user content', () => {
  const wireText = readFixture(SCENARIOS.find((scenario) => scenario.label === 'top-level agentId'));
  assert.doesNotMatch(wireText, SENSITIVE_PATTERN);
  assert.doesNotMatch(wireText, /"input"\s*:/);
  // Synthetic timestamps only: every row sits on the reference fixture's
  // synthetic axis (1785456000000…1785456060000), never a real-world time.
  for (const line of wireText.split('\n').filter((line) => line)) {
    const time = JSON.parse(line).time;
    assert.ok(Number.isInteger(time));
    assert.ok(time >= 1785456000000 && time <= 1785456060000);
  }
});
