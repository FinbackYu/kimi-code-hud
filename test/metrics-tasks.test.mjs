import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MAX_TASK_ENTRIES,
  applyTaskRow,
  emptyTasksState,
  normalizeTasks,
  reconcileTaskSidecars,
  taskCountsFromState,
} from '../src/metrics-tasks.mjs';
import { getMetrics, processWireChunk } from '../src/metrics.mjs';

const EVENT_TIME = Date.parse('2026-08-02T00:00:00Z');

function makeState() {
  return { v: 7, agents: {}, tasks: emptyTasksState() };
}

function taskRow(type, info, time = EVENT_TIME) {
  return JSON.stringify({ type, info, time });
}

function taskInfo(overrides = {}) {
  return {
    taskId: 'bash-00000001',
    description: 'never rendered',
    status: 'running',
    kind: 'process',
    startedAt: EVENT_TIME,
    endedAt: null,
    command: 'sleep 60',
    pid: 1234,
    ...overrides,
  };
}

function makeSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-tasks-'));
  const id = 'abc123';
  const sessionDir = path.join(root, 'wd_1', `ses_${id}`);
  const wireDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(wireDir, { recursive: true });
  const wirePath = path.join(wireDir, 'wire.jsonl');
  fs.writeFileSync(wirePath, '');
  return { root, id, sessionDir, wirePath };
}

function writeSidecar(sessionDir, info) {
  const tasksDir = path.join(sessionDir, 'agents', 'main', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, `${info.taskId}.json`), JSON.stringify(info));
}

test('applyTaskRow folds started/terminated into the wire registry', () => {
  const state = makeState();
  applyTaskRow(state, { type: 'task.started', info: taskInfo(), time: EVENT_TIME });
  assert.deepEqual(taskCountsFromState(state), { bash: 1, agents: 0 });

  applyTaskRow(state, {
    type: 'task.terminated',
    info: taskInfo({ status: 'completed', endedAt: EVENT_TIME + 1000 }),
    time: EVENT_TIME + 1000,
  });
  assert.deepEqual(taskCountsFromState(state), { bash: 0, agents: 0 });
});

test('applyTaskRow ignores unrelated rows and malformed info', () => {
  const state = makeState();
  applyTaskRow(state, { type: 'turn.prompt', time: EVENT_TIME });
  applyTaskRow(state, { type: 'task.started', info: null, time: EVENT_TIME });
  applyTaskRow(state, { type: 'task.started', info: { taskId: 'x' }, time: EVENT_TIME });
  applyTaskRow(state, { type: 'task.started', info: taskInfo({ taskId: '' }), time: EVENT_TIME });
  assert.deepEqual(taskCountsFromState(state), { bash: 0, agents: 0 });
  assert.deepEqual(state.tasks.wire, {});
});

test('every terminal status leaves the running counts', () => {
  for (const status of ['completed', 'failed', 'timed_out', 'killed', 'lost']) {
    const state = makeState();
    applyTaskRow(state, { type: 'task.started', info: taskInfo(), time: EVENT_TIME });
    applyTaskRow(state, {
      type: 'task.terminated',
      info: taskInfo({ status, endedAt: EVENT_TIME + 1 }),
      time: EVENT_TIME + 1,
    });
    assert.deepEqual(
      taskCountsFromState(state),
      { bash: 0, agents: 0 },
      `status ${status} must not count as running`,
    );
  }
});

test('agent tasks count separately from process tasks', () => {
  const state = makeState();
  applyTaskRow(state, { type: 'task.started', info: taskInfo(), time: EVENT_TIME });
  applyTaskRow(state, {
    type: 'task.started',
    info: taskInfo({ taskId: 'agent-00000001', kind: 'agent' }),
    time: EVENT_TIME,
  });
  applyTaskRow(state, {
    type: 'task.started',
    info: taskInfo({ taskId: 'agent-00000002', kind: 'agent' }),
    time: EVENT_TIME,
  });
  assert.deepEqual(taskCountsFromState(state), { bash: 1, agents: 2 });
});

