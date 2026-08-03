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
 */

export const MAX_TASK_ENTRIES = 128;
const MAX_SIDECAR_FILES = 64;
const MAX_SIDECAR_BYTES = 16 * 1024;

export function emptyTasksState() {
  return { wire: {}, sidecar: {} };
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

/** Validate a persisted tasks block, discarding malformed entries. */
export function normalizeTasks(raw) {
  if (!raw || typeof raw !== 'object') return emptyTasksState();
  return {
    wire: normalizeTaskMap(raw.wire),
    sidecar: normalizeTaskMap(raw.sidecar),
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
    return normalizeTaskInfo(info, info?.endedAt ?? info?.startedAt);
  } catch {
    return null;
  }
}

/**
 * Re-scan the `agents/main/tasks/` sidecar directory and replace the
 * persisted sidecar projection. Sidecars are rewritten by the host on every
 * transition, so a wholesale replace tracks reality; a frame whose deadline
 * closes mid-scan keeps the previous projection instead of installing a
 * half-read one.
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
  for (const name of names) {
    if (Number.isFinite(deadline) && performance.now() >= deadline) return false;
    const rec = readSidecar(path.join(tasksDir, name));
    if (rec) next[rec.taskId] = { kind: rec.kind, status: rec.status, updatedAt: rec.updatedAt };
  }
  const prev = tasks.sidecar;
  const prevIds = Object.keys(prev);
  const nextIds = Object.keys(next);
  const changed =
    prevIds.length !== nextIds.length ||
    nextIds.some((id) => {
      const a = prev[id];
      const b = next[id];
      return !a || a.kind !== b.kind || a.status !== b.status || a.updatedAt !== b.updatedAt;
    });
  if (!changed) return false;
  tasks.sidecar = next;
  return true;
}

/**
 * Merge both projections and count running tasks by footer bucket. The
 * fresher record wins per task id (wire rows carry the Op time, sidecars the
 * last transition), so an incremental wire reader lagging behind the host
 * cannot resurrect a finished task, and a pre-journal host still reports
 * through sidecars alone. `agent` tasks get their own badge; every other
 * kind (`process`, `question`, ...) folds into the task badge, mirroring the
 * built-in footer.
 * @param {object} state
 * @returns {{bash: number, agents: number}}
 */
export function taskCountsFromState(state) {
  const tasks = state?.tasks && typeof state.tasks === 'object'
    ? state.tasks
    : emptyTasksState();
  const merged = new Map();
  for (const source of [tasks.sidecar, tasks.wire]) {
    if (!source || typeof source !== 'object') continue;
    for (const [taskId, rec] of Object.entries(source)) {
      if (!rec || rec.status === undefined) continue;
      const current = merged.get(taskId);
      if (!current || rec.updatedAt >= current.updatedAt) merged.set(taskId, rec);
    }
  }
  let bash = 0;
  let agents = 0;
  for (const rec of merged.values()) {
    if (rec.status !== 'running') continue;
    if (rec.kind === 'agent') agents += 1;
    else bash += 1;
  }
  return { bash, agents };
}
