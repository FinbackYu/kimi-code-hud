import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { emptyAgent, normAgent } from './metrics-agent.mjs';
import { applyCompactionRow } from './metrics-compaction.mjs';
import {
  BACKFILL_SCAN_V,
  CACHE_BACKFILL_MAX_BYTES,
  CACHE_SCAN_V,
} from './metrics-constants.mjs';
import { median } from './metrics-math.mjs';
import { applySessionMetaRow } from './metrics-session-meta.mjs';
import {
  MIGRATED,
  emptyState,
  loadState,
  saveState,
  statePathFor,
} from './metrics-state.mjs';
import { applyThroughputRow } from './metrics-throughput.mjs';
import { applyTurnRow } from './metrics-turn.mjs';
import { summarizeMetrics } from './metrics-summary.mjs';
import { HUD_DIR, SESSIONS_ROOT } from './paths.mjs';
import {
  findSessionDir,
  findWirePath,
  resolveSessionDir,
} from './session-locator.mjs';
import {
  AGENT_WIRE_SLICE_BYTES,
  BACKFILL_WIRE_SLICE_BYTES,
  MAIN_WIRE_SLICE_BYTES,
  WIRE_READ_BUDGET_BYTES,
  readBoundedWire,
  wireTailMarker,
  wireTailMatches,
} from './wire-reader.mjs';
import { applyGoalOp } from './goal.mjs';
import {
  applyCacheWireRow,
  resetCacheState,
} from './cache-hit.mjs';
import {
  applyTaskRow,
  reconcileTaskSidecars,
  resetWireTasks,
} from './metrics-tasks.mjs';
import {
  advanceSessionUsageAgent,
  normalizeSessionUsageState,
} from './session-usage.mjs';

export { SESSIONS_ROOT, findSessionDir, findWirePath, CACHE_BACKFILL_MAX_BYTES, median };

/**
 * Fold one parsed wire row into the metrics state. Rows are bucketed per
 * agent: llm.request/step.end/full_compaction.complete/turn.cancel/turn.ended
 * drive the in-flight generation flag, step.end adds TPS samples and TTFT, and
 * full_compaction.begin/complete/cancel anchor the compaction timer (main
 * agent only, and only between turns — a mid-turn auto-compaction is not
 * tracked). The main agent additionally feeds the state-level handlers —
 * the session cache counters, config.update (model alias + thinking level),
 * goal ops, the background-task registry and the swarm_mode.enter/exit
 * journal.
 * @param {object} state mutated in place
 * @param {object} row parsed wire.jsonl line
 * @param {string} [agent] which agent's wire this row comes from
 */
export function processWireRow(state, row, agent = 'main') {
  if (!state.agents || typeof state.agents !== 'object') state.agents = {};
  state.agents[agent] = normAgent(state.agents[agent]);
  if (agent === 'main') applyCacheWireRow(state, row);
  if (agent === 'main') applyTaskRow(state, row);
  applyTurnRow(state, row, agent);
  applyThroughputRow(state, row, agent);
  applyCompactionRow(state, row, agent);
  applySessionMetaRow(state, row, agent);
  if (
    agent === 'main' && (
      row?.type === 'goal.create' ||
      row?.type === 'goal.update' ||
      row?.type === 'goal.clear' ||
      row?.type === 'forked'
    )
  ) {
    state.goal = applyGoalOp(state.goal ?? null, row);
  }
}

function isCacheBackfillLine(line) {
  return (
    line.includes('"type":"turn.prompt"') ||
    (
      line.includes('"type":"context.append_loop_event"') &&
      line.includes('"type":"step.end"')
    )
  );
}

/**
 * Rebuild the session-cumulative cache counters from the bounded tail before
 * the saved metrics byte offset. The read is capped so an upgrade cannot turn
 * the 300ms hot path into an unbounded historical scan. Every complete
 * step.end in the tail counts, so no prompt-boundary alignment is needed.
 * A read cut short by the frame budget leaves the done marker unset so a
 * later frame with a larger budget can finish the scan; only a complete read
 * (or one stopped by the hard cap) is marked done.
 */
