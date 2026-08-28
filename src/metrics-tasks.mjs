import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Background-task registry reducers. Two durable sources are folded into one
 * bounded per-task projection:
 *
 * - the main wire journal's `task.started` / `task.terminated` Ops (the
 *   authoritative record once the host journals them), and
 * - the `agents/main/tasks/<taskId>.json` sidecar files, which older host
 *   versions (and every host that predates the journaled Ops) rewrite on
 *   every lifecycle transition.
 *
 * Both maps are persisted in the metrics state and bounded; only the merged
 * running counts leave this module — never command text, descriptions or
 * output tails.
 *
 * A third projection covers one upstream gap (MoonshotAI/kimi-code#3350):
 * resuming a `lost` background agent journals no fresh `task.started`, so the
 * journal reports the task as `lost` for the entire resumed run while the
 * built-in footer (in-memory registry) shows it running. When a merged record
 * is `lost` but the agent's own `agents/<agentId>/wire.jsonl` was written
 * after the lost mark, the task id is kept in `tasks.resumed`; the count then
 * treats it as running while that write stays fresh (see
 * LOST_AGENT_WIRE_FRESH_MS). The agent wire is the liveness signal because it
 * streams every LLM event mid-run, unlike `tasks/<taskId>/output.log`, which
 * for agents is typically written at completion.
 */

export const MAX_TASK_ENTRIES = 128;
const MAX_SIDECAR_FILES = 64;
const MAX_SIDECAR_BYTES = 16 * 1024;

/**
 * How long a post-lost write to the agent's own wire keeps a `lost` agent
 * counted as running. Long enough to survive quiet stretches between LLM
 * events, short enough that a truly dead task drops out quickly.
 */
export const LOST_AGENT_WIRE_FRESH_MS = 120_000;

/** Agent ids become path components; accept only the observed safe shape. */
const AGENT_ID_SAFE = /^[A-Za-z0-9-]+$/;

export function emptyTasksState() {
  return { wire: {}, sidecar: {}, resumed: {} };
}

/** Reset the whole task projection (fresh state, unrecoverable registry). */
export function resetTasksState(state) {
  state.tasks = emptyTasksState();
}

/** Drop only the wire-derived half (main wire truncated/rotated). */
export function resetWireTasks(state) {
  ensureTasksState(state);
  state.tasks.wire = {};
}

function normalizeTaskMap(raw) {
  const map = {};
  if (!raw || typeof raw !== 'object') return map;
  for (const [taskId, rec] of Object.entries(raw)) {
    if (
      rec &&
      typeof rec === 'object' &&
      typeof rec.kind === 'string' &&
      typeof rec.status === 'string' &&
      Number.isFinite(rec.updatedAt)
    ) {
      map[taskId] = { kind: rec.kind, status: rec.status, updatedAt: rec.updatedAt };
    }
  }
  return map;
}

function normalizeResumedMap(raw) {
  const map = {};
  if (!raw || typeof raw !== 'object') return map;
  for (const [taskId, activeAt] of Object.entries(raw)) {
    if (Number.isFinite(activeAt) && activeAt >= 0) map[taskId] = activeAt;
  }
  return map;
}

/** Validate a persisted tasks block, discarding malformed entries. */
export function normalizeTasks(raw) {
  if (!raw || typeof raw !== 'object') return emptyTasksState();
  return {
    wire: normalizeTaskMap(raw.wire),
    sidecar: normalizeTaskMap(raw.sidecar),
    resumed: normalizeResumedMap(raw.resumed),
  };
}

function ensureTasksState(state) {
  const normalized = normalizeTasks(state.tasks);
  state.tasks = normalized;
  return normalized;
}

function normalizeTaskInfo(info, updatedAt) {
  if (
    !info ||
    typeof info !== 'object' ||
    typeof info.taskId !== 'string' ||
    info.taskId === '' ||
    typeof info.kind !== 'string' ||
    typeof info.status !== 'string'
  ) {
    return null;
  }
  return {
    taskId: info.taskId,
    kind: info.kind,
    status: info.status,
    updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
  };
}

/**
 * Keep a registry map bounded: terminal entries are evicted first (oldest
 * update wins the slot back), running entries are never evicted — dropping a
 * live task would silently zero a badge the footer is supposed to show.
 */
function evictOverflow(map) {
  const ids = Object.keys(map);
  if (ids.length <= MAX_TASK_ENTRIES) return;
  const terminal = ids
    .filter((id) => map[id].status !== 'running')
    .sort((a, b) => map[a].updatedAt - map[b].updatedAt);
  let overflow = ids.length - MAX_TASK_ENTRIES;
  for (const id of terminal) {
    if (overflow <= 0) break;
    delete map[id];
    overflow -= 1;
  }
}

/**
 * Fold one wire row into the task registry. A later `task.terminated`
 * overwrites the earlier `task.started` for the same id; replaying the
 * journal from byte zero rebuilds the full lifecycle.
 * @param {object} state mutated in place
 * @param {object} row parsed wire.jsonl line
 */
export function applyTaskRow(state, row) {
  if (row?.type !== 'task.started' && row?.type !== 'task.terminated') return;
  const rec = normalizeTaskInfo(row.info, row.time);
  if (!rec) return;
  const tasks = ensureTasksState(state);
  tasks.wire[rec.taskId] = { kind: rec.kind, status: rec.status, updatedAt: rec.updatedAt };
  evictOverflow(tasks.wire);
}

function readSidecar(filePath) {
  let text;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES) return null;
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const info = JSON.parse(text);
    const rec = normalizeTaskInfo(info, info?.endedAt ?? info?.startedAt);
    // The agentId links a task to its `agents/<agentId>/wire.jsonl` liveness
    // signal; it is used for the resumed projection only, never persisted in
    // the sidecar map.
    if (rec && typeof info?.agentId === 'string' && info.agentId !== '') {
      rec.agentId = info.agentId;
    }
    return rec;
  } catch {
    return null;
  }
}

