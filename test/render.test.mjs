import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHud, bar, formatCountdown } from '../src/render.mjs';

const NOW = Date.parse('2026-07-30T10:00:00Z');

function basePayload(overrides = {}) {
  return {
    model: 'K3',
    cwd: '/Users/test/kimi-code-hud',
    gitBranch: 'main',
    permissionMode: 'manual',
    planMode: false,
    contextUsage: 0.62,
    contextTokens: 162529,
    maxContextTokens: 262144,
    sessionId: 'x',
    version: '0.31.0',
    ...overrides,
  };
}

function baseCtx(overrides = {}) {
  return {
    payload: basePayload(),
    quota: {
      weekly: { used: 25, limit: 100, resetAt: '2026-08-02T12:00:00Z' },
      windows: [{ label: '5h', used: 31, limit: 100, resetAt: '2026-07-30T12:18:00Z' }],
    },
    metrics: { tps: 47, ttftMs: 1300 },
    gitDirty: true,
    color: false,
    now: NOW,
    ...overrides,
  };
}

test('bar renders 10 cells graded by usage', () => {
  assert.equal(bar(0, false), '░░░░░░░░░░');
  assert.equal(bar(0.31, false), '███░░░░░░░');
  assert.equal(bar(0.62, false), '██████░░░░');
  assert.equal(bar(1, false), '██████████');
  assert.equal(bar(2, false), '██████████'); // clamped
  assert.ok(bar(0.9, true).includes('\x1b[31m'));  // >=85% red
  assert.ok(bar(0.7, true).includes('\x1b[33m'));  // >=60% yellow
  assert.ok(bar(0.1, true).includes('\x1b[32m'));  // <60% green
});

test('formatCountdown formats d/h/m and reset states', () => {
  assert.equal(formatCountdown('2026-07-30T12:18:00Z', NOW), '~2h18m');
  assert.equal(formatCountdown('2026-08-02T12:00:00Z', NOW), '~3d2h');
  assert.equal(formatCountdown('2026-07-30T10:45:00Z', NOW), '~45m');
  assert.equal(formatCountdown('2026-07-30T09:00:00Z', NOW), '~reset');
  assert.equal(formatCountdown(null, NOW), null);
  assert.equal(formatCountdown('garbage', NOW), null);
});

test('compact layout: model, git, ctx pct, speed, window pct + countdown', () => {
  const [line] = renderHud(baseCtx({ layout: 'compact' }));
  const parts = line.split(' │ ');
  assert.equal(parts[0], '[manual] K3');
  assert.equal(parts[1], 'git:(main*)');
  assert.equal(parts[2], 'ctx 62%');
  assert.equal(parts[3], '⚡ 47');
  assert.equal(parts[4], '5h 31% ~2h18m');
  assert.equal(parts.length, 5); // no Context bar, no project, no wk, no version
});

test('normal layout: compact ctx pct, project, t/s+TTFT, countdown and weekly', () => {
  const [line] = renderHud(baseCtx({ layout: 'normal' }));
  assert.equal(
    line,
    '[manual] K3 │ kimi-code-hud git:(main*) │ ctx 62% │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ~2h18m │ wk ██░░░░░░░░ 25%',
  );
});

test('full layout adds Context, weekly countdown, version', () => {
  const [line] = renderHud(baseCtx({ layout: 'full', payload: basePayload({ planMode: true }) }));
  assert.equal(
    line,
    '[manual] [plan] K3 │ kimi-code-hud git:(main*) │ Context ██████░░░░ 62% (159K/256K) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ~2h18m │ wk ██░░░░░░░░ 25% ~3d2h │ v0.31.0',
  );
});

test('model thinking suffix from session thinkingLevel (normal and full)', () => {
  const withLevel = (thinkingLevel, layout) =>
    renderHud(baseCtx({ layout, metrics: { tps: 47, ttftMs: 1300, thinkingLevel } }))[0];
  assert.ok(withLevel('on', 'normal').startsWith('[manual] K3 thinking │'));
  assert.ok(withLevel('high', 'normal').startsWith('[manual] K3 thinking:high │'));
  assert.ok(withLevel('max', 'full').startsWith('[manual] K3 thinking:max │'));
  assert.ok(withLevel('off', 'normal').startsWith('[manual] K3 │'));
  assert.ok(withLevel(null, 'normal').startsWith('[manual] K3 │'));
  // compact keeps only " <effort>" without the "thinking" label
  assert.ok(withLevel('high', 'compact').startsWith('[manual] K3 high │'));
  assert.ok(withLevel('on', 'compact').startsWith('[manual] K3 on │'));
  assert.ok(withLevel('off', 'compact').startsWith('[manual] K3 │'));
});