test('the fresher record wins across wire and sidecar projections', () => {
  const state = makeState();
  // Sidecar already settled the task; a lagging wire reader must not
  // resurrect it.
  state.tasks.sidecar = {
    'bash-00000001': { kind: 'process', status: 'completed', updatedAt: EVENT_TIME + 5000 },
  };
  applyTaskRow(state, { type: 'task.started', info: taskInfo(), time: EVENT_TIME });
  assert.deepEqual(taskCountsFromState(state), { bash: 0, agents: 0 });

  // A wire Op newer than the sidecar wins in the other direction.
  applyTaskRow(state, {
    type: 'task.started',
    info: taskInfo({ taskId: 'bash-00000002' }),
    time: EVENT_TIME + 9000,
  });
  state.tasks.sidecar['bash-00000002'] = {
    kind: 'process',
    status: 'killed',
    updatedAt: EVENT_TIME + 8000,
  };
  assert.deepEqual(taskCountsFromState(state), { bash: 1, agents: 0 });
});

test('normalizeTasks discards malformed persisted entries', () => {
  const normalized = normalizeTasks({
    wire: {
      ok: { kind: 'process', status: 'running', updatedAt: 1 },
      bad1: { kind: 'process' },
      bad2: 'running',
      bad3: { kind: 'process', status: 'running' },
    },
    sidecar: null,
  });
  assert.deepEqual(normalized.wire, {
    ok: { kind: 'process', status: 'running', updatedAt: 1 },
  });
  assert.deepEqual(normalized.sidecar, {});
  assert.deepEqual(normalizeTasks(undefined), { wire: {}, sidecar: {} });
});

test('wire registry evicts terminal entries first and never running ones', () => {
  const state = makeState();
  for (let i = 0; i < MAX_TASK_ENTRIES; i += 1) {
    applyTaskRow(state, {
      type: 'task.started',
      info: taskInfo({ taskId: `bash-run-${i}` }),
      time: EVENT_TIME + i,
    });
  }
  // All slots are running: nothing may be evicted.
  applyTaskRow(state, {
    type: 'task.started',
    info: taskInfo({ taskId: 'bash-overflow' }),
    time: EVENT_TIME + MAX_TASK_ENTRIES,
  });
  assert.equal(Object.keys(state.tasks.wire).length, MAX_TASK_ENTRIES + 1);
  assert.equal(taskCountsFromState(state).bash, MAX_TASK_ENTRIES + 1);

  // Terminal entries are reclaimed oldest-first on the next inserts.
  applyTaskRow(state, {
    type: 'task.terminated',
    info: taskInfo({ taskId: 'bash-run-0', status: 'killed', endedAt: EVENT_TIME + 2000 }),
    time: EVENT_TIME + 2000,
  });
  applyTaskRow(state, {
    type: 'task.started',
    info: taskInfo({ taskId: 'bash-new' }),
    time: EVENT_TIME + 3000,
  });
  assert.equal(state.tasks.wire['bash-run-0'], undefined);
  assert.ok(state.tasks.wire['bash-new']);
  assert.ok(state.tasks.wire['bash-run-1']);
});

test('reconcileTaskSidecars reads the tasks directory and counts running tasks', () => {
  const { sessionDir } = makeSession();
  const state = makeState();
  writeSidecar(sessionDir, taskInfo());
  writeSidecar(sessionDir, taskInfo({ taskId: 'agent-00000001', kind: 'agent' }));
  writeSidecar(sessionDir, taskInfo({
    taskId: 'bash-00000002',
    status: 'timed_out',
    endedAt: EVENT_TIME + 1000,
  }));

  const changed = reconcileTaskSidecars(state, sessionDir);
  assert.equal(changed, true);
  assert.deepEqual(taskCountsFromState(state), { bash: 1, agents: 1 });
  // A second identical scan is a no-op.
  assert.equal(reconcileTaskSidecars(state, sessionDir), false);
});