/**
 * Rebuild the resumed projection: task ids whose merged record is `lost` (an
 * agent kind only) yet whose own agent wire shows a write newer than the lost
 * mark — the only on-disk evidence that a lost background agent was resumed
 * and is still running. Entries are `taskId -> agent-wire mtime`; the counting
 * side applies the freshness window. Missing or unsafe agentIds, unreadable
 * wires, and wires with no post-lost write are all skipped silently.
 * @param {object} tasks normalized tasks state
 * @param {string} sessionDir resolved session directory
 * @param {object} agentIdByTaskId taskId -> agentId from the latest sidecar scan
 * @param {number} deadline absolute `performance.now()` deadline
 * @returns {boolean} whether the resumed projection changed
 */
function reconcileResumedAgents(tasks, sessionDir, agentIdByTaskId, deadline) {
  const merged = mergeTaskMaps(tasks);
  const next = {};
  for (const [taskId, rec] of merged) {
    if (rec.status !== 'lost' || rec.kind !== 'agent') continue;
    if (Number.isFinite(deadline) && performance.now() >= deadline) return false;
    const agentId = agentIdByTaskId[taskId];
    if (!agentId || !AGENT_ID_SAFE.test(agentId)) continue;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path.join(sessionDir, 'agents', agentId, 'wire.jsonl')).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > rec.updatedAt) next[taskId] = mtimeMs;
  }
  const prev = tasks.resumed;
  const prevIds = Object.keys(prev);
  const changed =
    prevIds.length !== Object.keys(next).length ||
    Object.entries(next).some(([id, activeAt]) => prev[id] !== activeAt);
  if (!changed) return false;
  tasks.resumed = next;
  return true;
}

/**
 * Re-scan the `agents/main/tasks/` sidecar directory and replace the
 * persisted sidecar projection. Sidecars are rewritten by the host on every
 * transition, so a wholesale replace tracks reality; a frame whose deadline
 * closes mid-scan keeps the previous projection instead of installing a
 * half-read one. The resumed-agent liveness pass runs on every open-deadline
 * scan, even when the sidecar projection itself is unchanged, because the
 * agent wire moves independently of the sidecars.
 * @param {object} state mutated in place
 * @param {string} sessionDir resolved session directory
 * @param {number} deadline absolute `performance.now()` deadline
 * @returns {boolean} whether the state changed
 */
