import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HUD_DIR } from './quota.mjs';
import { applyGoalOp } from './goal.mjs';
import {
  applyCacheWireRow,
  cacheMetricFromState,
  resetCacheState,
} from './cache-hit.mjs';

export const SESSIONS_ROOT = path.join(os.homedir(), '.kimi-code', 'sessions');

const MAX_SAMPLES = 5;
const MIN_SAMPLES = 3;
const MIN_STREAM_MS = 250;
const MAX_TPS = 1000;
const TPS_TTL_MS = 2 * 60 * 1000;
// Speed samples carry the wire event timestamp and expire at read time:
// after a resume / idle gap / compaction the pre-gap numbers describe a
// different workload and must not leak into any agent's median.
const SAMPLE_WINDOW_MS = 10 * 60 * 1000;
// An agent counts as active (fleet total/average) when it produced a sample
// within this window or has a request in flight.
const ACTIVE_WINDOW_MS = TPS_TTL_MS;
// Persisted per-agent sample array bound; only the freshest MAX_SAMPLES feed
// a median.
const MAX_STORED_SAMPLES = 20;
const SAMPLE_STATE_V = 1;
const CACHE_SCAN_V = 1;
export const CACHE_BACKFILL_MAX_BYTES = 1024 * 1024;
// Backfill scan version; bump when the tracked key set changes so existing
// state files re-scan once (v2: `thinkingEffort`; v3: goal ops; v4:
// `modelAlias`, used to keep TPS samples scoped to one model; v5:
// `swarm_mode.enter/exit`, the wire journal's swarm-mode record).
const BACKFILL_SCAN_V = 5;
// State format version; v6: per-agent sample buckets with timestamped
// samples (v1..v5 states were flat single-wire shapes and are migrated).
const STATE_V = 6;

/**
 * Locate the session directory for a session id. The payload sessionId may
 * or may not carry a prefix, session dirs live one level below
 * ~/.kimi-code/sessions/<wd_*>, and the dir prefix changed from "ses_" to
 * "session_" in newer hosts — all spellings are tried. Returns null when
 * not found.
 * @param {string} sessionId
 * @param {string} [sessionsRoot]
 * @returns {string|null}
 */
