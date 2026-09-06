#!/usr/bin/env node
// H09 measurement half: a repeatable performance baseline for the render hot
// path. Every sample is a REAL `node bin/kimi-hud.mjs` process — spawn to
// exit — driven from a throwaway sandbox (HOME, KIMI_CODE_HOME and
// KIMI_HUD_HOME all point at a fresh temp dir), so no user configuration,
// credential or network is ever touched and all wire data is synthetic
// (built with the shared test fixture row builders in test/.helpers.mjs).
//
// Scenarios:
//   cold-cache      first-ever frame: no HUD state exists yet
//   warm-cache      steady-state frame after the readers caught up
//   long-wire       ~12k-row wire (~3MB): cold frame, budget-split catch-up
//                   frames, warm frame; includes >slice complete records so
//                   the reader's bounded-scan completion path is exercised
//   multi-agent     main + 8 subagents, each with its own wire backlog
//   oversized-line  wire ending in a ~1.6MB record without a newline: the
//                   persisted discard cursor path (no content is kept)
//   slow-io-config  slow I/O stand-in: KIMI_HUD_TUI_TOML points at a FIFO
//                   that this harness writes at ~1KB/4ms, so the render's
//                   synchronous config read blocks for a controlled 120ms
//                   (inside the internal budget) or 260ms (past the 220ms
//                   internal budget, at/over the host 300ms ceiling). The
//                   render cannot interrupt a blocked read, which is exactly
//                   the failure mode the budget cannot protect against.
//
// The absolute latencies are machine-specific by design; they must never
// become a CI gate. Results are printed (human table, or JSON with --json)
// and are meant to be archived outside the repository.

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  EVENT_TIME,
  llmRequest,
  stepEnd,
  turnEnded,
  turnPrompt,
} from '../test/.helpers.mjs';
import { RUNTIME_BUDGET_MS } from '../src/render-runtime.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'kimi-hud.mjs');
const HOST_CEILING_MS = 300;
const FRAME_TIMEOUT_MS = 10_000;
const FIFO_OPEN_TIMEOUT_MS = 5_000;
const MAX_CATCHUP_FRAMES = 40;
const SESSION_ID = 'benchsession';
const VERSION = '0.41.0';

const USAGE = `Usage: node scripts/bench-render.mjs [options]

Options:
  --samples <n>        samples per scenario row (default: 30; each sample is a
                       fresh sandbox, so scenarios with catch-up frames spawn
                       several processes per sample)
  --scenario <name>    run only these scenarios (comma separated, repeatable);
                       default: all
  --json               print the machine-readable result JSON to stdout
                       (the human table always goes to stderr)
  --help               show this help

Scenario names: cold-cache, warm-cache, long-wire, multi-agent,
oversized-line, slow-io-config
`;

// ---------------------------------------------------------------------------
// Synthetic wire data (same row shapes as the test fixtures, sanitized).

function turnBlock(index) {
  const time = EVENT_TIME + index * 1_000;
  return [
    turnPrompt(`bench prompt ${index}`, time),
    llmRequest({ time: time + 10 }),
    stepEnd({ output: 40 + (index % 20), time: time + 20, turnId: index, step: 1 }),
    stepEnd({ output: 10 + (index % 5), time: time + 30, turnId: index, step: 2 }),
    turnEnded({ time: time + 40, turnId: index }),
  ];
}

/** First `count` rows of a deterministic prompt/request/step/end sequence. */
export function mixedRows(count) {
  const rows = [];
  let index = 0;
  while (rows.length < count) rows.push(...turnBlock(index++));
  return rows.slice(0, count).join('\n') + '\n';
}

/** Subagent wires only carry loop events in this benchmark. */
export function subagentRows(count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const time = EVENT_TIME + i * 1_000;
    rows.push(stepEnd({
      output: 20 + (i % 10),
      time,
      turnId: i,
      step: 1,
      agentId: null,
    }));
    if (i % 10 === 9) rows.push(turnEnded({ time: time + 5, turnId: i }));
  }
  return rows.join('\n') + '\n';
}

/** Complete records larger than the 256KB warm slice: forces the reader's
 * single bounded scan that finishes one over-slice record in-frame. */
