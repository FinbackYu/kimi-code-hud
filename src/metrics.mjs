import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HUD_DIR } from './quota.mjs';

export const SESSIONS_ROOT = path.join(os.homedir(), '.kimi-code', 'sessions');

const MAX_SAMPLES = 5;
const MIN_STREAM_MS = 50;
// Speed samples expire: after a resume / idle gap / compaction the pre-gap
// numbers describe a different workload and must not leak into the median.
const SAMPLE_WINDOW_MS = 10 * 60 * 1000;
// Bound the persisted sample array; only the freshest MAX_SAMPLES are used.
const MAX_STORED_SAMPLES = 50;
// Backfill scan version; bump when the config.update key set changes so
// existing state files re-scan once (v2: added `thinkingEffort`).
const THINKING_SCAN_V = 2;
// State format version; v3: per-agent offsets + timestamped samples + goal.
const STATE_V = 3;

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

function emptyState() {
  return {
    v: STATE_V,
    agents: {},
    samples: [],
    lastTtftMs: null,
    lastSampleAt: null,
    lastRequestAt: null,
    lastStepEndAt: null,
    thinkingLevel: null,
    goal: null,
  };
}

/**
 * Load the persisted state, migrating pre-v3 files: the legacy single-wire
 * offset becomes agents.main, and untimestamped numeric samples are kept
 * with t=0 so they expire immediately (they predate the window clock).
 */