export function findSessionDir(sessionId, sessionsRoot = SESSIONS_ROOT) {
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
      const p = path.join(sessionsRoot, wd.name, name);
      try {
        if (fs.statSync(p).isDirectory()) return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * Locate the main agent's wire.jsonl for a session id.
 * @param {string} sessionId
 * @param {string} [sessionsRoot]
 * @returns {string|null}
 */
export function findWirePath(sessionId, sessionsRoot = SESSIONS_ROOT) {
  const dir = findSessionDir(sessionId, sessionsRoot);
  if (!dir) return null;
  const p = path.join(dir, 'agents', 'main', 'wire.jsonl');
  try {
    if (fs.statSync(p).isFile()) return p;
  } catch {
    // not there
  }
  return null;
}

function statePathFor(sessionId, stateDir) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(stateDir, `metrics-${safe}.json`);
}

function emptyAgent() {
  return {
    offset: 0,
    fileId: null,
    samples: [],
    lastTtftMs: null,
    lastSampleAt: null,
    lastRequestAt: null,
    lastStepEndAt: null,
  };
}

/** Normalize a persisted per-agent bucket in place. */
function normAgent(a) {
  if (!a || typeof a !== 'object') return emptyAgent();
  if (typeof a.offset !== 'number') a.offset = 0;
  if (typeof a.fileId !== 'string') a.fileId = null;
  if (!Array.isArray(a.samples)) a.samples = [];
  if (typeof a.lastTtftMs !== 'number') a.lastTtftMs = null;
  if (typeof a.lastSampleAt !== 'number') a.lastSampleAt = null;
  if (typeof a.lastRequestAt !== 'number') a.lastRequestAt = null;
  if (typeof a.lastStepEndAt !== 'number') a.lastStepEndAt = null;
  return a;
}

function emptyState() {
  const state = {
    v: STATE_V,
    agents: {},
    lastMedian: null,
    modelAlias: null,
    thinkingLevel: null,
    goal: null,
    swarmMode: false,
    cacheScanV: CACHE_SCAN_V,
  };
  resetCacheState(state);
  return state;
}

/**
 * Migrate a pre-v6 flat single-wire state into the bucketed shape. The main
 * bucket inherits the offset/fileId so no historical re-read is needed.
 * Samples from a current SAMPLE_STATE_V carry no timestamps, so they are
 * stamped with the state's lastSampleAt — they keep describing the same
 * window and expire on their original timeline (states whose sample format
 * predates SAMPLE_STATE_V drop the window entirely, matching the old
 * migration). Everything else (lastMedian, modelAlias, thinking, goal,
 * swarm, cache) carries over untouched.
 */
function migrateFlatState(s) {
  const state = emptyState();
  const main = emptyAgent();
  main.offset = s.offset;
  if (typeof s.fileId === 'string') main.fileId = s.fileId;
  if (s.sampleStateV === SAMPLE_STATE_V) {
    const stamp = typeof s.lastSampleAt === 'number' ? s.lastSampleAt : 0;
    if (Array.isArray(s.samples)) {
      main.samples = s.samples
        .filter((v) => typeof v === 'number')
        .map((v) => ({ v, t: stamp }));
    }
    if (typeof s.lastTtftMs === 'number') main.lastTtftMs = s.lastTtftMs;
    if (typeof s.lastSampleAt === 'number') main.lastSampleAt = s.lastSampleAt;
    if (typeof s.lastMedian === 'number') state.lastMedian = s.lastMedian;
    if (typeof s.modelAlias === 'string') state.modelAlias = s.modelAlias;
  }
  if (typeof s.thinkingLevel === 'string') state.thinkingLevel = s.thinkingLevel;
  if (s.goal && typeof s.goal === 'object') state.goal = s.goal;
  if (typeof s.swarmMode === 'boolean') state.swarmMode = s.swarmMode;
  if (typeof s.backfillScanV === 'number') state.backfillScanV = s.backfillScanV;
  else if (typeof s.thinkingScanV === 'number') state.backfillScanV = s.thinkingScanV;
  // Absent cacheScanV must stay 0 so the bounded cache restoration still
  // runs once for pre-existing sessions (fresh states default to current).
  state.cacheScanV = typeof s.cacheScanV === 'number' ? s.cacheScanV : 0;
  if (s.cacheTurn && typeof s.cacheTurn === 'object') state.cacheTurn = s.cacheTurn;
  if (typeof s.cacheNeedsPrompt === 'boolean') state.cacheNeedsPrompt = s.cacheNeedsPrompt;
  state.agents.main = main;
  return state;
}

function loadState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (s && typeof s === 'object') {
      if (s.v === STATE_V && s.agents && typeof s.agents === 'object') {
        for (const name of Object.keys(s.agents)) s.agents[name] = normAgent(s.agents[name]);
        if (typeof s.lastMedian !== 'number') s.lastMedian = null;
        if (typeof s.swarmMode !== 'boolean') s.swarmMode = false;
        return s;
      }
      if (typeof s.offset === 'number') return migrateFlatState(s);
    }
  } catch {
    // fall through
  }
  return emptyState();
}

/**
 * Drop every agent's sample window and the remembered last median. Used
 * when the model changes: samples collected under one alias cannot be
 * attributed to another with confidence.
 */
