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
    sessionId: 'x',
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
  assert.equal(parts.length, 4); // no project, no bar, no weekly
});

test('normal layout adds project, t/s+TTFT, countdown and weekly', () => {
  const [line] = renderHud(baseCtx({ layout: 'normal' }));
  assert.equal(
    line,
    '[manual] K3 │ kimi-code-hud git:(main*) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ~2h18m · 7d ██░░░░░░░░ 25% ~3d2h',
  );
});

test('normal layout shows zero quota usage with its reset countdown', () => {
  const [line] = renderHud(baseCtx({
    layout: 'normal',
    quota: {
      weekly: { used: 0, limit: 100, resetAt: '2026-08-02T12:00:00Z' },
      windows: [{ label: '5h', used: 0, limit: 100, resetAt: '2026-07-30T12:18:00Z' }],
    },
  }));
  assert.ok(line.includes('5h ░░░░░░░░░░ 0% ~2h18m'));
  assert.ok(line.includes('7d ░░░░░░░░░░ 0% ~3d2h'));
});

test('provider balance uses currency-aware compact text instead of a quota bar', () => {
  const [cny] = renderHud(baseCtx({
    quota: null,
    providerUsage: {
      kind: 'balance', label: 'DeepSeek', available: true,
      balances: [{ currency: 'USD', total: 20 }, { currency: 'CNY', total: 110 }],
    },
  }));
  assert.ok(cny.endsWith(' │ DeepSeek Balance ¥110.00'));

  const [usd] = renderHud(baseCtx({
    quota: null,
    providerUsage: {
      kind: 'balance', label: 'DeepSeek', available: true,
      balances: [{ currency: 'USD', total: 20.5 }],
    },
  }));
  assert.ok(usd.endsWith(' │ DeepSeek Balance $20.50'));
});