export function oversizedCompleteRows(sizes) {
  const rows = [];
  for (const size of sizes) {
    const head = '{"type":"turn.prompt","input":[{"type":"text","text":"';
    const tail = '"}],"origin":{"kind":"user"},"time":' + (EVENT_TIME + 7) + '}';
    const pad = 'x'.repeat(Math.max(0, size - head.length - tail.length));
    rows.push(head + pad + tail);
  }
  return rows.join('\n') + '\n';
}

/** One ~1.6MB record with NO trailing newline: the host is "mid-record" past
 * MAX_PARTIAL_LINE_BYTES, so the reader must persist discard progress. The
 * bytes are never parsed and never persisted anywhere. */
export function oversizedIncompleteLine(targetBytes) {
  const head = '{"type":"context.append_loop_event","event":{"type":"tool.result","turnId":9,"step":9,"toolCallId":"tool_bench","result":{"data":"';
  const pad = 'x'.repeat(Math.max(0, targetBytes - head.length - 4));
  return head + pad + '"}}';
}

// ---------------------------------------------------------------------------
// Sandbox + frame runner.

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-bench-')));
  const kimiHome = path.join(root, 'kimi-home');
  const hudHome = path.join(root, 'hud-home');
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.mkdirSync(hudHome, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    KIMI_CODE_HOME: kimiHome,
    KIMI_HUD_HOME: hudHome,
    NO_COLOR: '1',
  };
  return { root, env, kimiHome, hudHome };
}

function writeWire(sandbox, agentName, content) {
  const wirePath = path.join(
    sandbox.kimiHome, 'sessions', 'wd_1', `ses_${SESSION_ID}`, 'agents', agentName, 'wire.jsonl',
  );
  fs.mkdirSync(path.dirname(wirePath), { recursive: true });
  fs.writeFileSync(wirePath, content);
  const size = Buffer.byteLength(content);
  return { agent: agentName, path: wirePath, size };
}

function payloadFor(sandbox) {
  return JSON.stringify({
    model: 'K3',
    cwd: sandbox.root,
    gitBranch: '',
    permissionMode: 'manual',
    sessionId: SESSION_ID,
    version: VERSION,
  });
}

function statePathOf(sandbox) {
  return path.join(sandbox.hudHome, 'sessions', `metrics-${SESSION_ID}.json`);
}

function readState(sandbox) {
  try {
    return JSON.parse(fs.readFileSync(statePathOf(sandbox), 'utf8'));
  } catch {
    return null;
  }
}

/** True once every agent bucket AND the session-usage ledger reader reached
 * the end of its wire: after this, a frame does no wire reading at all. */
