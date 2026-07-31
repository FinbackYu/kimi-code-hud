import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HUD_DIR } from './quota.mjs';
import { applyGoalOp } from './goal.mjs';

export const SESSIONS_ROOT = path.join(os.homedir(), '.kimi-code', 'sessions');

const MAX_SAMPLES = 5;
const MIN_SAMPLES = 3;
const MIN_STREAM_MS = 250;
const MAX_TPS = 1000;
const TPS_TTL_MS = 2 * 60 * 1000;
const SAMPLE_STATE_V = 1;
// Backfill scan version; bump when the tracked key set changes so existing
// state files re-scan once (v2: `thinkingEffort`; v3: goal ops; v4:
// `modelAlias`, used to keep TPS samples scoped to one model).
const BACKFILL_SCAN_V = 4;

/**
 * Locate the wire.jsonl for a session id. The payload sessionId may or may
 * not carry a prefix, session dirs live one level below
 * ~/.kimi-code/sessions/<wd_*>, and the dir prefix changed from "ses_" to
 * "session_" in newer hosts — all spellings are tried. Returns null when
 * not found.
 * @param {string} sessionId
 * @param {string} [sessionsRoot]
 * @returns {string|null}
 */
export function findWirePath(sessionId, sessionsRoot = SESSIONS_ROOT) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  let bare = sessionId;
  for (const prefix of ['ses_', 'session_']) {
    if (bare.startsWith(prefix)) {
      bare = bare.slice(prefix.length);
      break;
    }
  }
  const candidates = [`ses_${bare}`, `session_${bare}`, bare];
  let wdDirs;
  try {
    wdDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const wd of wdDirs) {
    if (!wd.isDirectory()) continue;
    for (const name of candidates) {
      const p = path.join(sessionsRoot, wd.name, name, 'agents', 'main', 'wire.jsonl');
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function statePathFor(sessionId, stateDir) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(stateDir, `metrics-${safe}.json`);
}

function loadState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (s && typeof s === 'object' && typeof s.offset === 'number') {
      if (!Array.isArray(s.samples)) s.samples = [];
      return s;
    }
  } catch {
    // fall through
  }
  return {
    offset: 0,
    samples: [],
    lastTtftMs: null,
    lastSampleAt: null,
    modelAlias: null,
    sampleStateV: SAMPLE_STATE_V,
    thinkingLevel: null,
    goal: null,
  };
}

function resetMetricWindow(state) {
  state.samples = [];
  state.lastTtftMs = null;
  state.lastSampleAt = null;
}

function resetStreamState(state) {
  state.offset = 0;
  resetMetricWindow(state);
  state.modelAlias = null;
  state.sampleStateV = SAMPLE_STATE_V;
  state.thinkingLevel = null;
  state.goal = null;
  delete state.backfillScanV;
  delete state.thinkingScanV; // legacy v1/v2 marker
  delete state.thinkingScanDone; // legacy v1 marker
}

function saveState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch {
    // stay silent
  }
}

/**
 * Fold one parsed wire row into the metrics state. Handles config.update
 * (thinking level), goal ops (goal badge state) and step.end loop events
 * (TPS samples + TTFT).
 * @param {object} state mutated in place
 * @param {object} row parsed wire.jsonl line
 */
export function processWireRow(state, row) {
  if (row?.type === 'config.update') {
    const modelAlias =
      typeof row.modelAlias === 'string' && row.modelAlias ? row.modelAlias : null;
    if (modelAlias && modelAlias !== state.modelAlias) {
      // A first observed alias after samples is also unsafe: those samples
      // cannot be attributed to the new model with confidence.
      if (
        state.modelAlias ||
        state.samples.length > 0 ||
        state.lastTtftMs !== null
      ) {
        resetMetricWindow(state);
      }
      state.modelAlias = modelAlias;
    }
    // Latest thinking level wins ("on"/"off" for boolean models, or a
    // concrete effort like "high"/"max" for effort-capable ones). New
    // hosts write `thinkingEffort` (including an initial event at
    // session start); older hosts wrote `thinkingLevel`.
    const level = typeof row.thinkingEffort === 'string' ? row.thinkingEffort
      : typeof row.thinkingLevel === 'string' ? row.thinkingLevel : null;
    if (level) state.thinkingLevel = level;
    return;
  }
  if (
    row?.type === 'goal.create' ||
    row?.type === 'goal.update' ||
    row?.type === 'goal.clear' ||
    row?.type === 'forked'
  ) {
    state.goal = applyGoalOp(state.goal ?? null, row);
    return;
  }
  if (row?.type !== 'context.append_loop_event') return;
  const ev = row.event;
  if (!ev || ev.type !== 'step.end') return;
  if (Number.isFinite(ev.llmFirstTokenLatencyMs) && ev.llmFirstTokenLatencyMs >= 0) {
    state.lastTtftMs = ev.llmFirstTokenLatencyMs;
  }
  const out = ev.usage && typeof ev.usage.output === 'number' ? ev.usage.output : 0;
  const streamMs = typeof ev.llmStreamDurationMs === 'number' ? ev.llmStreamDurationMs : 0;
  const sampleAt = Number.isFinite(row.time) && row.time >= 0 ? row.time : null;
  const tps = out / (streamMs / 1000);
  if (
    Number.isFinite(out) &&
    out > 0 &&
    Number.isFinite(streamMs) &&
    streamMs >= MIN_STREAM_MS &&
    Number.isFinite(tps) &&
    tps <= MAX_TPS &&
    sampleAt !== null
  ) {
    if (
      Number.isFinite(state.lastSampleAt) &&
      sampleAt - state.lastSampleAt > TPS_TTL_MS
    ) {
      // Do not let a new sample revive an otherwise stale window.
      state.samples = [];
    }
    state.samples.push(tps);
    if (state.samples.length > MAX_SAMPLES) {
      state.samples.splice(0, state.samples.length - MAX_SAMPLES);
    }
    state.lastSampleAt = sampleAt;
  }
}