function restoreCacheState(wirePath, state, maxBytes = CACHE_BACKFILL_MAX_BYTES) {
  const end = Math.max(0, Math.floor(state.agents?.main?.offset ?? 0));
  const budget = Math.max(0, Math.floor(maxBytes));
  if (end > 0 && budget === 0) return 0;
  resetCacheState(state);
  if (end === 0) {
    state.cacheScanV = CACHE_SCAN_V;
    return 0;
  }

  const len = Math.min(end, CACHE_BACKFILL_MAX_BYTES, budget);
  const start = end - len;
  const fd = fs.openSync(wirePath, 'r');
  let text;
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }

  // A bounded tail commonly begins in the middle of a JSONL row. Discard it
  // rather than risk parsing a partial prompt or usage object.
  if (start > 0) {
    const firstNl = text.indexOf('\n');
    text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
  }
  const lastNl = text.lastIndexOf('\n');
  text = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';

  for (const line of text.split('\n')) {
    if (!line || !isCacheBackfillLine(line)) continue;
    try {
      applyCacheWireRow(state, JSON.parse(line));
    } catch {
      // keep scanning the bounded tail
    }
  }
  // A frame budget smaller than the scan window leaves older history unread.
  // Skip the done marker so a later frame with a larger budget can finish the
  // scan; a read capped only by CACHE_BACKFILL_MAX_BYTES is final, because a
  // retry would hit the same hard cap.
  if (len === end || len === CACHE_BACKFILL_MAX_BYTES) {
    state.cacheScanV = CACHE_SCAN_V;
  }
  return len;
}

/** True when a raw line might carry a backfill-tracked key (cheap prefilter). */
function isBackfillLine(line) {
  return (
    line.includes('"thinkingEffort"') ||
    line.includes('"thinkingLevel"') ||
    line.includes('"modelAlias"') ||
    line.includes('"type":"goal.') ||
    line.includes('"type":"forked"') ||
    line.includes('"type":"swarm_mode.') ||
    line.includes('"type":"turn.prompt"') ||
    line.includes('"type":"turn.cancel"') ||
    line.includes('"type":"turn.ended"') ||
    line.includes('"type":"full_compaction.') ||
    line.includes('"finishReason":"end_turn"')
  );
}

/**
 * Feed a text chunk of wire.jsonl lines into the metrics state.
 * Only complete lines (terminated by \n) are consumed; the caller tracks
 * the byte offset so an incomplete tail is retried next run.
 * @param {object} state mutated in place
 * @param {string} text complete lines only
 * @param {string} [agent] which agent's wire this chunk comes from
 */
export function processWireChunk(state, text, agent = 'main') {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    processWireRow(state, row, agent);
  }
}

function newBackfill(fileId, targetOffset, state) {
  const reader = emptyAgent();
  reader.fileId = fileId;
  const shadow = emptyState();
  shadow.modelAlias = state.modelAlias ?? null;
  shadow.thinkingLevel = state.thinkingLevel ?? null;
  shadow.goal = state.goal ? { ...state.goal } : null;
  shadow.swarmMode = state.swarmMode === true;
  if (state.agents?.main) {
    const source = normAgent(state.agents.main);
    const target = emptyAgent();
    for (const key of [
      'lastTurnPromptAt',
      'lastTurnEndAt',
      'lastCompactionBeginAt',
      'lastCompactionEndAt',
      'lastCompactionMs',
    ]) {
      target[key] = source[key];
    }
    shadow.agents.main = target;
  }
  return {
    version: BACKFILL_SCAN_V,
    fileId,
    targetOffset,
    reader,
    shadow,
  };
}

function foldBackfillChunk(shadow, text) {
  for (const line of text.split('\n')) {
    if (!line || !isBackfillLine(line)) continue;
    try {
      const row = JSON.parse(line);
      if (
        row?.type === 'turn.prompt' ||
        row?.type === 'turn.cancel' ||
        row?.type === 'turn.ended' ||
        row?.type === 'context.append_loop_event'
      ) {
        applyTurnRow(shadow, row, 'main');
      } else {
        processWireRow(shadow, row, 'main');
      }
    } catch {
      // A malformed historical row does not block later projection rows.
    }
  }
}