function isCaughtUp(sandbox, wires) {
  const state = readState(sandbox);
  if (!state || !state.agents) return false;
  for (const wire of wires) {
    const bucket = state.agents[wire.agent];
    if (!bucket || typeof bucket.offset !== 'number' || bucket.offset < wire.size) return false;
    const usageReader = state.sessionUsage?.agents?.[wire.agent]?.reader;
    if (!usageReader || typeof usageReader.offset !== 'number' || usageReader.offset < wire.size) {
      return false;
    }
  }
  return true;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serve `tui.toml` from a FIFO, writing ~1KB every 4ms for `dribbleMs`. The
 * render blocks inside its synchronous config read for exactly that span. */
async function dribbleFifo(fifoPath, dribbleMs) {
  let fd = null;
  const openDeadline = performance.now() + FIFO_OPEN_TIMEOUT_MS;
  while (fd === null) {
    if (performance.now() > openDeadline) {
      throw new Error('fifo writer never opened (child did not reach the config read)');
    }
    try {
      fd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (err) {
      if (err.code !== 'ENXIO' && err.code !== 'ENOENT') throw err;
      await delay(2);
    }
  }
  try {
    fs.writeSync(fd, '[theme]\nname = "dark"\n');
    const start = performance.now();
    const padding = Buffer.alloc(256, 0x0a); // blank TOML lines
    while (performance.now() - start < dribbleMs) {
      fs.writeSync(fd, padding);
      await delay(4);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function makeFifo(sandbox) {
  const fifoPath = path.join(sandbox.root, 'tui.toml.fifo');
  // Node exposes no mkfifo; the helper is standard on macOS and Linux. Where
  // it is missing, slow-io-config degrades to an explicit skipped row.
  execFileSync('mkfifo', [fifoPath], { stdio: 'ignore' });
  return fifoPath;
}

/**
 * Spawn one real CLI process and measure spawn-to-exit wall time.
 * `fifo: { path, dribbleMs }` serves the config read through a slow writer.
 */
async function spawnFrame({ sandbox, payload, fifo = null }) {
  const childEnv = { ...sandbox.env };
  let writerDone = Promise.resolve();
  if (fifo) {
    childEnv.KIMI_HUD_TUI_TOML = fifo.path;
    writerDone = dribbleFifo(fifo.path, fifo.dribbleMs).catch(() => {});
  }
  const t0 = performance.now();
  const child = spawn(process.execPath, [BIN], {
    cwd: sandbox.root,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(payload);
  const watchdog = setTimeout(() => child.kill('SIGKILL'), FRAME_TIMEOUT_MS);
  let code = null;
  try {
    [code] = await once(child, 'exit');
  } finally {
    clearTimeout(watchdog);
  }
  const ms = performance.now() - t0;
  await writerDone;
  return {
    ms,
    code,
    stdout,
    stderr,
    valid: code === 0 && stdout.trim().length > 0,
  };
}

/** Unmeasured frames until every reader caught up (bounded). */
async function runUntilCaughtUp(sandbox, payload, wires) {
  let frames = 0;
  while (frames < MAX_CATCHUP_FRAMES && !isCaughtUp(sandbox, wires)) {
    await spawnFrame({ sandbox, payload });
    frames += 1;
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Scenarios. Each returns rows: { row, samples, failures, meta }.

async function scenarioColdCache(samples) {
  const values = [];
  let failures = 0;
  let wire = null;
  for (let s = 0; s < samples; s++) {
    const sandbox = makeSandbox();
    try {
      wire = writeWire(sandbox, 'main', mixedRows(600));
      const frame = await spawnFrame({ sandbox, payload: payloadFor(sandbox) });
      if (frame.valid) values.push(frame.ms);
      else failures += 1;
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
  return [{
    row: 'cold-cache: first-ever frame (no HUD state yet)',
    samples: values,
    failures,
    meta: { wireRows: 600, wireBytes: wire?.size ?? null, agents: 1 },
  }];
}

async function scenarioWarmCache(samples) {
  const values = [];
  let failures = 0;
  let wire = null;
  for (let s = 0; s < samples; s++) {
    const sandbox = makeSandbox();
    try {
      wire = writeWire(sandbox, 'main', mixedRows(600));
      const payload = payloadFor(sandbox);
      for (let f = 0; f < 3; f++) {
        const frame = await spawnFrame({ sandbox, payload });
        if (!frame.valid) { failures += 1; break; }
        if (f === 2) values.push(frame.ms);
      }
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
  return [{
    row: 'warm-cache: steady-state frame (readers caught up)',
    samples: values,
    failures,
    meta: { wireRows: 600, wireBytes: wire?.size ?? null, agents: 1 },
  }];
}

async function scenarioLongWire(samples) {
  const frame1 = [];
  const frame2 = [];
  const frame3 = [];
  const warm = [];
  const catchupFrames = [];
  let failures = 0;
  let wire = null;
  for (let s = 0; s < samples; s++) {
    const sandbox = makeSandbox();
    try {
      const content = [
        mixedRows(4_000),
        oversizedCompleteRows([400_000]),
        mixedRows(4_000),
        oversizedCompleteRows([400_000]),
        mixedRows(4_000),
        oversizedCompleteRows([400_000]),
      ].join('');
      wire = writeWire(sandbox, 'main', content);
      const payload = payloadFor(sandbox);
      const wires = [wire];
      let aborted = false;
      for (const sink of [frame1, frame2, frame3]) {
        const frame = await spawnFrame({ sandbox, payload });
        if (!frame.valid) { failures += 1; aborted = true; break; }
        sink.push(frame.ms);
      }
      if (aborted) continue;
      catchupFrames.push(await runUntilCaughtUp(sandbox, payload, wires));
      await spawnFrame({ sandbox, payload }); // settle after catch-up
      const warmFrame = await spawnFrame({ sandbox, payload });
      if (warmFrame.valid) warm.push(warmFrame.ms);
      else failures += 1;
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
  const wireRows = 12_000 + 3;
  return [
    {
      row: 'long-wire: cold frame 1 (full 1MB read budget)',
      samples: frame1,
      failures,
      meta: { wireRows, wireBytes: wire?.size ?? null, agents: 1 },
    },
    {
      row: 'long-wire: catch-up frame 2 (budget split across frames)',
      samples: frame2,
      failures,
      meta: { wireRows, wireBytes: wire?.size ?? null, agents: 1 },
    },
    {
      row: 'long-wire: catch-up frame 3 (budget split across frames)',
      samples: frame3,
      failures,
      meta: { wireRows, wireBytes: wire?.size ?? null, agents: 1 },
    },
    {
      row: 'long-wire: warm frame (readers caught up)',
      samples: warm,
      failures,
      meta: {
        wireRows,
        wireBytes: wire?.size ?? null,
        agents: 1,
        framesToCaughtUpMedian: median(catchupFrames),
      },
    },
  ];
}

async function scenarioMultiAgent(samples) {
  const frame1 = [];
  const frame2 = [];
  const warm = [];
  const catchupFrames = [];
  let failures = 0;
  let mainWire = null;
  let agentCount = 0;
  for (let s = 0; s < samples; s++) {
    const sandbox = makeSandbox();
    try {
      const wires = [writeWire(sandbox, 'main', mixedRows(600))];
      for (let a = 0; a < 8; a++) {
        wires.push(writeWire(sandbox, `sub-${a}`, subagentRows(1_500)));
      }
      agentCount = wires.length;
      mainWire = wires[0];
      const payload = payloadFor(sandbox);
      let aborted = false;
      for (const sink of [frame1, frame2]) {
        const frame = await spawnFrame({ sandbox, payload });
        if (!frame.valid) { failures += 1; aborted = true; break; }
        sink.push(frame.ms);
      }
      if (aborted) continue;
      catchupFrames.push(await runUntilCaughtUp(sandbox, payload, wires));
      await spawnFrame({ sandbox, payload });
      const warmFrame = await spawnFrame({ sandbox, payload });
      if (warmFrame.valid) warm.push(warmFrame.ms);
      else failures += 1;
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
  return [
    {
      row: 'multi-agent: cold frame 1 (main + 8 subagent backlogs)',
      samples: frame1,
      failures,
      meta: { wireRows: 600, wireBytes: mainWire?.size ?? null, agents: agentCount },
    },
    {
      row: 'multi-agent: frame 2 (round-robin slice continues)',
      samples: frame2,
      failures,
      meta: { wireRows: 600, wireBytes: mainWire?.size ?? null, agents: agentCount },
    },
    {
      row: 'multi-agent: warm frame (readers caught up)',
      samples: warm,
      failures,
      meta: {
        wireRows: 600,
        wireBytes: mainWire?.size ?? null,
        agents: agentCount,
        framesToCaughtUpMedian: median(catchupFrames),
      },
    },
  ];
}

async function scenarioOversizedLine(samples) {
  const frame1 = [];
  const frame2 = [];
  const frame3 = [];
  const warm = [];
  const catchupFrames = [];
  let failures = 0;
  let wire = null;
  for (let s = 0; s < samples; s++) {
    const sandbox = makeSandbox();
    try {
      const content = mixedRows(300) + oversizedIncompleteLine(1.6 * 1024 * 1024);
      wire = writeWire(sandbox, 'main', content);
      const payload = payloadFor(sandbox);
      const wires = [wire];
      let aborted = false;
      for (const sink of [frame1, frame2, frame3]) {
        const frame = await spawnFrame({ sandbox, payload });
        if (!frame.valid) { failures += 1; aborted = true; break; }
        sink.push(frame.ms);
      }
      if (aborted) continue;
      catchupFrames.push(await runUntilCaughtUp(sandbox, payload, wires));
      await spawnFrame({ sandbox, payload });
      const warmFrame = await spawnFrame({ sandbox, payload });
      if (warmFrame.valid) warm.push(warmFrame.ms);
      else failures += 1;
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
  return [
    {
      row: 'oversized-line: cold frame 1 (scan + discard begins)',
      samples: frame1,
      failures,
      meta: {
        wireRows: 300,
        wireBytes: wire?.size ?? null,
        agents: 1,
        method: 'trailing ~1.6MB record without newline; discard progress persisted, content never kept',
      },
    },
    {
      row: 'oversized-line: frame 2 (discard continues)',
      samples: frame2,
      failures,
      meta: { wireRows: 300, wireBytes: wire?.size ?? null, agents: 1 },
    },
    {
      row: 'oversized-line: frame 3 (discard completes)',
      samples: frame3,
      failures,
      meta: { wireRows: 300, wireBytes: wire?.size ?? null, agents: 1 },
    },
    {
      row: 'oversized-line: warm frame (cursor parked at EOF)',
      samples: warm,
      failures,
      meta: {
        wireRows: 300,
        wireBytes: wire?.size ?? null,
        agents: 1,
        framesToCaughtUpMedian: median(catchupFrames),
      },
    },
  ];
}

async function scenarioSlowIo(samples) {
  const rows = [
    { dribbleMs: 120, values: [], failures: 0 },
    { dribbleMs: 260, values: [], failures: 0 },
  ];
  let wire = null;
  let fifoAvailable = true;
  for (const variant of rows) {
    for (let s = 0; s < samples && fifoAvailable; s++) {
      const sandbox = makeSandbox();
      try {
        wire = writeWire(sandbox, 'main', mixedRows(200));
        const payload = payloadFor(sandbox);
        // Warm the readers with a real config file first, then measure the
        // frame whose config read is served through the slow FIFO.
        let warmed = true;
        for (let f = 0; f < 2; f++) {
          const warmup = await spawnFrame({ sandbox, payload });
          if (!warmup.valid) { variant.failures += 1; warmed = false; break; }
        }
        if (!warmed) continue;
        let fifo = null;
        try {
          fifo = { path: makeFifo(sandbox), dribbleMs: variant.dribbleMs };
        } catch {
          fifoAvailable = false;
        }
        if (!fifo) break;
        const frame = await spawnFrame({ sandbox, payload, fifo });
        if (frame.valid) variant.values.push(frame.ms);
        else variant.failures += 1;
      } finally {
        fs.rmSync(sandbox.root, { recursive: true, force: true });
      }
    }
  }
  return rows.map((variant) => ({
    row: `slow-io-config-${variant.dribbleMs}ms: config read blocked via FIFO`,
    samples: variant.values,
    failures: variant.failures,
    meta: {
      wireRows: 200,
      wireBytes: wire?.size ?? null,
      agents: 1,
      dribbleMs: variant.dribbleMs,
      method: 'KIMI_HUD_TUI_TOML points at a FIFO written ~1KB/4ms; the synchronous config read blocks for the dribble span (mkfifo required)',
      ...(variant.values.length === 0 && !fifoAvailable
        ? { skipped: 'mkfifo unavailable on this platform' }
        : {}),
    },
  }));
}

// ---------------------------------------------------------------------------
// Stats + output.

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(row) {
  const sorted = [...row.samples].sort((a, b) => a - b);
  const round = (value) => (value === null ? null : Math.round(value * 100) / 100);
  const mean = sorted.length
    ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
    : null;
  return {
    unit: 'ms',
    n: sorted.length,
    failures: row.failures,
    min: round(sorted[0] ?? null),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? null),
    mean: round(mean),
    over220: row.samples.filter((ms) => ms > RUNTIME_BUDGET_MS).length,
    over300: row.samples.filter((ms) => ms > HOST_CEILING_MS).length,
    meta: row.meta ?? {},
  };
}

function environmentMeta() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    osType: os.type(),
    osRelease: os.release(),
    arch: process.arch,
    nodeVersion: process.version,
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? null,
    totalMemGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
  };
}

function printTable(result) {
  const lines = [];
  lines.push(
    `kimi-code-hud render benchmark — ${result.meta.env.osType} ${result.meta.env.osRelease}`
    + ` (${result.meta.env.arch}), Node ${result.meta.env.nodeVersion},`
    + ` ${result.meta.env.cpuCount}x ${result.meta.env.cpuModel}`,
  );
  lines.push(
    `thresholds: ${result.meta.thresholds.internalBudgetMs}ms internal budget /`
    + ` ${result.meta.thresholds.hostCeilingMs}ms host ceiling ·`
    + ` ${result.meta.samplesPerRow} samples per row · spawn-to-exit wall time`,
  );
  lines.push('');
  const header = [
    'scenario row', 'n', 'fail', 'min', 'p50', 'p95', 'p99', 'max', '>220', '>300',
  ];
  const table = [header];
  for (const scenario of result.scenarios) {
    for (const row of scenario.rows) {
      table.push([
        row.row,
        String(row.n),
        String(row.failures),
        row.min === null ? '-' : String(row.min),
        row.p50 === null ? '-' : String(row.p50),
        row.p95 === null ? '-' : String(row.p95),
        row.p99 === null ? '-' : String(row.p99),
        row.max === null ? '-' : String(row.max),
        String(row.over220),
        String(row.over300),
      ]);
    }
  }
  const widths = header.map((_, i) => Math.max(...table.map((cells) => cells[i].length)));
  for (const [index, cells] of table.entries()) {
    lines.push(cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join('  '));
    if (index === 0) lines.push('-'.repeat(widths.reduce((sum, w) => sum + w + 2, 0)));
  }
  for (const scenario of result.scenarios) {
    for (const row of scenario.rows) {
      const notes = Object.entries(row.meta)
        .filter(([key, value]) => key !== 'wireBytes' && value !== undefined)
        .map(([key, value]) => `${key}=${value}`);
      const bytes = row.meta.wireBytes === null || row.meta.wireBytes === undefined
        ? null
        : `${Math.round(row.meta.wireBytes / 1024)}KB`;
      if (bytes || notes.length) {
        lines.push(`  ${row.row} — wire ${bytes ?? '-'}${notes.length ? ` · ${notes.join(' · ')}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { samples: 30, json: false, scenarios: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--samples') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--samples needs a positive integer');
      opts.samples = value;
    } else if (arg === '--scenario') {
      const names = String(argv[++i]).split(',').map((name) => name.trim()).filter(Boolean);
      if (!names.length) throw new Error('--scenario needs a name');
      opts.scenarios = [...(opts.scenarios ?? []), ...names];
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

const SCENARIOS = {
  'cold-cache': { description: 'first-ever frame', run: scenarioColdCache },
  'warm-cache': { description: 'steady-state frame', run: scenarioWarmCache },
  'long-wire': { description: '~12k-row wire, budget-split catch-up', run: scenarioLongWire },
  'multi-agent': { description: 'main + 8 subagents', run: scenarioMultiAgent },
  'oversized-line': { description: 'large unfinished trailing record', run: scenarioOversizedLine },
  'slow-io-config': { description: 'config read blocked via FIFO', run: scenarioSlowIo },
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  const names = opts.scenarios ?? Object.keys(SCENARIOS);
  for (const name of names) {
    if (!SCENARIOS[name]) throw new Error(`unknown scenario: ${name} (known: ${Object.keys(SCENARIOS).join(', ')})`);
  }

  // Warm the node binary and OS page cache so the first samples do not
  // measure a one-time filesystem cold start.
  const warmSandbox = makeSandbox();
  try {
    writeWire(warmSandbox, 'main', mixedRows(5));
    for (let i = 0; i < 3; i++) {
      await spawnFrame({ sandbox: warmSandbox, payload: payloadFor(warmSandbox) });
    }
  } finally {
    fs.rmSync(warmSandbox.root, { recursive: true, force: true });
  }

  const scenarios = [];
  for (const name of names) {
    const rows = await SCENARIOS[name].run(opts.samples);
    scenarios.push({
      name,
      description: SCENARIOS[name].description,
      rows: rows.map((row) => ({ row: row.row, ...summarize(row) })),
    });
  }

  const result = {
    schema: 'hud-bench-render/v1',
    meta: {
      measuredAt: new Date().toISOString(),
      bin: 'bin/kimi-hud.mjs',
      samplesPerRow: opts.samples,
      timing: 'spawn-to-exit wall time of one real node bin/kimi-hud.mjs process',
      thresholds: { internalBudgetMs: RUNTIME_BUDGET_MS, hostCeilingMs: HOST_CEILING_MS },
      env: environmentMeta(),
    },
    scenarios,
  };
  process.stderr.write(printTable(result) + '\n');
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  const totalFailures = scenarios.reduce(
    (sum, scenario) => sum + scenario.rows.reduce((inner, row) => inner + row.failures, 0),
    0,
  );
  return totalFailures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`bench-render: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