test('provider balance reports unavailable and dims stale cache', () => {
  const [unavailable] = renderHud(baseCtx({
    quota: null,
    providerUsage: {
      kind: 'balance', label: 'DeepSeek', available: false,
      balances: [{ currency: 'CNY', total: 0 }],
    },
  }));
  assert.ok(unavailable.endsWith(' │ DeepSeek Balance unavailable'));

  const [stale] = renderHud(baseCtx({
    color: true,
    quota: null,
    providerUsage: {
      kind: 'balance', label: 'DeepSeek', available: true, stale: true,
      balances: [{ currency: 'CNY', total: 1 }],
    },
  }));
  assert.match(stale, /\x1b\[90mDeepSeek Balance ¥1\.00\x1b\[0m/);
});

test('provider cost names the session scope and marks the local estimate', () => {
  const openAI = renderHud({
    payload: basePayload(), metrics: null, quota: null, gitDirty: false,
    providerUsage: {
      kind: 'cost', label: 'OpenAI', scope: 'session', currency: 'USD',
      amount: 0.4219, estimated: true,
    },
    layout: 'normal', color: false,
  })[0];
  assert.ok(openAI.endsWith(' │ OpenAI Session Cost ≈$0.422'));

  const anthropic = renderHud({
    payload: basePayload(), metrics: null, quota: null, gitDirty: false,
    providerUsage: {
      kind: 'cost', label: 'Anthropic', scope: 'session', currency: 'USD',
      amount: 0.0042, estimated: true,
    },
    layout: 'normal', color: false,
  })[0];
  assert.ok(anthropic.endsWith(' │ Anthropic Session Cost ≈$0.0042'));
});

test('provider balance and session cost combine under one official brand name', () => {
  const combined = renderHud({
    payload: basePayload(), metrics: null, quota: null, gitDirty: false,
    providerUsage: [
      {
        kind: 'balance', label: 'DeepSeek', available: true,
        balances: [{ currency: 'CNY', total: 110 }],
      },
      {
        kind: 'cost', label: 'DeepSeek', scope: 'session', currency: 'CNY',
        amount: 0.00422, estimated: true,
      },
    ],
    layout: 'normal', color: false,
  })[0];
  assert.ok(combined.endsWith(' │ DeepSeek Balance ¥110.00 · Session Cost ≈¥0.0042'));

  const staleCombined = renderHud({
    payload: basePayload(), metrics: null, quota: null, gitDirty: false,
    providerUsage: [
      {
        kind: 'balance', label: 'DeepSeek', available: true, stale: true,
        balances: [{ currency: 'CNY', total: 110 }],
      },
      {
        kind: 'cost', label: 'DeepSeek', scope: 'session', currency: 'CNY',
        amount: 0.00422, estimated: true,
      },
    ],
    layout: 'normal', color: true,
  })[0];
  assert.match(staleCombined, /\x1b\[90mDeepSeek Balance ¥110\.00\x1b\[0m · Session Cost ≈¥0\.0042/);

  const costOnly = renderHud({
    payload: basePayload(), metrics: null, quota: null, gitDirty: false,
    providerUsage: [
      {
        kind: 'balance', label: 'DeepSeek', available: false,
        balances: [{ currency: 'CNY', total: 0 }],
      },
      {
        kind: 'cost', label: 'DeepSeek', scope: 'session', currency: 'CNY',
        amount: 0.00422, estimated: true,
      },
    ],
    layout: 'normal', color: false,
  })[0];
  assert.ok(costOnly.endsWith(' │ DeepSeek Session Cost ≈¥0.0042'));
  assert.doesNotMatch(costOnly, /Balance unavailable/);
});

test('provider cost refuses ambiguous or provider-reported spend shapes', () => {
  for (const providerUsage of [
    { kind: 'cost', label: 'OpenAI', scope: 'month', currency: 'USD', amount: 1, estimated: true },
    { kind: 'cost', label: 'OpenAI', scope: 'session', currency: 'USD', amount: 1, estimated: false },
  ]) {
    const line = renderHud({
      payload: basePayload(), metrics: null, quota: null, gitDirty: false,
      providerUsage, layout: 'normal', color: false,
    })[0];
    assert.doesNotMatch(line, /Cost|Spent|Balance/);
  }
});

test('model thinking suffix from session thinkingLevel (normal and compact)', () => {
  const withLevel = (thinkingLevel, layout) =>
    renderHud(baseCtx({ layout, metrics: { tps: 47, ttftMs: 1300, thinkingLevel } }))[0];
  assert.ok(withLevel('on', 'normal').startsWith('[manual] K3 thinking │'));
  // effort-capable models show the bare level without the "thinking" label
  assert.ok(withLevel('high', 'normal').startsWith('[manual] K3 high │'));
  assert.ok(withLevel('max', 'normal').startsWith('[manual] K3 max │'));
  assert.ok(withLevel('off', 'normal').startsWith('[manual] K3 │'));
  assert.ok(withLevel(null, 'normal').startsWith('[manual] K3 │'));
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
  for (const layout of ['compact', 'normal']) {
    const [line] = renderHud(baseCtx({
      layout,
      metrics: { tps: 47, ttftMs: 1300, cache: CACHE_METRIC },
    }));
    assert.ok(line.includes('Cache 92%'), `${layout}: ${line}`);
    assert.ok(line.indexOf('⚡') < line.indexOf('Cache 92%'), `${layout}: ${line}`);
    assert.ok(line.indexOf('Cache 92%') < line.indexOf('5h'), `${layout}: ${line}`);
    // token counts are never shown — only the percentage
    assert.ok(!line.includes('(86K/94K)'), `${layout}: ${line}`);
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

test('live gen timer stays bright when the stale speed dims', () => {
  const metrics = { tps: 47, tpsStale: true, ttftMs: 1300, turnStartedAt: NOW - 3000 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', color: true, metrics }));
  assert.ok(normal.includes('\x1b[90m⚡ 47 t/s\x1b[0m · gen 3s'));
  assert.ok(!normal.includes('\x1b[90m⚡ 47 t/s · gen'));

  const [compact] = renderHud(baseCtx({ layout: 'compact', color: true, metrics }));
  assert.ok(compact.includes('\x1b[90m⚡ 47\x1b[0m gen 3s'));
});

test('width defense downgrades normal -> compact', () => {
  const longName = 'x'.repeat(180);
  const [line] = renderHud(baseCtx({
    layout: 'normal',
    payload: basePayload({ cwd: `/tmp/${longName}` }),
    metrics: { tps: 47, ttftMs: 1300, cache: CACHE_METRIC },
  }));
  assert.ok(line.length <= 220); // compact tier guaranteed <= MAX_WIDTH
  assert.ok(!line.includes('kimi-code-hud')); // downgraded away from normal
  assert.ok(line.includes('Cache 92%')); // compact retains the percentage
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

test('light theme swaps badges to bold brighter truecolor', () => {
  // Default (no theme) stays on the dark palette.
  const [def] = renderHud(baseCtx({ color: true, payload: basePayload({ planMode: true }) }));
  assert.ok(def.includes('\x1b[38;2;79;168;255mK3\x1b[0m'));
  assert.ok(def.includes('\x1b[38;2;79;168;255m[plan]\x1b[0m'));

  const [light] = renderHud(baseCtx({
    color: true,
    theme: 'light',
    payload: basePayload({ permissionMode: 'yolo', planMode: true, swarmMode: true }),
  }));
  assert.ok(light.includes('\x1b[1m\x1b[38;2;21;101;192mK3\x1b[0m'));    // bold primary #1565C0
  assert.ok(light.includes('\x1b[1m\x1b[38;2;21;101;192m[plan]\x1b[0m'));
  assert.ok(light.includes('\x1b[1m\x1b[38;2;217;119;6m[yolo]\x1b[0m'));  // bold amber #D97706
  assert.ok(light.includes('\x1b[1m\x1b[38;2;20;184;166m[swarm]\x1b[0m')); // bold teal #14B8A6
  assert.ok(!light.includes('\x1b[38;2;79;168;255m'));                    // no dark leftovers

  // The auto badge keeps its ANSI bright red but goes bold in light.
  const [lightAuto] = renderHud(baseCtx({
    color: true,
    theme: 'light',
    payload: basePayload({ permissionMode: 'auto' }),
  }));
  assert.ok(lightAuto.includes('\x1b[1;91m[auto]\x1b[0m'));

  // Explicit dark matches the default: no bold, ANSI auto.
  const [dark] = renderHud(baseCtx({
    color: true,
    theme: 'dark',
    payload: basePayload({ permissionMode: 'yolo', planMode: true, swarmMode: true }),
  }));
  assert.ok(dark.includes('\x1b[38;2;79;168;255m[plan]\x1b[0m'));
  assert.ok(dark.includes('\x1b[38;2;232;168;56m[yolo]\x1b[0m'));
  assert.ok(dark.includes('\x1b[38;2;91;192;190m[swarm]\x1b[0m'));
});

test('light theme tones the quota bar down to calmer truecolor hues', () => {
  const hotQuota = {
    weekly: { used: 25, limit: 100, resetAt: '2026-08-02T12:00:00Z' },
    windows: [{ label: '5h', used: 90, limit: 100, resetAt: '2026-07-30T12:18:00Z' }],
  };
  // Dark (and default) bars keep the terminal-remapped ANSI levels.
  const [dark] = renderHud(baseCtx({ color: true, theme: 'dark', quota: hotQuota }));
  assert.ok(dark.includes('\x1b[31m█████████░\x1b[0m'));
  // Light swaps the glaring ANSI red for the host's light error hue; the
  // mid-level amber matches the badge amber.
  const [light] = renderHud(baseCtx({ color: true, theme: 'light', quota: hotQuota }));
  assert.ok(light.includes('\x1b[38;2;185;28;28m█████████░\x1b[0m')); // #B91C1C
  assert.ok(!light.includes('\x1b[31m'));
});

test('compact layout colors the quota percentage by level, green stays default', () => {
  const quotaAt = (used) => ({
    weekly: null,
    windows: [{ label: '5h', used, limit: 100, resetAt: '2026-07-30T12:18:00Z' }],
  });
  // Green level (<60%): no color — comfortable usage shouldn't stand out.
  const [green] = renderHud(baseCtx({ layout: 'compact', color: true, quota: quotaAt(31) }));
  assert.ok(green.includes('5h 31% ~2h18m'));
  // Yellow (>=60%) and red (>=85%) paint the bare percentage, taking over
  // the level signal the compact layout's missing bar would carry.
  const [yellow] = renderHud(baseCtx({ layout: 'compact', color: true, quota: quotaAt(70) }));
  assert.ok(yellow.includes('5h \x1b[33m70%\x1b[0m ~2h18m'));
  const [red] = renderHud(baseCtx({ layout: 'compact', color: true, quota: quotaAt(90) }));
  assert.ok(red.includes('5h \x1b[31m90%\x1b[0m ~2h18m'));
  // Light theme uses its calmer truecolor hues; colors off stays plain.
  const [light] = renderHud(baseCtx({
    layout: 'compact', color: true, theme: 'light', quota: quotaAt(90),
  }));
  assert.ok(light.includes('5h \x1b[38;2;185;28;28m90%\x1b[0m ~2h18m'));
  const [plain] = renderHud(baseCtx({ layout: 'compact', quota: quotaAt(90) }));
  assert.ok(plain.includes('5h 90% ~2h18m'));
  assert.ok(!plain.includes('\x1b['));
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
  for (const layout of ['compact', 'normal']) {
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

test('goal badge keeps the speed segment at throughput only', () => {
  const goal = { status: 'active', turnsUsed: 3, wallClockMs: 0, wallClockResumedAt: NOW - 60_000 };
  // Idle turn: TTFT would normally tail the speed.
  const [idle] = renderHud(baseCtx({ metrics: { tps: 47, ttftMs: 1300, goal } }));
  assert.ok(idle.includes('⚡ 47 t/s'));
  assert.ok(!idle.includes('TTFT'));
  // Running turn: the gen ticker is redundant with the badge's own clock.
  const [running] = renderHud(baseCtx({
    metrics: { tps: 47, ttftMs: 1300, goal, turnStartedAt: NOW - 3000 },
  }));
  assert.ok(running.includes('⚡ 47 t/s'));
  assert.ok(!running.includes('gen'));
  assert.ok(!running.includes('TTFT'));
  // Compact tier drops to the bare number too.
  const [compact] = renderHud(baseCtx({
    layout: 'compact',
    metrics: { tps: 47, ttftMs: 1300, goal, turnStartedAt: NOW - 3000 },
  }));
  assert.ok(compact.split(' │ ').includes('⚡ 47'));
  // Compaction state hides too — like auto-compactions inside a turn, the
  // span is already covered by the badge's clock.
  const [compacted] = renderHud(baseCtx({
    metrics: { tps: 47, ttftMs: 1300, goal, compactionMs: 12_000 },
  }));
  assert.ok(!compacted.includes('compacted'));
  const [compacting] = renderHud(baseCtx({
    metrics: { tps: 47, ttftMs: 1300, goal, compactingSince: NOW - 5000 },
  }));
  assert.ok(!compacting.includes('compacting'));
  // Goal cleared: ticker and TTFT come back.
  const [cleared] = renderHud(baseCtx({
    metrics: { tps: 47, ttftMs: 1300, turnStartedAt: NOW - 3000 },
  }));
  assert.ok(cleared.includes('⚡ 47 t/s · gen 3s'));
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
  const metrics = { tps: 25, tpsTotal: 305, tpsAgents: 12, activeAgents: 12, ttftMs: 1300 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 305 t/s (12 agents @25) · TTFT 1.3s'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 305 (12@25)'));
  // A fleet is never painted as stale.
  const [colored] = renderHud(baseCtx({ layout: 'normal', color: true, metrics }));
  assert.ok(!colored.includes('\x1b[90m⚡'));
});

test('fleet head count names the main agent when it feeds the figures', () => {
  // While the main agent also has fresh samples (it just launched the swarm,
  // or is streaming alongside it), a bare "12 agents" would read as
  // "12 subagents" — label it "main+11" instead.
  const metrics = {
    tps: 25, tpsTotal: 305, tpsAgents: 12, activeAgents: 12,
    mainSpeed: true, mainActive: true, ttftMs: 1300,
  };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 305 t/s (main+11 agents @25) · TTFT 1.3s'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 305 (main+11@25)'));
  // The gen ticker head count follows the same labeling.
  const ticking = { tps: null, ttftMs: null, turnStartedAt: NOW - 3000, activeAgents: 106, mainActive: true };
  const [line] = renderHud(baseCtx({ layout: 'normal', metrics: ticking }));
  assert.ok(line.includes('⚡ gen 3s (main+105 agents)'));
});

test('fleet speed head count matches the agents feeding the total', () => {
  // An agent with a request in flight but no speed sample yet stays in
  // activeAgents but not in the parenthetical count.
  const metrics = { tps: 62, tpsTotal: 124, tpsAgents: 2, activeAgents: 3 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 124 t/s (2 agents @62)'));
  // A single reading renders as a solo speed, not a one-agent "fleet".
  const solo = { tps: 68, tpsTotal: 68, tpsAgents: 1, activeAgents: 2 };
  const [line] = renderHud(baseCtx({ layout: 'normal', metrics: solo }));
  assert.ok(line.includes('⚡ 68 t/s'));
  assert.ok(!line.includes('agents'));
});

test('live gen ticker replaces TTFT while the turn runs', () => {
  const metrics = { tps: 47, ttftMs: 1300, turnStartedAt: NOW - 3000 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 47 t/s · gen 3s'));
  assert.ok(!normal.includes('TTFT'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 47 gen 3s'));
  // Past the one-minute mark the seconds keep ticking, so the timer never
  // looks static: exactly 60s renders "1m0s", and minutes carry the remainder.
  const [minute] = renderHud(baseCtx({
    layout: 'normal',
    metrics: { ...metrics, turnStartedAt: NOW - 60_000 },
  }));
  assert.ok(minute.includes('gen 1m0s'));
  const [long] = renderHud(baseCtx({
    layout: 'normal',
    metrics: { ...metrics, turnStartedAt: NOW - (4 * 60_000 + 5_000) },
  }));
  assert.ok(long.includes('gen 4m5s'));
});

test('gen ticker carries the head count for fleets without speed samples', () => {
  const [line] = renderHud(baseCtx({
    layout: 'normal',
    metrics: { tps: null, ttftMs: null, turnStartedAt: NOW - 3000, activeAgents: 106 },
  }));
  assert.ok(line.includes('⚡ gen 3s (106 agents)'));
  const [solo] = renderHud(baseCtx({
    layout: 'normal',
    metrics: { tps: null, ttftMs: null, turnStartedAt: NOW - 3000, activeAgents: 1 },
  }));
  assert.ok(solo.includes('⚡ gen 3s'));
  assert.ok(!solo.includes('agents'));
});

test('fleet gen ticker appends to the fleet speed format', () => {
  const metrics = {
    tps: 25, tpsTotal: 305, tpsAgents: 12, activeAgents: 12, ttftMs: 1300, turnStartedAt: NOW - 3000,
  };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 305 t/s (12 agents @25) · gen 3s'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 305 (12@25) gen 3s'));
});

test('swarm with a single live subagent keeps the fleet style', () => {
  // The swarm has run down to its last member: main is idle and only one
  // subagent feeds the speed. A bare "45 t/s" would read like the swarm
  // never happened — keep the fleet parenthetical with a singular head.
  const metrics = {
    tps: 45, tpsTotal: 45, tpsAgents: 1, activeAgents: 1,
    swarmMode: true, mainActive: false, mainSpeed: false,
  };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 45 t/s (1 agent @45)'));
  assert.ok(!normal.includes('TTFT'));
  assert.ok(!normal.includes(' gen '));
});

test('swarm over: only main active falls back to the single-agent style', () => {
  // swarm_mode is still latched true, but the last subagent ended: the sole
  // live agent is main itself, so the fleet parenthetical goes away.
  const metrics = {
    tps: 45, tpsTotal: 45, tpsAgents: 1, activeAgents: 1,
    swarmMode: true, mainActive: true, mainSpeed: true, ttftMs: 1300,
  };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 45 t/s · TTFT 1.3s'));
  assert.ok(!normal.includes('agents'));
});

test('non-swarm single subagent keeps the single-agent style', () => {
  const metrics = {
    tps: 45, tpsTotal: 45, tpsAgents: 1, activeAgents: 1,
    swarmMode: false, ttftMs: 1300,
  };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 45 t/s · TTFT 1.3s'));
  assert.ok(!normal.includes('agents'));
});

test('swarm with two subagents renders the fleet style verbatim', () => {
  const metrics = {
    tps: 45, tpsTotal: 90, tpsAgents: 2, activeAgents: 2,
    swarmMode: true, mainActive: false, mainSpeed: false, ttftMs: 1300,
  };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.equal(
    normal,
    '[manual] [swarm] K3 │ kimi-code-hud git:(main*) │ ⚡ 90 t/s (2 agents @45) · TTFT 1.3s │ 5h ███░░░░░░░ 31% ~2h18m · 7d ██░░░░░░░░ 25% ~3d2h',
  );
});

test('gen ticker keeps the head count for a swarm down to one subagent', () => {
  const [lone] = renderHud(baseCtx({
    layout: 'normal',
    metrics: {
      tps: null, ttftMs: null, turnStartedAt: NOW - 3000,
      activeAgents: 1, swarmMode: true, mainActive: false,
    },
  }));
  assert.ok(lone.includes('⚡ gen 3s (1 agent)'));
  // Two live subagents still label the fleet.
  const [pair] = renderHud(baseCtx({
    layout: 'normal',
    metrics: {
      tps: null, ttftMs: null, turnStartedAt: NOW - 3000,
      activeAgents: 2, swarmMode: true, mainActive: false,
    },
  }));
  assert.ok(pair.includes('⚡ gen 3s (2 agents)'));
  // Main-only after the swarm: the ticker goes solo again.
  const [mainOnly] = renderHud(baseCtx({
    layout: 'normal',
    metrics: {
      tps: null, ttftMs: null, turnStartedAt: NOW - 3000,
      activeAgents: 1, swarmMode: true, mainActive: true,
    },
  }));
  assert.ok(mainOnly.includes('⚡ gen 3s'));
  assert.ok(!mainOnly.includes('agents'));
});

test('compact layout keeps the fleet head count for a lone swarm subagent', () => {
  const [line] = renderHud(baseCtx({
    layout: 'compact',
    metrics: {
      tps: 45, tpsTotal: 45, tpsAgents: 1, activeAgents: 1,
      swarmMode: true, mainActive: false, mainSpeed: false,
    },
  }));
  assert.ok(line.includes('⚡ 45 (1@45)'));
});

test('live compaction takes the TTFT slot like the gen timer', () => {
  const metrics = { tps: 47, ttftMs: 1300, compactingSince: NOW - 14_000 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(normal.includes('⚡ 47 t/s · compacting 14s'));
  assert.ok(!normal.includes('TTFT'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('⚡ 47 compacting 14s'));
});

test('finished compaction holds the TTFT slot dimmed, drops in compact tier', () => {
  const metrics = { tps: 47, ttftMs: 1300, compactionMs: 30_000 };
  const [normal] = renderHud(baseCtx({ layout: 'normal', metrics, color: true }));
  assert.ok(normal.includes('⚡ 47 t/s\x1b[90m · compacted 30s\x1b[0m'));
  assert.ok(!normal.includes('TTFT'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(!compact.includes('compacted'));
});

test('gen timer takes the slot back from a finished compaction', () => {
  const metrics = {
    tps: 47, ttftMs: 1300,
    turnStartedAt: NOW - 60_000, compactionMs: 30_000,
  };
  const [line] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(line.includes('⚡ 47 t/s · gen 1m0s'));
  assert.ok(!line.includes('compacted'));
});

test('task badges render between model and project in the upstream slot order', () => {
  const metrics = { tps: 47, tasks: { bash: 1, agents: 2 } };
  const [line] = renderHud(baseCtx({ layout: 'normal', metrics }));
  assert.ok(line.includes('[1 task running] [2 agents running]'));
  // Upstream slot order is model → tasks → cwd/git.
  assert.ok(line.indexOf('K3') < line.indexOf('[1 task running]'));
  assert.ok(line.indexOf('[1 task running]') < line.indexOf('kimi-code-hud git:(main*)'));
  const [compact] = renderHud(baseCtx({ layout: 'compact', metrics }));
  assert.ok(compact.includes('[1 task running] [2 agents running]'));
});

test('task badges pluralize, hide at zero and paint primary blue', () => {
  const [both] = renderHud(baseCtx({ metrics: { tasks: { bash: 2, agents: 1 } } }));
  assert.ok(both.includes('[2 tasks running] [1 agent running]'));

  const [none] = renderHud(baseCtx({ metrics: { tasks: { bash: 0, agents: 0 } } }));
  assert.ok(!none.includes('running]'));

  const [missing] = renderHud(baseCtx({ metrics: { tps: 47 } }));
  assert.ok(!missing.includes('running]'));

  const [colored] = renderHud(baseCtx({
    color: true,
    metrics: { tasks: { bash: 1, agents: 0 } },
  }));
  assert.ok(colored.includes('\x1b[38;2;79;168;255m[1 task running]\x1b[0m'));
});
