import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HUD_DIR } from './quota.mjs';

export const SESSIONS_ROOT = path.join(os.homedir(), '.kimi-code', 'sessions');

const MAX_SAMPLES = 5;
const MIN_STREAM_MS = 50;

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
  return { offset: 0, samples: [], lastTtftMs: null, thinkingLevel: null };
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
    if (row?.type === 'config.update') {
      // Latest thinking level wins ("on"/"off" for boolean models, or a
      // concrete effort like "high"/"max" for effort-capable ones).
      if (typeof row.thinkingLevel === 'string') state.thinkingLevel = row.thinkingLevel;
      continue;
    }
    if (row?.type !== 'context.append_loop_event') continue;
    const ev = row.event;
    if (!ev || ev.type !== 'step.end') continue;
    if (typeof ev.llmFirstTokenLatencyMs === 'number' && ev.llmFirstTokenLatencyMs >= 0) {
      state.lastTtftMs = ev.llmFirstTokenLatencyMs;
    }
    const out = ev.usage && typeof ev.usage.output === 'number' ? ev.usage.output : 0;
    const streamMs = typeof ev.llmStreamDurationMs === 'number' ? ev.llmStreamDurationMs : 0;
    if (out > 0 && streamMs >= MIN_STREAM_MS) {
      state.samples.push(out / (streamMs / 1000));
      if (state.samples.length > MAX_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_SAMPLES);
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
 * Incrementally read the session wire log and return current speed metrics.
 * State (byte offset + samples) is persisted per session so each 1s run only
 * parses newly appended bytes. Handles truncation/rotation by resetting the
 * offset when it exceeds the file size. Never throws.
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {{tps: number|null, ttftMs: number|null}}
 */
export function getMetrics(sessionId, {
  sessionsRoot = SESSIONS_ROOT,
  stateDir = HUD_DIR,
} = {}) {
  const empty = { tps: null, ttftMs: null, thinkingLevel: null };
  try {
    if (!sessionId) return empty;
    const wirePath = findWirePath(sessionId, sessionsRoot);
    if (!wirePath) return empty;
    const statePath = statePathFor(sessionId, stateDir);
    const state = loadState(statePath);
    const size = fs.statSync(wirePath).size;
    if (state.offset > size) state.offset = 0; // truncated / rotated
    // One-time backfill: sessions whose offset predates thinkingLevel
    // tracking would otherwise never see their initial config.update.
    // The substring prefilter keeps this fast even on multi-MB logs.
    if (state.thinkingLevel == null && state.thinkingScanDone !== true) {
      try {
        const text = fs.readFileSync(wirePath, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.includes('"thinkingLevel"')) continue;
          try {
            const row = JSON.parse(line);
            if (row?.type === 'config.update' && typeof row.thinkingLevel === 'string') {
              state.thinkingLevel = row.thinkingLevel;
            }
          } catch {
            // keep scanning
          }
        }
      } catch {
        // stay silent
      }
      state.thinkingScanDone = true;
      saveState(statePath, state);
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
        }
        // else: no complete line yet, keep offset for next run
      } finally {
        fs.closeSync(fd);
      }
      saveState(statePath, state);
    }
    return {
      tps: median(state.samples),
      ttftMs: state.lastTtftMs ?? null,
      thinkingLevel: state.thinkingLevel ?? null,
    };
  } catch {
    return empty;
  }
}