function installBackfillProjection(state, shadow) {
  state.modelAlias = shadow.modelAlias ?? null;
  state.thinkingLevel = shadow.thinkingLevel ?? null;
  state.goal = shadow.goal ?? null;
  state.swarmMode = shadow.swarmMode === true;
  const source = normAgent(shadow.agents?.main);
  const target = normAgent(state.agents?.main);
  state.agents.main = target;
  for (const key of [
    'lastTurnPromptAt',
    'lastTurnEndAt',
    'lastCompactionBeginAt',
    'lastCompactionEndAt',
    'lastCompactionMs',
  ]) {
    target[key] = source[key];
  }
}

/** Advance the replacement projection without disturbing the visible one. */
function advanceBackfill(wirePath, state, fileId, targetOffset, maxBytes) {
  if ((state.backfillScanV ?? 0) >= BACKFILL_SCAN_V) {
    state.backfill = null;
    return { bytesRead: 0, changed: false };
  }
  if (targetOffset <= 0) {
    state.backfillScanV = BACKFILL_SCAN_V;
    state.backfill = null;
    return { bytesRead: 0, changed: true };
  }
  if (!state.backfill || state.backfill.fileId !== fileId) {
    state.backfill = newBackfill(fileId, targetOffset, state);
  }
  const backfill = state.backfill;
  backfill.targetOffset = Math.max(backfill.targetOffset, targetOffset);
  if (maxBytes <= 0) return { bytesRead: 0, changed: true };

  const result = readBoundedWire(
    wirePath,
    backfill.reader,
    backfill.targetOffset,
    maxBytes,
  );
  if (result.text) foldBackfillChunk(backfill.shadow, result.text);
  const caughtUp =
    backfill.reader.offset >= backfill.targetOffset &&
    backfill.reader.pendingBase64 === '';
  if (caughtUp) {
    installBackfillProjection(state, backfill.shadow);
    state.backfillScanV = BACKFILL_SCAN_V;
    state.backfill = null;
  }
  return { bytesRead: result.bytesRead, changed: true };
}

function resetMainDerivedState(state) {
  state.goal = null;
  state.thinkingLevel = null;
  state.modelAlias = null;
  state.swarmMode = false;
  resetCacheState(state);
  resetWireTasks(state);
  state.cacheScanV = CACHE_SCAN_V;
  state.backfillScanV = BACKFILL_SCAN_V;
  state.backfill = null;
}

function enumerateWires(sessionDir) {
  const agentsDir = path.join(sessionDir, 'agents');
  const wires = [];
  try {
    for (const ent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const wirePath = path.join(agentsDir, ent.name, 'wire.jsonl');
      try {
        if (fs.statSync(wirePath).isFile()) wires.push({ agent: ent.name, path: wirePath });
      } catch {
        // An agent may exist before its wire is created.
      }
    }
  } catch {
    return [];
  }
  wires.sort((a, b) => (
    a.agent === 'main' ? -1 : b.agent === 'main' ? 1 : a.agent.localeCompare(b.agent)
  ));
  return wires;
}

function prepareWire(state, descriptor) {
  try {
    const stat = fs.statSync(descriptor.path);
    const fileId = `${stat.dev}:${stat.ino}`;
    const isNew = !state.agents[descriptor.agent];
    let bucket = normAgent(state.agents[descriptor.agent]);
    state.agents[descriptor.agent] = bucket;
    let changed = isNew;
    const replaced =
      bucket.offset > stat.size ||
      (bucket.fileId !== null && bucket.fileId !== fileId) ||
      (bucket.fileId === fileId && !wireTailMatches(descriptor.path, bucket));
    if (replaced) {
      bucket = emptyAgent();
      state.agents[descriptor.agent] = bucket;
      if (descriptor.agent === 'main') resetMainDerivedState(state);
      changed = true;
    }
    if (bucket.fileId !== fileId) {
      bucket.fileId = fileId;
      changed = true;
    }
    if (bucket.offset > 0 && bucket.tailMarker === null) {
      bucket.tailMarker = wireTailMarker(descriptor.path, bucket.offset);
      changed = true;
    }
    return { ...descriptor, stat, fileId, bucket, changed };
  } catch {
    return null;
  }
}

