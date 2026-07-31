import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHud, bar, formatCountdown } from '../src/render.mjs';

const NOW = Date.parse('2026-07-30T10:00:00Z');
const CACHE_METRIC = { hitRate: 88064 / 95744, readTokens: 88064, inputTokens: 95744 };

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

test('compact layout: model, git, speed, window pct + countdown', () => {
  const [line] = renderHud(baseCtx({ layout: 'compact' }));
  const parts = line.split(' │ ');
  assert.equal(parts[0], '[manual] K3');
  assert.equal(parts[1], 'git:(main*)');
  assert.equal(parts[2], '⚡ 47');
  assert.equal(parts[3], '5h 31% ~2h18m');
  assert.equal(parts.length, 4); // no Context, no project, no bar, no wk, no version
});

test('normal layout drops Context, adds project, t/s+TTFT, countdown and weekly', () => {
  const [line] = renderHud(baseCtx({ layout: 'normal' }));
  assert.equal(
    line,
    '[manual] K3 │ kimi-code-hud git:(main*) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ~2h18m │ wk ██░░░░░░░░ 25%',
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
    payload: basePayload({ gitBranch: null }),
    quota: null,
    metrics: { tps: null, ttftMs: null },
    gitDirty: false,
  }));
  assert.equal(line, '[manual] K3 │ kimi-code-hud');
});

test('TTFT remains visible while TPS is warming up', () => {
  const [normal] = renderHud(baseCtx({
    layout: 'normal',
    metrics: { tps: null, ttftMs: 1300 },
  }));
  assert.ok(normal.includes('TTFT 1.3s'));
  assert.ok(!normal.includes('t/s'));

  const [compact] = renderHud(baseCtx({
    layout: 'compact',
    metrics: { tps: null, ttftMs: 1300 },
  }));
  assert.ok(compact.includes('TTFT 1.3s'));
  assert.ok(!compact.includes('⚡'));
});

test('cache hit rate appears after speed and before quota in every layout', () => {
  for (const layout of ['compact', 'normal', 'full']) {
    const [line] = renderHud(baseCtx({
      layout,
      metrics: { tps: 47, ttftMs: 1300, cache: CACHE_METRIC },
    }));
    assert.ok(line.includes('Cache 92%'), `${layout}: ${line}`);
    assert.ok(line.indexOf('⚡') < line.indexOf('Cache 92%'), `${layout}: ${line}`);
    assert.ok(line.indexOf('Cache 92%') < line.indexOf('5h'), `${layout}: ${line}`);
    if (layout === 'full') {
      assert.ok(line.includes('Cache 92% (86K/94K)'));
    } else {
      assert.ok(!line.includes('(86K/94K)'));
    }
  }
});

test('cache zero rate is shown while unavailable or invalid rates are omitted', () => {
  const [zero] = renderHud(baseCtx({
    metrics: {
      tps: 47,
      ttftMs: 1300,
      cache: { hitRate: 0, readTokens: 0, inputTokens: 100 },
    },
  }));
  assert.ok(zero.includes('Cache 0%'));

  for (const cache of [null, { hitRate: Number.NaN }, { hitRate: -0.1 }, { hitRate: 1.1 }]) {
    const [line] = renderHud(baseCtx({ metrics: { tps: 47, ttftMs: 1300, cache } }));
    assert.ok(!line.includes('Cache'));
  }
});

test('cache segment has no semantic threshold color', () => {
  const [line] = renderHud(baseCtx({
    layout: 'normal',
    color: true,
    metrics: { tps: null, ttftMs: null, cache: CACHE_METRIC },
  }));
  assert.ok(line.includes(' │ Cache 92% │ '));
  assert.ok(!line.includes('\x1b[32mCache'));
  assert.ok(!line.includes('\x1b[33mCache'));
  assert.ok(!line.includes('\x1b[31mCache'));
});

test('stale TPS stays visible in muted gray', () => {
  const metrics = { tps: 47, tpsStale: true, ttftMs: 1300 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', color: true, metrics }));
  assert.ok(normal.includes('\x1b[90m⚡ 47 t/s · TTFT 1.3s\x1b[0m'));

  const [compact] = renderHud(baseCtx({ layout: 'compact', color: true, metrics }));
  assert.ok(compact.includes('\x1b[90m⚡ 47\x1b[0m'));

  // Same text without color when colors are disabled.
  const [plain] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(plain.includes('⚡ 47 t/s · TTFT 1.3s'));
  assert.ok(!plain.includes('\x1b['));

  // A fresh window is not muted.
  const [fresh] = renderHud(baseCtx({ layout: 'normal', color: true, metrics: { tps: 47, tpsStale: false, ttftMs: 1300 } }));
  assert.ok(fresh.includes('⚡ 47 t/s'));
  assert.ok(!fresh.includes('\x1b[90m⚡'));
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
    metrics: { tps: 47, ttftMs: 1300, cache: CACHE_METRIC },
  }));
  assert.ok(line.length <= 220); // compact tier guaranteed <= MAX_WIDTH
  assert.ok(!line.includes('v0.31.0')); // downgraded away from full
  assert.ok(line.includes('Cache 92%')); // compact retains the percentage
  assert.ok(!line.includes('(86K/94K)')); // full-only counts were dropped
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