function resetFleetWindows(state) {
  for (const a of Object.values(state.agents)) {
    a.samples = [];
    a.lastTtftMs = null;
    a.lastSampleAt = null;
  }
  state.lastMedian = null;
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
 * Fold one parsed wire row into the metrics state. Rows are bucketed per
 * agent: llm.request/step.end/full_compaction.complete/turn.cancel drive
 * the in-flight generation flag, step.end adds TPS samples and TTFT. The
 * main agent additionally feeds the state-level handlers — cache turns,
 * config.update (model alias + thinking level), goal ops and the
 * swarm_mode.enter/exit journal.
 * @param {object} state mutated in place
 * @param {object} row parsed wire.jsonl line
 * @param {string} [agent] which agent's wire this row comes from
 */
export function processWireRow(state, row, agent = 'main') {
  if (!state.agents || typeof state.agents !== 'object') state.agents = {};
  const bucket = normAgent(state.agents[agent]);
  state.agents[agent] = bucket;
  const rowTime = Number.isFinite(row?.time) && row.time >= 0 ? row.time : null;
  if (agent === 'main') {
    // Cache turns need to see every row, including turn.prompt boundaries,
    // before the metric-specific early returns below.
    applyCacheWireRow(state, row);
  }
  if (row?.type === 'llm.request') {
    // A loop request without a later step.end means the model is generating
    // right now. Compaction requests never produce a step.end, so they must
    // not mark the agent as generating.
    if (
      row.kind !== 'compaction' &&
      rowTime !== null &&
      (bucket.lastRequestAt === null || rowTime > bucket.lastRequestAt)
    ) {
      bucket.lastRequestAt = rowTime;
    }
    return;
  }
  if (row?.type === 'full_compaction.complete' || row?.type === 'turn.cancel') {
    // Both close an in-flight generation: a compaction completes its
    // request, and a cancelled (ESC) generation will never see a step.end —
    // without this the live ticker would stick until the window expires.
    if (rowTime !== null && (bucket.lastStepEndAt === null || rowTime > bucket.lastStepEndAt)) {
      bucket.lastStepEndAt = rowTime;
    }
    return;
  }
  if (row?.type === 'config.update') {
    // Only the main agent drives the displayed model alias / thinking level.
    if (agent !== 'main') return;
    const modelAlias =
      typeof row.modelAlias === 'string' && row.modelAlias ? row.modelAlias : null;
    if (modelAlias && modelAlias !== state.modelAlias) {
      // A first observed alias after samples is also unsafe: those samples
      // cannot be attributed to the new model with confidence.
      const hasSamples = Object.values(state.agents).some(
        (a) => a.samples.length > 0 || a.lastTtftMs !== null,
      );
      if (state.modelAlias || hasSamples) {
        resetFleetWindows(state);
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
    // Goal mode is main-agent only; the badge state reducer lives in
    // goal.mjs.
    if (agent !== 'main') return;
    state.goal = applyGoalOp(state.goal ?? null, row);
    return;
  }
  if (row?.type === 'swarm_mode.enter' || row?.type === 'swarm_mode.exit') {
    // The status-line payload carries no swarm flag; these journal lines
    // are the only structured record of the mode. `trigger` ("manual" vs a
    // /swarm <task> prompt) does not matter for the badge.
    if (agent !== 'main') return;
    state.swarmMode = row.type === 'swarm_mode.enter';
    return;
  }
  if (row?.type !== 'context.append_loop_event') return;
  const ev = row.event;
  if (!ev || ev.type !== 'step.end') return;
  if (rowTime !== null && (bucket.lastStepEndAt === null || rowTime > bucket.lastStepEndAt)) {
    bucket.lastStepEndAt = rowTime;
  }
  if (Number.isFinite(ev.llmFirstTokenLatencyMs) && ev.llmFirstTokenLatencyMs >= 0) {
    bucket.lastTtftMs = ev.llmFirstTokenLatencyMs;
  }
  const out = ev.usage && typeof ev.usage.output === 'number' ? ev.usage.output : 0;
  const streamMs = typeof ev.llmStreamDurationMs === 'number' ? ev.llmStreamDurationMs : 0;
  const tps = out / (streamMs / 1000);
  if (
    Number.isFinite(out) &&
    out > 0 &&
    Number.isFinite(streamMs) &&
    streamMs >= MIN_STREAM_MS &&
    Number.isFinite(tps) &&
    tps <= MAX_TPS &&
    rowTime !== null
  ) {
    if (
      Number.isFinite(bucket.lastSampleAt) &&
      rowTime - bucket.lastSampleAt > TPS_TTL_MS
    ) {
      // Do not let a new sample revive an otherwise stale window.
      bucket.samples = [];
    }
    bucket.samples.push({ v: tps, t: rowTime });
    if (bucket.samples.length > MAX_STORED_SAMPLES) {
      bucket.samples.splice(0, bucket.samples.length - MAX_STORED_SAMPLES);
    }
    bucket.lastSampleAt = rowTime;
    if (bucket.samples.length >= MIN_SAMPLES) {
      // Remember the last full-window median so an expired window can stay
      // visible (dimmed) instead of disappearing. A gap clear above only
      // empties the live window; the median survives until a model switch
      // invalidates it.
      state.lastMedian = median(bucket.samples.slice(-MAX_SAMPLES).map((s) => s.v));
    }
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
 * Restore only the latest complete cache turn before the saved metrics byte
 * offset. The read is capped so an upgrade cannot turn the 300ms hot path into
 * an unbounded historical scan. Missing boundaries intentionally leave the
 * metric hidden until the next turn.prompt.
 */
function restoreCacheState(wirePath, state) {
  const end = Math.max(0, Math.floor(state.agents?.main?.offset ?? 0));
  resetCacheState(state, { needsPrompt: end > 0 });
  if (end === 0) {
    state.cacheScanV = CACHE_SCAN_V;
    return;
  }

  const len = Math.min(end, CACHE_BACKFILL_MAX_BYTES);
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
  state.cacheScanV = CACHE_SCAN_V;
}

/** True when a raw line might carry a backfill-tracked key (cheap prefilter). */
function isBackfillLine(line) {
  return (
    line.includes('"thinkingEffort"') ||
    line.includes('"thinkingLevel"') ||
    line.includes('"modelAlias"') ||
    line.includes('"type":"goal.') ||
    line.includes('"type":"forked"') ||
    line.includes('"type":"swarm_mode.')
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
 * Incrementally read the session's wire logs (main agent + every subagent)
 * and return current speed metrics, thinking level, goal/swarm state and
 * cache usage.
 *
 * Samples are timestamped and bucketed per agent: only the freshest
 * MAX_SAMPLES within SAMPLE_WINDOW_MS feed an agent's median, so resume
 * continuations, long idle gaps and compactions never mix stale numbers in.
 * Agents with a request in flight or a sample newer than ACTIVE_WINDOW_MS
 * count as active: with several active (swarm/subagent runs) the result
 * carries the fleet total (`tpsTotal`), the per-agent average (`tps`) and
 * the head count (`activeAgents`), and TTFT is the median across active
 * agents so one stuck agent cannot poison the display. A single active
 * agent keeps the hardened MIN_SAMPLES gate; an idle session falls back to
 * the last full-window median (flagged stale). `generatingSince` is set
 * while any agent has a request in flight.
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {{tps: number|null, tpsStale: boolean, ttftMs: number|null, thinkingLevel: string|null, goal: object|null, modelAlias: string|null, swarmMode: boolean, cache: object|null, tpsTotal: number|null, activeAgents: number, generatingSince: number|null}}
 */
export function getMetrics(sessionId, {
  sessionsRoot = SESSIONS_ROOT,
  stateDir = HUD_DIR,
  now = Date.now(),
} = {}) {
  const empty = {
    tps: null, tpsStale: false, ttftMs: null, thinkingLevel: null, goal: null,
    modelAlias: null, swarmMode: false, cache: null,
    tpsTotal: null, activeAgents: 0, generatingSince: null,
  };
  try {
    if (!sessionId) return empty;
    const sessionDir = findSessionDir(sessionId, sessionsRoot);
    if (!sessionDir) return empty;
    const statePath = statePathFor(sessionId, stateDir);
    const state = loadState(statePath);
    let stateChanged = false;

    // Enumerate every agent wire (main + subagents).
    const agentsDir = path.join(sessionDir, 'agents');
    const wires = [];
    try {
      for (const ent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const p = path.join(agentsDir, ent.name, 'wire.jsonl');
        try {
          if (fs.statSync(p).isFile()) wires.push({ agent: ent.name, path: p });
        } catch {
          // no wire for this agent
        }
      }
    } catch {
      return empty;
    }
    if (!wires.length) return empty;
    // main first so its config.update/goal/swarm events apply deterministically.
    wires.sort((a, b) => (a.agent === 'main' ? -1 : b.agent === 'main' ? 1 : a.agent.localeCompare(b.agent)));

    for (const { agent, path: wirePath } of wires) {
      const stat = fs.statSync(wirePath);
      const size = stat.size;
      const fileId = `${stat.dev}:${stat.ino}`;
      const isNew = !state.agents[agent];
      const a = normAgent(state.agents[agent]);
      state.agents[agent] = a;
      if (isNew) stateChanged = true;
      // A smaller file was truncated in place; a different device/inode means
      // log rotation or replacement. In either case, old samples and offsets
      // no longer describe this stream and are discarded together. On the
      // main wire the derived state resets as well — the incremental pass
      // below re-derives it from the new stream.
      if (a.offset > size || (a.fileId && a.fileId !== fileId)) {
        a.offset = 0;
        a.samples = [];
        a.lastTtftMs = null;
        a.lastSampleAt = null;
        a.lastRequestAt = null;
        a.lastStepEndAt = null;
        if (agent === 'main') {
          state.goal = null;
          state.thinkingLevel = null;
          state.modelAlias = null;
          state.lastMedian = null;
          state.swarmMode = false;
          resetCacheState(state);
          delete state.cacheScanV;
          delete state.backfillScanV;
        }
        stateChanged = true;
      }
      if (a.fileId !== fileId) {
        a.fileId = fileId;
        stateChanged = true;
      }
      if (agent === 'main') {
        // One-time backfill: sessions whose offset predates a tracked key
        // would otherwise never see earlier events (initial config.update,
        // goal.create, swarm_mode.enter). Only worth a separate prefiltered
        // full scan when the offset sits past those events — a fresh state
        // (offset 0) consumes every row in the incremental pass below, and a
        // second full read would just duplicate it.
        if ((state.backfillScanV ?? 0) < BACKFILL_SCAN_V) {
          if (a.offset > 0) {
            try {
              const text = fs.readFileSync(wirePath, 'utf8');
              for (const line of text.split('\n')) {
                if (!isBackfillLine(line)) continue;
                try {
                  processWireRow(state, JSON.parse(line), 'main');
                } catch {
                  // keep scanning
                }
              }
            } catch {
              // stay silent
            }
          }
          state.backfillScanV = BACKFILL_SCAN_V;
          stateChanged = true;
        }
        if ((state.cacheScanV ?? 0) < CACHE_SCAN_V) {
          try {
            restoreCacheState(wirePath, state);
          } catch {
            // Do not accept a partial current turn when restoration failed.
            // Leave the version unset so a later refresh can retry.
            resetCacheState(state, { needsPrompt: true });
          }
          stateChanged = true;
        }
      }
      if (size > a.offset) {
        const fd = fs.openSync(wirePath, 'r');
        try {
          const len = size - a.offset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, a.offset);
          const text = buf.toString('utf8');
          const lastNl = text.lastIndexOf('\n');
          if (lastNl >= 0) {
            processWireChunk(state, text.slice(0, lastNl + 1), agent);
            a.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
            stateChanged = true;
          }
          // else: no complete line yet, keep offset for next run
        } finally {
          fs.closeSync(fd);
        }
      }
    }

    // Aggregate per agent: expire samples outside the freshness window,
    // then split agents into active (in-flight request or recent sample)
    // and idle.
    const activeSpeeds = [];
    const activeTtfts = [];
    let generatingSince = null;
    let activeAgents = 0;
    let soleActive = null;
    for (const [name, a] of Object.entries(state.agents)) {
      const fresh = a.samples.filter(
        (s) => s && typeof s.v === 'number' && typeof s.t === 'number' && s.t >= now - SAMPLE_WINDOW_MS,
      );
      if (fresh.length !== a.samples.length) {
        a.samples = fresh;
        stateChanged = true;
      }
      const speed = median(fresh.slice(-MAX_SAMPLES).map((s) => s.v));
      const generating = a.lastRequestAt !== null
        && now - a.lastRequestAt < SAMPLE_WINDOW_MS
        && (a.lastStepEndAt === null || a.lastRequestAt > a.lastStepEndAt);
      const recent = fresh.length > 0 && fresh[fresh.length - 1].t >= now - ACTIVE_WINDOW_MS;
      if (generating && (generatingSince === null || a.lastRequestAt > generatingSince)) {
        generatingSince = a.lastRequestAt;
      }
      if (!generating && !recent) continue;
      activeAgents += 1;
      soleActive = { name, bucket: a, fresh, speed };
      if (speed !== null) activeSpeeds.push(speed);
      if (a.lastTtftMs !== null && a.lastSampleAt !== null && a.lastSampleAt >= now - SAMPLE_WINDOW_MS) {
        activeTtfts.push(a.lastTtftMs);
      }
    }

    if (stateChanged) saveState(statePath, state);

    let tps = null;
    let tpsStale = false;
    let tpsTotal = null;
    let ttftMs = null;
    const lastMedian = typeof state.lastMedian === 'number' ? state.lastMedian : null;
    if (activeAgents >= 2) {
      // Fleet: true per-agent average + total. TTFT is the median across
      // active agents (one stuck agent, e.g. a provider retry with a 10min
      // first token, cannot poison the display).
      if (activeSpeeds.length > 0) {
        tpsTotal = activeSpeeds.reduce((sum, v) => sum + v, 0);
        tps = tpsTotal / activeSpeeds.length;
      }
      ttftMs = median(activeTtfts);
    } else if (activeAgents === 1) {
      // Solo: keep the hardened single-window gate — a live window needs
      // MIN_SAMPLES samples whose newest is inside the TTL; otherwise the
      // last median survives (dimmed) until a model switch cleared it.
      const values = soleActive.fresh.slice(-MAX_SAMPLES).map((s) => s.v);
      const windowMedian = soleActive.fresh.length >= MIN_SAMPLES ? median(values) : null;
      const newest = soleActive.fresh.length
        ? soleActive.fresh[soleActive.fresh.length - 1].t
        : null;
      const freshWindow =
        windowMedian !== null && newest !== null && now - newest <= TPS_TTL_MS;
      if (freshWindow) {
        tps = windowMedian;
      } else if (lastMedian !== null) {
        tps = lastMedian;
        tpsStale = true;
      }
      ttftMs = soleActive.bucket.lastTtftMs ?? null;
    } else {
      if (lastMedian !== null) {
        tps = lastMedian;
        tpsStale = true;
      }
      ttftMs = state.agents.main?.lastTtftMs ?? null;
    }

    return {
      tps,
      tpsStale,
      ttftMs,
      thinkingLevel: state.thinkingLevel ?? null,
      goal: state.goal ?? null,
      modelAlias: state.modelAlias ?? null,
      swarmMode: state.swarmMode === true,
      cache: cacheMetricFromState(state),
      tpsTotal,
      activeAgents,
      generatingSince,
    };
  } catch {
    return empty;
  }
}