function deadlineOpen(deadline) {
  return !Number.isFinite(deadline) || performance.now() < deadline;
}

function finishMetrics(state, statePath, stateChanged, now, agentNames = null) {
  const summary = summarizeMetrics(state, { now, agentNames });
  if (stateChanged || summary.changed) saveState(statePath, state);
  return summary.metrics;
}

/**
 * Incrementally read the session's wire logs (main agent + every subagent)
 * and return current speed metrics, thinking level, goal/swarm state and
 * cache usage.
 *
 * Samples are timestamped and bucketed per agent: only the freshest
 * MAX_SAMPLES within SAMPLE_WINDOW_MS feed an agent's median, so resume
 * continuations, long idle gaps and compactions never mix stale numbers in.
 * Agents with a request in flight or a sample newer than ACTIVE_WINDOW_MS
 * count as active, except that a subagent whose turn has ended drops out
 * immediately (its wire's closing end_turn step.end settles it, so finished
 * swarm members never linger in the head count): with several active
 * (swarm/subagent runs) the result
 * carries the fleet total (`tpsTotal`), the per-agent average (`tps`) and
 * the head counts, and TTFT is the median across active agents so one
 * stuck agent cannot poison the display. A single live agent with a speed
 * reading reports `tpsTotal`/`tpsAgents` too (1 × `tps`), so a swarm that
 * has run down to its last subagent keeps the fleet display. `activeAgents`
 * counts every live
 * agent (the gen-ticker head count); `tpsAgents` counts only those with a
 * fresh speed reading, so an agent still waiting on its first step never
 * inflates the fleet figure and `tpsTotal ≈ tpsAgents × tps` always holds;
 * `mainActive`/`mainSpeed` flag whether the main agent feeds those counts,
 * so the renderer can label the head count "main+N" instead of letting it
 * pass as a pure subagent figure. A single active
 * agent keeps the hardened MIN_SAMPLES gate; an idle session falls back to
 * the last full-window median (flagged stale). `turnStartedAt` anchors the
 * live timer at the user's latest prompt (turn.prompt) until the turn ends
 * (turn.ended, or the legacy end_turn / active turn.cancel fallbacks).
 * `compactingSince`/`compactionMs` mirror the full_compaction journal: a
 * begin without a close anchors the live compaction timer (expires after
 * SAMPLE_WINDOW_MS when the close record was lost), and the finished
 * duration survives until the next prompt starts a turn. Compactions that
 * run inside a turn (auto-compaction) are never tracked — the turn timer
 * owns that span. `tasks` carries the durable background-task registry as
 * two running counts (`bash` for `process`/`bash-*` tasks, `agents` for
 * background subagents) — separate from `activeAgents`/`tpsAgents`, which
 * describe recent LLM generation and include the main agent.
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {number} [opts.deadline] absolute `performance.now()` deadline
 * @param {number} [opts.readBudgetBytes] total wire bytes allowed this frame
 * @param {string|null} [opts.hostVersion] Kimi Code version from the status-line payload
 * @returns {{tps: number|null, tpsStale: boolean, ttftMs: number|null, thinkingLevel: string|null, goal: object|null, modelAlias: string|null, swarmMode: boolean, cache: object|null, modelUsage: object|null, tpsTotal: number|null, tpsAgents: number, activeAgents: number, mainActive: boolean, mainSpeed: boolean, turnStartedAt: number|null, compactingSince: number|null, compactionMs: number|null, tasks: {bash: number, agents: number}}}
 */