/** True when a raw line might carry a backfill-tracked key (cheap prefilter). */
function isBackfillLine(line) {
  return (
    line.includes('"thinkingEffort"') ||
    line.includes('"thinkingLevel"') ||
    line.includes('"modelAlias"') ||
    line.includes('"type":"goal.') ||
    line.includes('"type":"forked"')
  );
}

/**
 * Feed a text chunk of wire.jsonl lines into the metrics state.
 * Only complete lines (terminated by \n) are consumed; the caller tracks
 * the byte offset so an incomplete tail is retried next run.
 * @param {object} state mutated in place
 * @param {string} text complete lines only
 */
export function processWireChunk(state, text) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    processWireRow(state, row);
  }
}

/**
 * Median of a numeric array (null for empty).
 * @param {number[]} arr
 * @returns {number|null}
 */
export function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Incrementally read the session wire log and return current speed metrics.
 * State (byte offset + samples) is persisted per session so each 1s run only
 * parses newly appended bytes. Handles truncation/rotation by resetting the
 * offset when it exceeds the file size. Never throws.
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {{tps: number|null, ttftMs: number|null, thinkingLevel: string|null, goal: object|null}}
 */
export function getMetrics(sessionId, {
  sessionsRoot = SESSIONS_ROOT,
  stateDir = HUD_DIR,
  now = Date.now(),
} = {}) {
  const empty = { tps: null, ttftMs: null, thinkingLevel: null, goal: null };
  try {
    if (!sessionId) return empty;
    const wirePath = findWirePath(sessionId, sessionsRoot);
    if (!wirePath) return empty;
    const statePath = statePathFor(sessionId, stateDir);
    const state = loadState(statePath);
    let stateChanged = false;
    if (state.sampleStateV !== SAMPLE_STATE_V) {
      // Old caches lack sample timestamps and model ownership. Keeping those
      // samples would let previously accepted outliers leak into the new
      // validity rules, so migrate by dropping only the metric window.
      resetMetricWindow(state);
      state.modelAlias = null;
      state.sampleStateV = SAMPLE_STATE_V;
      stateChanged = true;
    }
    const stat = fs.statSync(wirePath);
    const size = stat.size;
    const fileId = `${stat.dev}:${stat.ino}`;
    // A smaller file was truncated in place; a different device/inode means
    // log rotation or replacement. In either case, old samples and offsets no
    // longer describe this stream and must be discarded together.
    if (state.offset > size || (state.fileId && state.fileId !== fileId)) {
      resetStreamState(state);
      stateChanged = true;
    }
    if (state.fileId !== fileId) {
      state.fileId = fileId;
      stateChanged = true;
    }
    // One-time backfill: sessions whose offset predates a tracked key would
    // otherwise never see earlier events (initial config.update, goal.create).
    // Versioned marker: v2 matched `thinkingEffort`, v3 added goal ops, and
    // v4 adds `modelAlias`. The substring prefilter keeps this fast even on
    // multi-MB logs.
    if ((state.backfillScanV ?? state.thinkingScanV ?? 0) < BACKFILL_SCAN_V) {
      try {
        const text = fs.readFileSync(wirePath, 'utf8');
        for (const line of text.split('\n')) {
          if (!isBackfillLine(line)) continue;
          try {
            processWireRow(state, JSON.parse(line));
          } catch {
            // keep scanning
          }
        }
      } catch {
        // stay silent
      }
      state.backfillScanV = BACKFILL_SCAN_V;
      delete state.thinkingScanV; // legacy v1/v2 marker
      delete state.thinkingScanDone; // legacy v1 marker
      stateChanged = true;
    }
    if (size > state.offset) {
      const fd = fs.openSync(wirePath, 'r');
      try {
        const len = size - state.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, state.offset);
        const text = buf.toString('utf8');
        const lastNl = text.lastIndexOf('\n');
        if (lastNl >= 0) {
          processWireChunk(state, text.slice(0, lastNl + 1));
          state.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
          stateChanged = true;
        }
        // else: no complete line yet, keep offset for next run
      } finally {
        fs.closeSync(fd);
      }
    }
    if (stateChanged) saveState(statePath, state);
    const sampleAge =
      Number.isFinite(state.lastSampleAt) && Number.isFinite(now)
        ? now - state.lastSampleAt
        : Number.POSITIVE_INFINITY;
    const hasFreshWindow =
      state.samples.length >= MIN_SAMPLES &&
      sampleAge <= TPS_TTL_MS;
    return {
      tps: hasFreshWindow ? median(state.samples) : null,
      ttftMs: state.lastTtftMs ?? null,
      thinkingLevel: state.thinkingLevel ?? null,
      goal: state.goal ?? null,
    };
  } catch {
    return empty;
  }
}
