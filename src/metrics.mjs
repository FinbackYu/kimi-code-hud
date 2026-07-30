import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HUD_DIR } from './quota.mjs';
import { applyGoalOp } from './goal.mjs';

export const SESSIONS_ROOT = path.join(os.homedir(), '.kimi-code', 'sessions');

const MAX_SAMPLES = 5;
const MIN_STREAM_MS = 50;
// Speed samples expire: after a resume / idle gap / compaction the pre-gap
// numbers describe a different workload and must not leak into the median.
const SAMPLE_WINDOW_MS = 10 * 60 * 1000;
// An agent counts as active (for the swarm total/average) when it produced
// a sample within this window or has a request in flight.
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
// Bound the persisted per-agent sample array; only the freshest MAX_SAMPLES
// are used.
const MAX_STORED_SAMPLES = 20;
// Backfill scan version; bump when the tracked key set changes so existing
// state files re-scan once (v2: added `thinkingEffort`; v3: goal ops).
const BACKFILL_SCAN_V = 3;
// State format version; v4: per-agent sample buckets (v3 pooled them).
const STATE_V = 4;

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
  return {
    v: STATE_V,
    agents: {},
    thinkingLevel: null,
    goal: null,
  };
}

/**
 * Load the persisted state, migrating older formats:
 * - v1/v2: single-wire offset becomes agents.main; untimestamped numeric
 *   samples are kept with t=0 so they expire immediately.
 * - v3: pooled top-level samples/counters move into the main bucket.
 * Backfill markers (backfillScanV / legacy thinkingScanV) carry over so a
 * bump of BACKFILL_SCAN_V re-scans every pre-existing state exactly once.
 */
function loadState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!s || typeof s !== 'object') return emptyState();
    if ((s.v ?? 0) >= STATE_V && s.agents && typeof s.agents === 'object') {
      for (const name of Object.keys(s.agents)) s.agents[name] = normAgent(s.agents[name]);
      return s;
    }
    const migrated = emptyState();
    if ((s.v ?? 0) >= 3 && s.agents && typeof s.agents === 'object') {
      // v3: per-agent offsets already fine; pooled top-level samples and
      // counters move into the main bucket without touching its offset.
      for (const [name, a] of Object.entries(s.agents)) {
        migrated.agents[name] = normAgent(a);
      }
      const m = migrated.agents.main ?? (migrated.agents.main = emptyAgent());
      if (Array.isArray(s.samples)) m.samples = s.samples;
      if (typeof s.lastTtftMs === 'number') m.lastTtftMs = s.lastTtftMs;
      if (typeof s.lastSampleAt === 'number') m.lastSampleAt = s.lastSampleAt;
      if (typeof s.lastRequestAt === 'number') m.lastRequestAt = s.lastRequestAt;
      if (typeof s.lastStepEndAt === 'number') m.lastStepEndAt = s.lastStepEndAt;
    } else {
      // v1/v2 legacy: single-wire offset becomes the main bucket;
      // untimestamped numeric samples get t=0 and expire immediately.
      const main = emptyAgent();
      if (typeof s.offset === 'number' && s.offset > 0) {
        main.offset = s.offset;
        main.fileId = typeof s.fileId === 'string' ? s.fileId : null;
        migrated.agents.main = main;
      }
      if (Array.isArray(s.samples)) {
        main.samples = s.samples.filter((v) => typeof v === 'number').map((v) => ({ v, t: 0 }));
      }
      main.lastTtftMs = typeof s.lastTtftMs === 'number' ? s.lastTtftMs : null;
    }
    migrated.thinkingLevel = typeof s.thinkingLevel === 'string' ? s.thinkingLevel : null;
    if (typeof s.backfillScanV === 'number') migrated.backfillScanV = s.backfillScanV;
    else if (typeof s.thinkingScanV === 'number') migrated.backfillScanV = s.thinkingScanV;
    if (s.goal && typeof s.goal === 'object') migrated.goal = s.goal;
    return migrated;
  } catch {
    return emptyState();
  }
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

/** True when a raw line might carry a backfill-tracked key (cheap prefilter). */
function isBackfillLine(line) {
  return (
    line.includes('"thinkingEffort"') ||
    line.includes('"thinkingLevel"') ||
    line.includes('"type":"goal.') ||
    line.includes('"type":"forked"')
  );
}

/**
 * Feed a text chunk of wire.jsonl lines into the metrics state.
 * Only complete lines (terminated by \n) are consumed; the caller tracks
 * the byte offset so an incomplete tail is retried next run.
 * Speed samples are timestamped with the wire row's own `time` and bucketed
 * per agent, so swarm totals/averages can be computed per agent and stale
 * samples (resume/idle/compaction) can be expired at read time.
 * Thinking level and goal ops are main-agent only.
 * @param {object} state mutated in place
 * @param {string} text complete lines only
 * @param {string} [agent] which agent's wire this chunk comes from
 */