test('swarm badge renders from wire-derived metrics.swarmMode (payload has no field)', () => {
  const [line] = renderHud(baseCtx({
    color: true,
    metrics: { tps: 47, ttftMs: 1300, swarmMode: true },
  }));
  assert.ok(line.includes('\x1b[38;2;91;192;190m[swarm]\x1b[0m'));
  const [plain] = renderHud(baseCtx({ metrics: { tps: 47, ttftMs: 1300, swarmMode: true } }));
  assert.ok(plain.startsWith('[manual] [swarm] '));
  const [off] = renderHud(baseCtx({ metrics: { tps: 47, ttftMs: 1300, swarmMode: false } }));
  assert.ok(!off.includes('[swarm]'));
});

test('goal badge sits between mode badges and model, in every tier', () => {
  const goal = { status: 'active', turnsUsed: 7, wallClockMs: 0, wallClockResumedAt: NOW - 4 * 60_000 };
  for (const layout of ['compact', 'normal', 'full']) {
    const [line] = renderHud(baseCtx({
      layout,
      metrics: { tps: 47, ttftMs: 1300, goal },
    }));
    assert.ok(
      line.startsWith('[manual] [goal ● active · 4m · 7 turns] K3'),
      `${layout}: ${line}`,
    );
  }
  // No goal -> no badge.
  const [plain] = renderHud(baseCtx({ layout: 'normal' }));
  assert.ok(plain.startsWith('[manual] K3'));
});

test('goal badge colors: dot by status, brackets muted', () => {
  const goal = { status: 'active', turnsUsed: 1, wallClockMs: 0, wallClockResumedAt: NOW };
  const [line] = renderHud(baseCtx({ color: true, metrics: { goal } }));
  assert.ok(line.includes('\x1b[38;2;79;168;255m●')); // active: primary blue
  const [blocked] = renderHud(baseCtx({
    color: true,
    metrics: { goal: { ...goal, status: 'blocked', wallClockResumedAt: null } },
  }));
  assert.ok(blocked.includes('\x1b[38;2;232;168;56m●')); // blocked: warning amber
  const [paused] = renderHud(baseCtx({
    color: true,
    metrics: { goal: { ...goal, status: 'paused', wallClockResumedAt: null } },
  }));
  assert.ok(paused.includes('\x1b[90m●')); // paused: muted
});

test('fleet speed shows total, head count and per-agent average', () => {
  const metrics = { tps: 25, tpsTotal: 305, activeAgents: 12, ttftMs: 1300 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 305 t/s (12 agents @25) · TTFT 1.3s'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 305 (12@25)'));
  // A fleet is never painted as stale.
  const [colored] = renderHud(baseCtx({ layout: 'normal', color: true, metrics }));
  assert.ok(!colored.includes('\x1b[90m⚡'));
});

test('live gen ticker replaces TTFT while a request is in flight', () => {
  const metrics = { tps: 47, ttftMs: 1300, generatingSince: NOW - 3000 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 47 t/s · gen 3s'));
  assert.ok(!normal.includes('TTFT'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 47 gen 3s'));
  // Long generations format as minutes.
  const [long] = renderHud(baseCtx({
    layout: 'normal',
    metrics: { ...metrics, generatingSince: NOW - 4 * 60_000 },
  }));
  assert.ok(long.includes('gen 4m'));
});

test('gen ticker carries the head count for fleets without speed samples', () => {
  const [line] = renderHud(baseCtx({
    layout: 'normal',
    metrics: { tps: null, ttftMs: null, generatingSince: NOW - 3000, activeAgents: 106 },
  }));
  assert.ok(line.includes('⚡ gen 3s (106 agents)'));
  const [solo] = renderHud(baseCtx({
    layout: 'normal',
    metrics: { tps: null, ttftMs: null, generatingSince: NOW - 3000, activeAgents: 1 },
  }));
  assert.ok(solo.includes('⚡ gen 3s'));
  assert.ok(!solo.includes('agents'));
});

test('fleet gen ticker appends to the fleet speed format', () => {
  const metrics = {
    tps: 25, tpsTotal: 305, activeAgents: 12, ttftMs: 1300, generatingSince: NOW - 3000,
  };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 305 t/s (12 agents @25) · gen 3s'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 305 (12@25) gen 3s'));
});