export function getMetrics(sessionId, {
  sessionsRoot = SESSIONS_ROOT,
  stateDir = HUD_DIR,
  now = Date.now(),
  deadline = Infinity,
  readBudgetBytes = WIRE_READ_BUDGET_BYTES,
  hostVersion = null,
} = {}) {
  const empty = {
    tps: null, tpsStale: false, ttftMs: null, thinkingLevel: null, goal: null,
    modelAlias: null, swarmMode: false, hostVersion: null, cache: null, modelUsage: null,
    tpsTotal: null, tpsAgents: 0, activeAgents: 0, mainActive: false, mainSpeed: false,
    turnStartedAt: null, compactingSince: null, compactionMs: null,
    tasks: { bash: 0, agents: 0 },
  };
  try {
    if (!sessionId) return empty;
    const statePath = statePathFor(sessionId, stateDir);
    const state = loadState(statePath);
    let stateChanged = state[MIGRATED] === true;
    if (hostVersion !== null && hostVersion !== state.hostVersion) {
      state.hostVersion = hostVersion;
      stateChanged = true;
    }
    if (!deadlineOpen(deadline)) {
      return finishMetrics(state, statePath, stateChanged, now);
    }
    const sessionDir = resolveSessionDir(
      sessionId,
      sessionsRoot,
      state.sessionDir,
      { deadline },
    );
    if (!sessionDir) {
      return deadlineOpen(deadline)
        ? empty
        : finishMetrics(state, statePath, stateChanged, now);
    }
    if (state.sessionDir !== sessionDir) {
      state.sessionDir = sessionDir;
      stateChanged = true;
    }
    if (!deadlineOpen(deadline)) {
      return finishMetrics(state, statePath, stateChanged, now);
    }

    const requestedBudget = Number.isFinite(readBudgetBytes)
      ? Math.max(0, Math.floor(readBudgetBytes))
      : WIRE_READ_BUDGET_BYTES;
    let remainingBytes = Math.min(WIRE_READ_BUDGET_BYTES, requestedBudget);
    const wires = enumerateWires(sessionDir);
    const prepared = [];
    for (const wire of wires) {
      if (!deadlineOpen(deadline)) break;
      const descriptor = prepareWire(state, wire);
      if (descriptor) prepared.push(descriptor);
    }
    for (const wire of prepared) stateChanged ||= wire.changed;
    if (!deadlineOpen(deadline)) {
      return finishMetrics(state, statePath, stateChanged, now);
    }
    if (!prepared.length && !Object.keys(state.agents).length) return empty;
    const visibleAgentNames = new Set(prepared.map((wire) => wire.agent));
    const main = prepared.find((wire) => wire.agent === 'main') ?? null;

    if (main) {
      const startedAtZero = main.bucket.offset === 0;
      // Cache migration must stop at the saved offset, before live bytes are
      // folded, or appended step.end rows would be counted twice.
      if (
        (state.cacheScanV ?? 0) < CACHE_SCAN_V &&
        (main.bucket.offset === 0 || deadlineOpen(deadline))
      ) {
        try {
          const used = restoreCacheState(main.path, state, remainingBytes);
          remainingBytes -= used;
          stateChanged = true;
        } catch {
          resetCacheState(state);
          delete state.cacheScanV;
          stateChanged = true;
        }
      }

      if (deadlineOpen(deadline) && remainingBytes > 0 && main.stat.size > main.bucket.offset) {
        try {
          const result = readBoundedWire(
            main.path,
            main.bucket,
            main.stat.size,
            Math.min(MAIN_WIRE_SLICE_BYTES, remainingBytes),
          );
          remainingBytes -= result.bytesRead;
          if (result.text) processWireChunk(state, result.text, 'main');
          if (result.bytesRead > 0) stateChanged = true;
        } catch {
          // Keep the persisted projection and retry the same unread bytes.
        }
      }

      // A cold reader starts at byte zero and will derive every projection
      // incrementally. Migrated readers already past history need a separate
      // versioned shadow scan before their replacement projection is installed.
      if (startedAtZero && (state.backfillScanV ?? 0) < BACKFILL_SCAN_V) {
        state.backfillScanV = BACKFILL_SCAN_V;
        state.backfill = null;
        stateChanged = true;
      } else if ((state.backfillScanV ?? 0) < BACKFILL_SCAN_V) {
        try {
          const result = advanceBackfill(
            main.path,
            state,
            main.fileId,
            main.bucket.offset,
            deadlineOpen(deadline)
              ? Math.min(BACKFILL_WIRE_SLICE_BYTES, remainingBytes)
              : 0,
          );
          remainingBytes -= result.bytesRead;
          stateChanged ||= result.changed;
        } catch {
          // Preserve the visible projection and persisted cursor for retry.
        }
      }
    }

    // Subagents share what remains via a persisted round-robin cursor. A busy
    // fleet therefore cannot make an alphabetically-late agent starve.
    const subagents = prepared.filter((wire) => wire.agent !== 'main');
    if (subagents.length && remainingBytes > 0 && deadlineOpen(deadline)) {
      const start = state.agentCursor % subagents.length;
      let visited = 0;
      while (visited < subagents.length && remainingBytes > 0 && deadlineOpen(deadline)) {
        const wire = subagents[(start + visited) % subagents.length];
        visited += 1;
        if (wire.stat.size <= wire.bucket.offset) continue;
        try {
          const result = readBoundedWire(
            wire.path,
            wire.bucket,
            wire.stat.size,
            Math.min(AGENT_WIRE_SLICE_BYTES, remainingBytes),
          );
          remainingBytes -= result.bytesRead;
          if (result.text) processWireChunk(state, result.text, wire.agent);
          if (result.bytesRead > 0) stateChanged = true;
        } catch {
          // One disappearing agent wire must not hide the rest of the HUD.
        }
      }
      if (visited > 0) {
        const next = (start + visited) % subagents.length;
        if (state.agentCursor !== next) {
          state.agentCursor = next;
          stateChanged = true;
        }
      }
    }

    // The task sidecar files are rewritten by the host on every lifecycle
    // transition, so a bounded re-scan per frame reconciles what the
    // incremental wire journal cannot see (pre-journal hosts, migrated
    // readers). A closing deadline keeps the previous projection.
    if (deadlineOpen(deadline)) {
      try {
        // No `||=` short-circuit here: the sidecar scan must run even when
        // an earlier stage already marked the state dirty.
        const tasksChanged = reconcileTaskSidecars(state, sessionDir, deadline);
        stateChanged ||= tasksChanged;
      } catch {
        // The task badge is best effort and must stay silent.
      }
    }

    // Cost estimation consumes usage.record through a dedicated all-agent
    // reader. Keeping this cursor separate lets an upgraded HUD rebuild the
    // complete session ledger without replaying or disturbing live metrics.
    // It shares the same hard byte/deadline budget and remains hidden until
    // every visible wire has caught up.
    const sessionUsage = normalizeSessionUsageState(state.sessionUsage);
    state.sessionUsage = sessionUsage;
    let usageComplete = prepared.length === wires.length && prepared.length > 0;
    if (deadlineOpen(deadline)) {
      for (const wire of prepared) {
        if (!deadlineOpen(deadline)) {
          usageComplete = false;
          break;
        }
        const result = advanceSessionUsageAgent({
          state,
          agent: wire.agent,
          wirePath: wire.path,
          fileId: wire.fileId,
          fileSize: wire.stat.size,
          maxBytes: Math.min(AGENT_WIRE_SLICE_BYTES, remainingBytes),
        });
        remainingBytes -= result.bytesRead;
        stateChanged ||= result.changed;
        usageComplete &&= result.complete;
      }
    } else {
      usageComplete = false;
    }
    if (sessionUsage.complete !== usageComplete) {
      sessionUsage.complete = usageComplete;
      stateChanged = true;
    }

    return finishMetrics(state, statePath, stateChanged, now, visibleAgentNames);
  } catch {
    return empty;
  }
}