export function reconcileTaskSidecars(state, sessionDir, deadline = Infinity) {
  const deadlineOpen = !Number.isFinite(deadline) || performance.now() < deadline;
  if (!deadlineOpen) return false;
  const tasks = ensureTasksState(state);
  const tasksDir = path.join(sessionDir, 'agents', 'main', 'tasks');
  let names;
  try {
    names = fs
      .readdirSync(tasksDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(0, MAX_SIDECAR_FILES);
  } catch {
    names = [];
  }
  const next = {};
  const agentIdByTaskId = {};
  for (const name of names) {
    if (Number.isFinite(deadline) && performance.now() >= deadline) return false;
    const rec = readSidecar(path.join(tasksDir, name));
    if (rec) {
      next[rec.taskId] = { kind: rec.kind, status: rec.status, updatedAt: rec.updatedAt };
      if (rec.agentId) agentIdByTaskId[rec.taskId] = rec.agentId;
    }
  }
  const prev = tasks.sidecar;
  const prevIds = Object.keys(prev);
  const nextIds = Object.keys(next);
  const sidecarChanged =
    prevIds.length !== nextIds.length ||
    nextIds.some((id) => {
      const a = prev[id];
      const b = next[id];
      return !a || a.kind !== b.kind || a.status !== b.status || a.updatedAt !== b.updatedAt;
    });
  if (sidecarChanged) tasks.sidecar = next;
  const resumedChanged = reconcileResumedAgents(tasks, sessionDir, agentIdByTaskId, deadline);
  return sidecarChanged || resumedChanged;
}

/**
 * Fold the sidecar and wire projections into one view; the fresher record
 * wins per task id (wire rows carry the Op time, sidecars the last
 * transition), so an incremental wire reader lagging behind the host cannot
 * resurrect a finished task, and a pre-journal host still reports through
 * sidecars alone.
 * @param {object} tasks normalized tasks state
 * @returns {Map<string, {kind: string, status: string, updatedAt: number}>}
 */
function mergeTaskMaps(tasks) {
  const merged = new Map();
  for (const source of [tasks.sidecar, tasks.wire]) {
    if (!source || typeof source !== 'object') continue;
    for (const [taskId, rec] of Object.entries(source)) {
      if (!rec || rec.status === undefined) continue;
      const current = merged.get(taskId);
      if (!current || rec.updatedAt >= current.updatedAt) merged.set(taskId, rec);
    }
  }
  return merged;
}

/**
 * Count running tasks by footer bucket from the merged projections. `agent`
 * tasks get their own badge; every other kind (`process`, `question`, ...)
 * folds into the task badge, mirroring the built-in footer. A `lost` agent
 * additionally counts as running while the resumed projection holds a fresh
 * post-lost write on its own agent wire — the resumed run journals nothing
 * until termination (MoonshotAI/kimi-code#3350), and the freshness window
 * drops the count soon after a genuinely dead task stops writing.
 * @param {object} state
 * @param {number} [now] current time in ms, injectable for tests
 * @returns {{bash: number, agents: number}}
 */
export function taskCountsFromState(state, now = Date.now()) {
  const tasks = state?.tasks && typeof state.tasks === 'object' ? state.tasks : emptyTasksState();
  const merged = mergeTaskMaps(tasks);
  let bash = 0;
  let agents = 0;
  for (const rec of merged.values()) {
    if (rec.status !== 'running') continue;
    if (rec.kind === 'agent') agents += 1;
    else bash += 1;
  }
  const resumed =
    tasks.resumed && typeof tasks.resumed === 'object' ? tasks.resumed : {};
  for (const [taskId, activeAt] of Object.entries(resumed)) {
    if (!Number.isFinite(activeAt)) continue;
    if (now - activeAt > LOST_AGENT_WIRE_FRESH_MS) continue;
    const rec = merged.get(taskId);
    // A completed/failed record fresher than the lost mark wins outright; the
    // projection rebuild drops the id on the next scan.
    if (!rec || rec.status !== 'lost') continue;
    agents += 1;
  }
  return { bash, agents };
}