export function processWireChunk(state, text, agent = 'main') {
  if (!state.agents || typeof state.agents !== 'object') state.agents = {};
  const bucket = normAgent(state.agents[agent]);
  state.agents[agent] = bucket;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const rowTime = typeof row?.time === 'number' ? row.time : Date.now();
    if (row?.type === 'llm.request') {
      // A loop request without a later step.end means the model is
      // generating right now. Compaction requests never produce a
      // step.end, so they must not mark the agent as generating.
      if (row.kind !== 'compaction' && (bucket.lastRequestAt === null || rowTime > bucket.lastRequestAt)) {
        bucket.lastRequestAt = rowTime;
      }
      continue;
    }
    if (row?.type === 'full_compaction.complete') {
      // Ends a compaction request's in-flight window (see above).
      if (bucket.lastStepEndAt === null || rowTime > bucket.lastStepEndAt) {
        bucket.lastStepEndAt = rowTime;
      }
      continue;
    }
    if (row?.type === 'config.update') {
      // Only the main agent drives the displayed thinking level.
      if (agent !== 'main') continue;
      // Latest thinking level wins ("on"/"off" for boolean models, or a
      // concrete effort like "high"/"max" for effort-capable ones). New
      // hosts write `thinkingEffort` (including an initial event at
      // session start); older hosts wrote `thinkingLevel`.
      const level = typeof row.thinkingEffort === 'string' ? row.thinkingEffort
        : typeof row.thinkingLevel === 'string' ? row.thinkingLevel : null;
      if (level) state.thinkingLevel = level;
      continue;
    }
    if (
      row?.type === 'goal.create'
      || row?.type === 'goal.update'
      || row?.type === 'goal.clear'
      || row?.type === 'forked'
    ) {
      // Goal mode is main-agent only; the badge state reducer lives in
      // goal.mjs (status, turns, optional turn budget, wall-clock anchors).
      if (agent !== 'main') continue;
      state.goal = applyGoalOp(state.goal ?? null, row);
      continue;
    }
    if (row?.type !== 'context.append_loop_event') continue;
    const ev = row.event;
    if (!ev || ev.type !== 'step.end') continue;
    if (bucket.lastStepEndAt === null || rowTime > bucket.lastStepEndAt) {
      bucket.lastStepEndAt = rowTime;
    }
    if (typeof ev.llmFirstTokenLatencyMs === 'number' && ev.llmFirstTokenLatencyMs >= 0) {
      // Chunks arrive oldest-first within a wire, but guard anyway: an
      // older sample must never overwrite a fresher TTFT.
      if (bucket.lastSampleAt === null || rowTime >= bucket.lastSampleAt) {
        bucket.lastTtftMs = ev.llmFirstTokenLatencyMs;
        bucket.lastSampleAt = rowTime;
      }
    }
    const out = ev.usage && typeof ev.usage.output === 'number' ? ev.usage.output : 0;
    const streamMs = typeof ev.llmStreamDurationMs === 'number' ? ev.llmStreamDurationMs : 0;
    if (out > 0 && streamMs >= MIN_STREAM_MS) {
      bucket.samples.push({ v: out / (streamMs / 1000), t: rowTime });
      if (bucket.samples.length > MAX_STORED_SAMPLES) {
        bucket.samples.splice(0, bucket.samples.length - MAX_STORED_SAMPLES);
      }
    }
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
 * One-time scan of the whole main wire for backfill-tracked lines (thinking
 * level, goal ops), feeding them through processWireChunk. The substring
 * prefilter keeps this fast on multi-MB logs.
 */
function backfillScan(state, wirePath) {
  try {
    const text = fs.readFileSync(wirePath, 'utf8');
    const hits = text.split('\n').filter(isBackfillLine);
    if (hits.length) processWireChunk(state, hits.join('\n') + '\n', 'main');
  } catch {
    // stay silent
  }
}

/**
 * Incrementally read the session's wire logs (main agent + all subagents)
 * and return speed metrics, thinking level and goal state.
 *
 * Samples are bucketed per agent. Agents with a request in flight or a
 * sample newer than ACTIVE_WINDOW_MS count as active: when several are
 * active (swarm/subagent runs) the result carries the per-agent average
 * (`tps`), the fleet total (`tpsTotal`) and the head count
 * (`activeAgents`); TTFT is the median across active agents so one stuck
 * agent cannot poison the display. Samples older than SAMPLE_WINDOW_MS are
 * dropped at read time, so a resumed session does not inherit speed
 * numbers from its previous life.
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {{tps: number|null, tpsTotal: number|null, activeAgents: number, ttftMs: number|null, thinkingLevel: string|null, goal: object|null, generatingSince: number|null}}
 */
export function getMetrics(sessionId, {
  sessionsRoot = SESSIONS_ROOT,
  stateDir = HUD_DIR,
  now = Date.now(),
} = {}) {
  const empty = {
    tps: null, tpsTotal: null, activeAgents: 0, ttftMs: null,
    thinkingLevel: null, goal: null, generatingSince: null,
  };
  try {
    if (!sessionId) return empty;
    const sessionDir = findSessionDir(sessionId, sessionsRoot);
    if (!sessionDir) return empty;
    const statePath = statePathFor(sessionId, stateDir);
    const state = loadState(statePath);
    // Migrations in loadState are idempotent, so no forced save here; any
    // real change below (new agents, offsets, pruning) persists the state.
    let stateChanged = false;

    // Enumerate every agent wire (main + agent-N subagents).
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
    // main first so its config.update/goal events apply deterministically.
    wires.sort((a, b) => (a.agent === 'main' ? -1 : b.agent === 'main' ? 1 : a.agent.localeCompare(b.agent)));

    // One-time backfill for states written before a tracked key existed
    // (v2: thinkingEffort; v3: goal ops). The main offset already sits
    // past those events, so the whole main wire is re-scanned once.
    const mainWire = wires.find((w) => w.agent === 'main');
    if ((state.backfillScanV ?? 0) < BACKFILL_SCAN_V) {
      if (mainWire) backfillScan(state, mainWire.path);
      state.backfillScanV = BACKFILL_SCAN_V;
      delete state.thinkingScanV; // legacy v1/v2 marker
      delete state.thinkingScanDone; // legacy v1 marker
      stateChanged = true;
    }

    for (const { agent, path: wirePath } of wires) {
      const stat = fs.statSync(wirePath);
      const size = stat.size;
      const fileId = `${stat.dev}:${stat.ino}`;
      const isNew = !state.agents[agent];
      const a = normAgent(state.agents[agent]);
      state.agents[agent] = a;
      if (isNew) stateChanged = true;
      // A smaller file was truncated in place; a different device/inode
      // means rotation/replacement. Old samples describe a different
      // stream, so discard them together with this agent's offset. On the
      // main wire the derived goal/thinking state resets as well — the
      // next backfill re-derives it from the new stream.
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
          state.backfillScanV = 0;
        }
        stateChanged = true;
      }
      if (a.fileId !== fileId) {
        a.fileId = fileId;
        stateChanged = true;
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
    const freshSpeeds = [];
    let generatingSince = null;
    let activeAgents = 0;
    for (const a of Object.values(state.agents)) {
      const fresh = a.samples.filter((s) => s && typeof s.v === 'number' && s.t >= now - SAMPLE_WINDOW_MS);
      if (fresh.length !== a.samples.length) {
        a.samples = fresh;
        stateChanged = true;
      }
      const speed = median(fresh.slice(-MAX_SAMPLES).map((s) => s.v));
      if (speed !== null) freshSpeeds.push(speed);
      const generating = a.lastRequestAt !== null
        && now - a.lastRequestAt < SAMPLE_WINDOW_MS
        && (a.lastStepEndAt === null || a.lastRequestAt > a.lastStepEndAt);
      const recent = fresh.length > 0 && fresh[fresh.length - 1].t >= now - ACTIVE_WINDOW_MS;
      if (generating && (generatingSince === null || a.lastRequestAt > generatingSince)) {
        generatingSince = a.lastRequestAt;
      }
      if (!generating && !recent) continue;
      activeAgents += 1;
      if (speed !== null) activeSpeeds.push(speed);
      if (a.lastSampleAt !== null && a.lastSampleAt >= now - SAMPLE_WINDOW_MS && a.lastTtftMs !== null) {
        activeTtfts.push(a.lastTtftMs);
      }
    }

    if (stateChanged) saveState(statePath, state);

    // Active fleet: average + total. Idle: per-agent median of whatever is
    // still fresh. TTFT is the median across active agents (one stuck
    // agent, e.g. a provider retry with a 10min first token, cannot poison
    // the display); fall back to null when nothing active measured one.
    const tpsAvg = median(activeSpeeds.length ? activeSpeeds : freshSpeeds);
    return {
      tps: tpsAvg,
      tpsTotal: activeAgents > 1 && activeSpeeds.length
        ? activeSpeeds.reduce((sum, v) => sum + v, 0)
        : null,
      activeAgents,
      ttftMs: median(activeTtfts),
      thinkingLevel: state.thinkingLevel ?? null,
      goal: state.goal ?? null,
      generatingSince,
    };
  } catch {
    return empty;
  }
}