function loadState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (s && typeof s === 'object') {
      if ((s.v ?? 0) >= STATE_V && s.agents && typeof s.agents === 'object') {
        if (!Array.isArray(s.samples)) s.samples = [];
        s.lastRequestAt = typeof s.lastRequestAt === 'number' ? s.lastRequestAt : null;
        s.lastStepEndAt = typeof s.lastStepEndAt === 'number' ? s.lastStepEndAt : null;
        return s;
      }
      // legacy migration (v1/v2)
      const migrated = emptyState();
      if (typeof s.offset === 'number' && s.offset > 0) {
        migrated.agents.main = { offset: s.offset, fileId: s.fileId ?? null };
      }
      if (Array.isArray(s.samples)) {
        migrated.samples = s.samples
          .filter((v) => typeof v === 'number')
          .map((v) => ({ v, t: 0 }));
      }
      migrated.lastTtftMs = typeof s.lastTtftMs === 'number' ? s.lastTtftMs : null;
      migrated.lastSampleAt = null;
      migrated.thinkingLevel = typeof s.thinkingLevel === 'string' ? s.thinkingLevel : null;
      if (typeof s.thinkingScanV === 'number') migrated.thinkingScanV = s.thinkingScanV;
      migrated.legacyV = s.v ?? 0;
      return migrated;
    }
  } catch {
    // fall through
  }
  return emptyState();
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
 * Feed a text chunk of wire.jsonl lines into the metrics state.
 * Only complete lines (terminated by \n) are consumed; the caller tracks
 * the byte offset so an incomplete tail is retried next run.
 * Speed samples are timestamped with the wire row's own `time`, so samples
 * from before a resume/idle gap can be expired at read time.
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
    const rowTime = typeof row?.time === 'number' ? row.time : Date.now();
    if (row?.type === 'llm.request') {
      // A loop request without a later step.end means the model is
      // generating right now. Compaction requests never produce a
      // step.end, so they must not mark the session as generating.
      if (row.kind !== 'compaction' && (state.lastRequestAt === null || rowTime > state.lastRequestAt)) {
        state.lastRequestAt = rowTime;
      }
      continue;
    }
    if (row?.type === 'full_compaction.complete') {
      // Ends a compaction request's in-flight window (see above).
      if (state.lastStepEndAt === null || rowTime > state.lastStepEndAt) {
        state.lastStepEndAt = rowTime;
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
    if (row?.type === 'goal.create') {
      // A fresh goal replaces any previous one: reset the counters so a
      // completed goal's turns/tokens never leak into the new badge.
      if (agent !== 'main') continue;
      state.goal = {
        status: null,
        objective: typeof row.objective === 'string' ? row.objective : null,
        wallClockMs: null,
        turnsUsed: null,
        tokensUsed: null,
        at: rowTime,
      };
      continue;
    }
    if (row?.type === 'goal.clear') {
      if (agent !== 'main') continue;
      state.goal = null;
      continue;
    }
    if (row?.type === 'goal.update') {
      // Goal mode is main-agent only. The status-line payload carries no
      // goal fields, so the badge is reconstructed from these wire events:
      // status transitions set status/wallClockMs, and frequent
      // turnsUsed/tokensUsed heartbeats keep the counters current.
      if (agent !== 'main') continue;
      if (!state.goal) {
        state.goal = { status: null, wallClockMs: null, turnsUsed: null, tokensUsed: null, at: null };
      }
      if (typeof row.status === 'string') {
        state.goal.status = row.status;
        if (typeof row.wallClockMs === 'number') state.goal.wallClockMs = row.wallClockMs;
        state.goal.at = rowTime;
      }
      if (typeof row.turnsUsed === 'number') state.goal.turnsUsed = row.turnsUsed;
      if (typeof row.tokensUsed === 'number') state.goal.tokensUsed = row.tokensUsed;
      continue;
    }
    if (row?.type !== 'context.append_loop_event') continue;
    const ev = row.event;
    if (!ev || ev.type !== 'step.end') continue;
    if (state.lastStepEndAt === null || rowTime > state.lastStepEndAt) {
      state.lastStepEndAt = rowTime;
    }
    if (typeof ev.llmFirstTokenLatencyMs === 'number' && ev.llmFirstTokenLatencyMs >= 0) {
      // Chunks are processed main-first then subagents; an older subagent
      // sample must not overwrite a fresher TTFT.
      if (state.lastSampleAt === null || rowTime >= state.lastSampleAt) {
        state.lastTtftMs = ev.llmFirstTokenLatencyMs;
        state.lastSampleAt = rowTime;
      }
    }
    const out = ev.usage && typeof ev.usage.output === 'number' ? ev.usage.output : 0;
    const streamMs = typeof ev.llmStreamDurationMs === 'number' ? ev.llmStreamDurationMs : 0;
    if (out > 0 && streamMs >= MIN_STREAM_MS) {
      state.samples.push({ v: out / (streamMs / 1000), t: rowTime });
      if (state.samples.length > MAX_STORED_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_STORED_SAMPLES);
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
 * One-time scan of the whole main wire for lines matching `substr`,
 * feeding them through processWireChunk. Used for backfills after a state
 * format bump. The substring prefilter keeps this fast on multi-MB logs.
 */
function backfillScan(state, wirePath, substr) {
  try {
    const text = fs.readFileSync(wirePath, 'utf8');
    const hits = text.split('\n').filter((l) => l.includes(substr));
    if (hits.length) processWireChunk(state, hits.join('\n') + '\n', 'main');
  } catch {
    // stay silent
  }
}

/**
 * Incrementally read the session's wire logs (main agent + all subagents)
 * and return current speed metrics, thinking level and goal state.
 * Per-agent byte offsets are persisted so each 1s run only parses newly
 * appended bytes. Subagent step.end samples pool with the main agent's —
 * parallel agents contribute real generated tokens too. Samples older than
 * SAMPLE_WINDOW_MS are dropped at read time, so a resumed session does not
 * inherit speed numbers from its previous life.
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {{tps: number|null, ttftMs: number|null, thinkingLevel: string|null, goal: object|null, generatingSince: number|null}}
 */
export function getMetrics(sessionId, {
  sessionsRoot = SESSIONS_ROOT,
  stateDir = HUD_DIR,
  now = Date.now(),
} = {}) {
  const empty = { tps: null, ttftMs: null, thinkingLevel: null, goal: null, generatingSince: null };
  try {
    if (!sessionId) return empty;
    const sessionDir = findSessionDir(sessionId, sessionsRoot);
    if (!sessionDir) return empty;
    const statePath = statePathFor(sessionId, stateDir);
    const state = loadState(statePath);
    let stateChanged = state.legacyV !== undefined;

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

    // One-time backfill for states written before thinking tracking
    // (v2 also matches the newer `thinkingEffort` key).
    const mainWire = wires.find((w) => w.agent === 'main');
    if ((state.thinkingScanV ?? 0) < THINKING_SCAN_V) {
      if (mainWire) {
        try {
          const text = fs.readFileSync(mainWire.path, 'utf8');
          for (const line of text.split('\n')) {
            if (!line.includes('"thinkingEffort"') && !line.includes('"thinkingLevel"')) continue;
            try {
              const row = JSON.parse(line);
              if (row?.type !== 'config.update') continue;
              const level = typeof row.thinkingEffort === 'string' ? row.thinkingEffort
                : typeof row.thinkingLevel === 'string' ? row.thinkingLevel : null;
              if (level) state.thinkingLevel = level;
            } catch {
              // keep scanning
            }
          }
        } catch {
          // stay silent
        }
      }
      state.thinkingScanV = THINKING_SCAN_V;
      delete state.thinkingScanDone; // legacy v1 marker
      stateChanged = true;
    }

    // One-time goal backfill for states migrated from pre-v3: their main
    // offset already sits past earlier goal.create/goal.update events.
    if (state.legacyV !== undefined && mainWire) {
      backfillScan(state, mainWire.path, '"goal.');
    }
    delete state.legacyV;

    for (const { agent, path: wirePath } of wires) {
      const stat = fs.statSync(wirePath);
      const size = stat.size;
      const fileId = `${stat.dev}:${stat.ino}`;
      let a = state.agents[agent];
      if (!a || typeof a.offset !== 'number') {
        a = state.agents[agent] = { offset: 0, fileId };
        stateChanged = true;
      }
      // A smaller file was truncated in place; a different device/inode
      // means rotation/replacement. Old samples describe a different
      // stream, so discard them together with this agent's offset.
      if (a.offset > size || (a.fileId && a.fileId !== fileId)) {
        a.offset = 0;
        state.samples = [];
        state.lastTtftMs = null;
        state.lastSampleAt = null;
        state.lastRequestAt = null;
        state.lastStepEndAt = null;
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

    // Drop samples outside the freshness window (resume/idle/compaction
    // boundaries) and keep the newest MAX_SAMPLES for the median.
    const fresh = state.samples.filter((s) => s && typeof s.v === 'number' && s.t >= now - SAMPLE_WINDOW_MS);
    const windowed = fresh.slice(-MAX_SAMPLES);
    if (fresh.length !== state.samples.length) stateChanged = true;
    state.samples = fresh;

    if (stateChanged) saveState(statePath, state);

    const ttftFresh = state.lastSampleAt !== null && state.lastSampleAt >= now - SAMPLE_WINDOW_MS;
    // A loop request newer than the last completed step means the model is
    // generating right now; the renderer ticks the elapsed time every
    // refresh so the speed segment stays live during long steps. The window
    // cap guards against an aborted generation that left no step.end.
    const generating = state.lastRequestAt !== null
      && now - state.lastRequestAt < SAMPLE_WINDOW_MS
      && (state.lastStepEndAt === null || state.lastRequestAt > state.lastStepEndAt);
    return {
      tps: median(windowed.map((s) => s.v)),
      ttftMs: ttftFresh ? state.lastTtftMs ?? null : null,
      thinkingLevel: state.thinkingLevel ?? null,
      goal: state.goal && state.goal.status ? state.goal : null,
      generatingSince: generating ? state.lastRequestAt : null,
    };
  } catch {
    return empty;
  }
}
