/**
 * Shared fixture builders for the test suite.
 *
 * Not a test file: node --test collects every .mjs under test/, so the
 * dot-prefix on the filename keeps this module out of the run. It
 * centralizes the wire-row JSON shapes, session directory layouts and render
 * payloads so a host wire-schema change touches exactly one place. Tests bind
 * their own defaults with thin local wrappers when they need a variant.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EVENT_TIME = Date.parse('2026-07-31T00:00:00Z');
export const FRESH_NOW = EVENT_TIME + 60_000;

/**
 * Create a synthetic session directory with one empty wire.jsonl per agent.
 *
 * The host spells the session directory in several ways across versions
 * (`ses_<id>`, `session_<id>`, bare `<id>`) under varying working-directory
 * segments, and the metrics locator must accept all of them — so the shape is
 * parameterized here instead of hardcoded.
 */
export function makeSession({
  tmpPrefix = 'kimi-hud-ses-',
  id = 'abc123',
  wd = 'wd_1',
  prefix = 'ses_',
  agents = ['main'],
  stateDir = false,
  stateTmpPrefix,
} = {}) {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const sessionDir = path.join(sessionsRoot, wd, `${prefix}${id}`);
  const wires = {};
  for (const agent of agents) {
    const dir = path.join(sessionDir, 'agents', agent);
    fs.mkdirSync(dir, { recursive: true });
    wires[agent] = path.join(dir, 'wire.jsonl');
    fs.writeFileSync(wires[agent], '');
  }
  const out = { root: sessionsRoot, sessionsRoot, id, sessionDir, wires, wirePath: wires.main };
  if (stateDir) {
    out.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), stateTmpPrefix ?? `${tmpPrefix}state-`));
    out.statePath = path.join(out.stateDir, `metrics-${id}.json`);
  }
  return out;
}

/**
 * A step.end wire row. `turnId`, `step` and the top-level `agentId` are
 * omitted from the JSON when null, matching the host manifests that predate
 * those fields.
 */
export function stepEnd({
  output,
  streamMs = 1000,
  ttftMs = 500,
  time = EVENT_TIME,
  finishReason = 'end_turn',
  turnId = null,
  step = null,
  agentId = null,
  inputOther = 100,
  inputCacheRead = 300,
  inputCacheCreation = 100,
} = {}) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    ...(agentId === null ? {} : { agentId }),
    event: {
      type: 'step.end',
      ...(turnId === null ? {} : { turnId }),
      ...(step === null ? {} : { step }),
      usage: { inputOther, output, inputCacheRead, inputCacheCreation },
      finishReason,
      llmFirstTokenLatencyMs: ttftMs,
      llmStreamDurationMs: streamMs,
    },
    time,
  });
}

export function turnPrompt(text = 'hello', time = EVENT_TIME, originKind = 'user') {
  return JSON.stringify({
    type: 'turn.prompt',
    input: [{ type: 'text', text }],
    // null originKind models pre-origin records, which were all user prompts.
    ...(originKind === null ? {} : { origin: { kind: originKind } }),
    time,
  });
}

export function llmRequest({ kind = 'loop', time = EVENT_TIME } = {}) {
  return JSON.stringify({ type: 'llm.request', kind, time });
}

export function toolCall({ name = 'AgentSwarm', time = EVENT_TIME } = {}) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'tool.call', turnId: '6', step: 11, toolCallId: 'tool_x', name, args: {} },
    time,
  });
}

export function toolResult({ time = EVENT_TIME } = {}) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'tool.result', turnId: '6', step: 11, toolCallId: 'tool_x', result: {} },
    time,
  });
}

export function turnEnded({ reason = 'completed', time = EVENT_TIME, turnId = 0 } = {}) {
  return JSON.stringify({ type: 'turn.ended', turnId, reason, time });
}

export function compactionBegin({ source = 'manual', time = EVENT_TIME } = {}) {
  return JSON.stringify({ type: 'full_compaction.begin', source, time });
}

export function compactionComplete({ time = EVENT_TIME } = {}) {
  return JSON.stringify({ type: 'full_compaction.complete', time });
}

export function compactionCancel({ time = EVENT_TIME } = {}) {
  return JSON.stringify({ type: 'full_compaction.cancel', time });
}

/**
 * A legacy-v7 metrics state fixture: the shape a running HUD persists before
 * the newer top-level projections (tasks, tower, sessionUsage…) exist.
 */
export function makeMetricsState(overrides = {}) {
  return {
    v: 7,
    agents: {},
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
    ...overrides,
  };
}

export function basePayload(overrides = {}) {
  return {
    model: 'K3',
    cwd: '/workspace/kimi-code-hud',
    gitBranch: 'main',
    permissionMode: 'manual',
    planMode: false,
    sessionId: 'abc123',
    ...overrides,
  };
}

export function baseCtx(overrides = {}) {
  return {
    payload: basePayload(),
    metrics: { tps: 47, ttftMs: 1300 },
    gitDirty: false,
    color: false,
    ...overrides,
  };
}