test('reconcileTaskSidecars skips unreadable files and ignores non-JSON names', () => {
  const { sessionDir } = makeSession();
  const state = makeState();
  writeSidecar(sessionDir, taskInfo());
  const tasksDir = path.join(sessionDir, 'agents', 'main', 'tasks');
  fs.writeFileSync(path.join(tasksDir, 'broken.json'), '{not json');
  fs.writeFileSync(path.join(tasksDir, 'notes.txt'), '{"taskId":"nope"}');
  fs.mkdirSync(path.join(tasksDir, 'bash-00000009')); // live task output dir
  assert.equal(reconcileTaskSidecars(state, sessionDir), true);
  assert.deepEqual(taskCountsFromState(state), { bash: 1, agents: 0 });
});

test('reconcileTaskSidecars clears the projection when the directory vanishes', () => {
  const { sessionDir } = makeSession();
  const state = makeState();
  writeSidecar(sessionDir, taskInfo());
  reconcileTaskSidecars(state, sessionDir);
  assert.equal(taskCountsFromState(state).bash, 1);
  fs.rmSync(path.join(sessionDir, 'agents', 'main', 'tasks'), { recursive: true });
  assert.equal(reconcileTaskSidecars(state, sessionDir), true);
  assert.deepEqual(taskCountsFromState(state), { bash: 0, agents: 0 });
});

test('a closed deadline keeps the previous sidecar projection', () => {
  const { sessionDir } = makeSession();
  const state = makeState();
  writeSidecar(sessionDir, taskInfo());
  assert.equal(reconcileTaskSidecars(state, sessionDir, 0), false);
  assert.deepEqual(taskCountsFromState(state), { bash: 0, agents: 0 });
});

test('getMetrics recovers task counts from a session without payload task fields', () => {
  const { root, id, sessionDir } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-tasks-state-'));
  writeSidecar(sessionDir, taskInfo());
  writeSidecar(sessionDir, taskInfo({ taskId: 'agent-00000001', kind: 'agent' }));
  writeSidecar(sessionDir, taskInfo({
    taskId: 'bash-00000002',
    status: 'failed',
    endedAt: EVENT_TIME + 1000,
  }));

  const metrics = getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME + 60_000 });
  assert.deepEqual(metrics.tasks, { bash: 1, agents: 1 });
  // The registry is durable: the next frame with a closed deadline still
  // reports the persisted projection.
  const stalled = getMetrics(id, { sessionsRoot: root, stateDir, deadline: 0 });
  assert.deepEqual(stalled.tasks, { bash: 1, agents: 1 });
});

test('getMetrics folds wire task rows and keeps them apart from throughput counts', () => {
  const { root, id, wirePath } = makeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-tasks-state-'));
  fs.appendFileSync(
    wirePath,
    taskRow('task.started', taskInfo()) + '\n' +
      taskRow('task.started', taskInfo({ taskId: 'agent-00000001', kind: 'agent' })) + '\n',
  );
  const metrics = getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME + 60_000 });
  assert.deepEqual(metrics.tasks, { bash: 1, agents: 1 });
  // Durable task state must not leak into the throughput head counts.
  assert.equal(metrics.activeAgents, 0);
  assert.equal(metrics.tpsAgents, 0);

  fs.appendFileSync(
    wirePath,
    taskRow('task.terminated', taskInfo({ status: 'lost', endedAt: EVENT_TIME + 5000 }), EVENT_TIME + 5000) + '\n',
  );
  const after = getMetrics(id, { sessionsRoot: root, stateDir, now: EVENT_TIME + 60_000 });
  assert.deepEqual(after.tasks, { bash: 0, agents: 1 });
});

test('processWireChunk only tracks tasks for the main agent', () => {
  const state = makeState();
  processWireChunk(state, taskRow('task.started', taskInfo()) + '\n', 'agent-0');
  assert.deepEqual(taskCountsFromState(state), { bash: 0, agents: 0 });
  processWireChunk(state, taskRow('task.started', taskInfo()) + '\n', 'main');
  assert.deepEqual(taskCountsFromState(state), { bash: 1, agents: 0 });
});
