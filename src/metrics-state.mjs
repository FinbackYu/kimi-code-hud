import fs from 'node:fs';
import path from 'node:path';

import { resetCacheState } from './cache-hit.mjs';
import { atomicWriteFile } from './fs-store.mjs';
import { emptyAgent, normAgent } from './metrics-agent.mjs';
import { emptyTasksState, normalizeTasks } from './metrics-tasks.mjs';
import {
  emptySessionUsageState,
  normalizeSessionUsageState,
} from './session-usage.mjs';
import {
  BACKFILL_SCAN_V,
  CACHE_SCAN_V,
  MAX_SAMPLES,
  METRICS_STATE_V,
  MIN_SAMPLES,
  SAMPLE_STATE_V,
} from './metrics-constants.mjs';
import { median } from './metrics-math.mjs';

export const MIGRATED = Symbol('metrics-state-migrated');

export function statePathFor(sessionId, stateDir) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(stateDir, `metrics-${safe}.json`);
}

export function emptyState() {
  const state = {
    v: METRICS_STATE_V,
    agents: {},
    sessionDir: null,
    agentCursor: 0,
    backfill: null,
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
    hostVersion: null,
    cacheScanV: CACHE_SCAN_V,
    tasks: emptyTasksState(),
    sessionUsage: emptySessionUsageState(),
  };
  resetCacheState(state);
  return state;
}

function normalizeBackfill(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.version !== BACKFILL_SCAN_V ||
    typeof raw.fileId !== 'string'
  ) {
    return null;
  }
  const reader = normAgent({ ...(raw.reader || {}) });
  reader.samples = [];
  reader.lastMedian = null;
  const shadow = raw.shadow && typeof raw.shadow === 'object'
    ? raw.shadow
    : emptyState();
  if (!shadow.agents || typeof shadow.agents !== 'object') shadow.agents = {};
  for (const name of Object.keys(shadow.agents)) {
    shadow.agents[name] = normAgent(shadow.agents[name]);
  }
  if (typeof shadow.swarmMode !== 'boolean') shadow.swarmMode = false;
  shadow.backfill = null;
  const targetOffset = Number.isInteger(raw.targetOffset) && raw.targetOffset >= 0
    ? Math.max(raw.targetOffset, reader.offset)
    : reader.offset;
  return {
    version: BACKFILL_SCAN_V,
    fileId: raw.fileId,
    targetOffset,
    reader,
    shadow,
  };
}

function migrateFlatState(raw) {
  const state = emptyState();
  const main = emptyAgent();
  main.offset = raw.offset;
  if (typeof raw.fileId === 'string') main.fileId = raw.fileId;
  if (raw.sampleStateV === SAMPLE_STATE_V) {
    const stamp = typeof raw.lastSampleAt === 'number' ? raw.lastSampleAt : 0;
    if (Array.isArray(raw.samples)) {
      main.samples = raw.samples
        .filter((value) => typeof value === 'number')
        .map((value) => ({ v: value, t: stamp }));
    }
    if (typeof raw.lastTtftMs === 'number') main.lastTtftMs = raw.lastTtftMs;
    if (typeof raw.lastSampleAt === 'number') main.lastSampleAt = raw.lastSampleAt;
    if (main.samples.length >= MIN_SAMPLES) {
      main.lastMedian = median(
        main.samples.slice(-MAX_SAMPLES).map((sample) => sample.v),
      );
    } else if (typeof raw.lastMedian === 'number') {
      main.lastMedian = raw.lastMedian;
    }
    if (typeof raw.modelAlias === 'string') state.modelAlias = raw.modelAlias;
  }
  if (typeof raw.thinkingLevel === 'string') state.thinkingLevel = raw.thinkingLevel;
  if (raw.goal && typeof raw.goal === 'object') state.goal = raw.goal;
  if (typeof raw.swarmMode === 'boolean') state.swarmMode = raw.swarmMode;
  if (typeof raw.backfillScanV === 'number') state.backfillScanV = raw.backfillScanV;
  else if (typeof raw.thinkingScanV === 'number') state.backfillScanV = raw.thinkingScanV;
  state.cacheScanV = typeof raw.cacheScanV === 'number' ? raw.cacheScanV : 0;
  if (raw.cache && typeof raw.cache === 'object') state.cache = raw.cache;
  state.agents.main = main;
  state[MIGRATED] = true;
  return state;
}

/** v6 -> v7: assign the former global median only when ownership is clear. */
function migrateV6State(raw) {
  const state = { ...raw, v: 7, agents: {} };
  const entries = Object.entries(raw.agents || {});
  for (const [name, bucket] of entries) {
    const agent = normAgent({ ...bucket });
    const values = agent.samples
      .filter((sample) => sample && typeof sample.v === 'number')
      .slice(-MAX_SAMPLES)
      .map((sample) => sample.v);
    agent.lastMedian = values.length >= MIN_SAMPLES ? median(values) : null;
    state.agents[name] = agent;
  }
  if (
    entries.length === 1 &&
    typeof raw.lastMedian === 'number' &&
    state.agents[entries[0][0]].lastMedian === null
  ) {
    state.agents[entries[0][0]].lastMedian = raw.lastMedian;
  }
  delete state.lastMedian;
  state[MIGRATED] = true;
  return state;
}

/** v7 -> v8: add cached location and resumable bounded-reader cursors. */
function migrateV7State(raw) {
  const state = { ...raw, v: METRICS_STATE_V, agents: {} };
  for (const [name, bucket] of Object.entries(raw.agents || {})) {
    state.agents[name] = normAgent({ ...bucket });
  }
  state.sessionDir = typeof raw.sessionDir === 'string' ? raw.sessionDir : null;
  state.agentCursor = Number.isInteger(raw.agentCursor) && raw.agentCursor >= 0
    ? raw.agentCursor
    : 0;
  state.backfill = null;
  state.hostVersion = typeof raw.hostVersion === 'string' ? raw.hostVersion : null;
  state[MIGRATED] = true;
  return state;
}

export function loadState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state && typeof state === 'object') {
      if (
        state.v === METRICS_STATE_V &&
        state.agents &&
        typeof state.agents === 'object'
      ) {
        for (const name of Object.keys(state.agents)) {
          state.agents[name] = normAgent(state.agents[name]);
        }
        if (typeof state.swarmMode !== 'boolean') state.swarmMode = false;
        if (typeof state.sessionDir !== 'string') state.sessionDir = null;
        if (!Number.isInteger(state.agentCursor) || state.agentCursor < 0) {
          state.agentCursor = 0;
        }
        state.backfill = normalizeBackfill(state.backfill);
        state.tasks = normalizeTasks(state.tasks);
        state.sessionUsage = normalizeSessionUsageState(state.sessionUsage);
        if (typeof state.hostVersion !== 'string') state.hostVersion = null;
        delete state.cacheTurn;
        delete state.cacheNeedsPrompt;
        return state;
      }
      if (state.v === 7 && state.agents && typeof state.agents === 'object') {
        return migrateV7State(state);
      }
      if (state.v === 6 && state.agents && typeof state.agents === 'object') {
        return migrateV7State(migrateV6State(state));
      }
      if (typeof state.offset === 'number') return migrateFlatState(state);
    }
  } catch {
    // Missing or corrupt state starts clean.
  }
  return emptyState();
}

export function saveState(statePath, state) {
  try {
    atomicWriteFile(statePath, JSON.stringify(state));
  } catch {
    // Rendering state is best effort and must remain silent.
  }
}