test('badges for yolo/auto permission modes', () => {
  const [yolo] = renderHud(baseCtx({ payload: basePayload({ permissionMode: 'yolo' }) }));
  assert.ok(yolo.startsWith('[yolo] '));
  const [auto] = renderHud(baseCtx({ payload: basePayload({ permissionMode: 'auto' }) }));
  assert.ok(auto.startsWith('[auto] '));
  const [manual] = renderHud(baseCtx());
  assert.ok(manual.startsWith('[manual] '));
});

test('optional segments drop cleanly', () => {
  const [line] = renderHud(baseCtx({
    payload: basePayload({ gitBranch: null, contextTokens: undefined, maxContextTokens: undefined, contextUsage: undefined }),
    quota: null,
    metrics: { tps: null, ttftMs: null },
    gitDirty: false,
  }));
  assert.equal(line, '[manual] K3 │ kimi-code-hud');
});

test('Context fraction prefers exact token counts', () => {
  const [line] = renderHud(baseCtx({
    layout: 'full',
    payload: basePayload({ contextTokens: 10485, maxContextTokens: 262144, contextUsage: 0.9 }),
  }));
  assert.ok(line.includes('Context ░░░░░░░░░░ 4% (10K/256K)'));
});

test('falls back to contextUsage when token counts are missing', () => {
  const [line] = renderHud(baseCtx({
    layout: 'full',
    payload: basePayload({ contextTokens: undefined, maxContextTokens: undefined, contextUsage: 0.5 }),
  }));
  assert.ok(line.includes('Context █████░░░░░ 50%'));
});

test('width defense downgrades full -> compact', () => {
  const longName = 'x'.repeat(180);
  const [line] = renderHud(baseCtx({
    layout: 'full',
    payload: basePayload({ cwd: `/tmp/${longName}` }),
  }));
  assert.ok(line.length <= 220); // compact tier guaranteed <= MAX_WIDTH
  assert.ok(!line.includes('v0.31.0')); // downgraded away from full
});

test('color badges: yolo warning amber, auto bright red, plan primary blue', () => {
  const [line] = renderHud(baseCtx({
    color: true,
    payload: basePayload({ permissionMode: 'yolo', planMode: true }),
  }));
  assert.ok(line.includes('\x1b[38;2;232;168;56m[yolo]\x1b[0m'));
  assert.ok(line.includes('\x1b[38;2;79;168;255m[plan]\x1b[0m'));
  const [auto] = renderHud(baseCtx({
    color: true,
    payload: basePayload({ permissionMode: 'auto' }),
  }));
  assert.ok(auto.includes('\x1b[91m[auto]\x1b[0m'));
  const [man] = renderHud(baseCtx({ color: true }));
  assert.ok(man.includes('\x1b[90m[manual]\x1b[0m'));
});

test('swarm badge renders in accent cyan when payload exposes swarmMode', () => {
  const [line] = renderHud(baseCtx({
    color: true,
    payload: basePayload({ swarmMode: true }),
  }));
  assert.ok(line.includes('\x1b[38;2;91;192;190m[swarm]\x1b[0m'));
  const [plain] = renderHud(baseCtx({ payload: basePayload({ swarmMode: true }) }));
  assert.ok(plain.startsWith('[manual] [swarm] '));
});

test('goal badge mirrors the host footer: status, wall clock, turns', () => {
  const goal = { status: 'active', wallClockMs: 4 * 60_000, turnsUsed: 7, at: NOW - 60_000 };
  const [line] = renderHud(baseCtx({ metrics: { tps: 47, ttftMs: 1300, goal } }));
  // active: last event's 4m plus one elapsed minute since the event
  assert.ok(line.startsWith('[manual] [goal ● active · 5m · 7 turns] '));
});

test('goal badge freezes the wall clock while paused and hides when done', () => {
  const paused = { status: 'paused', wallClockMs: 4 * 60_000, turnsUsed: 1, at: NOW - 60_000 };
  const [line] = renderHud(baseCtx({ metrics: { tps: 47, ttftMs: 1300, goal: paused } }));
  assert.ok(line.startsWith('[manual] [goal ● paused · 4m · 1 turn] '));

  for (const status of ['complete', 'stopped', null]) {
    const [done] = renderHud(baseCtx({ metrics: { tps: 47, ttftMs: 1300, goal: { status, at: NOW } } }));
    assert.ok(done.startsWith('[manual] K3'));
    assert.ok(!done.includes('[goal'));
  }
});

test('goal badge colors the status dot: green active, yellow paused, red blocked', () => {
  const mk = (status) => renderHud(baseCtx({
    color: true,
    metrics: { tps: 47, ttftMs: 1300, goal: { status, wallClockMs: 0, at: NOW } },
  }))[0];
  assert.ok(mk('active').includes('\x1b[32m●\x1b[0m'));
  assert.ok(mk('paused').includes('\x1b[93m●\x1b[0m'));
  assert.ok(mk('blocked').includes('\x1b[91m●\x1b[0m'));
  assert.ok(mk('active').includes('\x1b[90m[goal \x1b[0m'));
});

test('speed segment ticks live while generating, static TTFT when idle', () => {
  const idle = { tps: 47, ttftMs: 1300, generatingSince: null };
  assert.ok(renderHud(baseCtx({ metrics: idle }))[0].includes('⚡ 47 t/s · TTFT 1.3s'));

  const gen = { tps: 47, ttftMs: 1300, generatingSince: NOW - 23_000 };
  const [line] = renderHud(baseCtx({ metrics: gen }));
  assert.ok(line.includes('⚡ 47 t/s · gen 23s'));
  assert.ok(!line.includes('TTFT'));

  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics: gen }));
  assert.ok(compact.includes('⚡ 47 gen 23s'));

  // No samples yet but a request is in flight: ticker still shows.
  const [fresh] = renderHud(baseCtx({ metrics: { tps: null, ttftMs: null, generatingSince: NOW - 3000 } }));
  assert.ok(fresh.includes('⚡ gen 3s'));
});

test('swarm speed shows fleet total with per-agent average', () => {
  const swarm = { tps: 25, tpsTotal: 305, activeAgents: 12, ttftMs: 1300 };
  const [line] = renderHud(baseCtx({ metrics: swarm }));
  assert.ok(line.includes('⚡ 305 t/s (12 agents @25) · TTFT 1.3s'));

  const [gen] = renderHud(baseCtx({ metrics: { ...swarm, generatingSince: NOW - 3000 } }));
  assert.ok(gen.includes('⚡ 305 t/s (12 agents @25) · gen 3s'));

  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics: swarm }));
  assert.ok(compact.includes('⚡ 305 (12@25)'));

  // single active agent: no fleet decoration
  const solo = { tps: 47, tpsTotal: null, activeAgents: 1, ttftMs: 1300 };
  assert.ok(renderHud(baseCtx({ metrics: solo }))[0].includes('⚡ 47 t/s · TTFT 1.3s'));

  // no samples yet but a swarm is in flight: ticker carries the head count
  const [fresh] = renderHud(baseCtx({ metrics: { tps: null, tpsTotal: null, activeAgents: 5, generatingSince: NOW - 3000 } }));
  assert.ok(fresh.includes('⚡ gen 3s (5 agents)'));
});

test('ctx pct segment is usage-graded and omitted without any context data', () => {
  const [hot] = renderHud(baseCtx({
    color: true,
    layout: 'normal',
    payload: basePayload({ contextTokens: 230000, maxContextTokens: 262144 }),
  }));
  assert.ok(hot.includes('\x1b[31mctx 88%\x1b[0m')); // >=85% red
  const [none] = renderHud(baseCtx({
    payload: basePayload({ contextTokens: undefined, maxContextTokens: undefined, contextUsage: undefined }),
  }));
  assert.ok(!none.includes('ctx'));
});
