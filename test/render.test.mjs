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
  assert.equal(formatCountdown('2026-07-30T12:18:00Z', NOW), '↻2h18m');
  assert.equal(formatCountdown('2026-08-02T12:00:00Z', NOW), '↻3d2h');
  assert.equal(formatCountdown('2026-07-30T10:45:00Z', NOW), '↻45m');
  assert.equal(formatCountdown('2026-07-30T09:00:00Z', NOW), '↻reset');
  assert.equal(formatCountdown(null, NOW), null);
  assert.equal(formatCountdown('garbage', NOW), null);
});

test('compact layout: model, git, ctx bar, speed, window bars only', () => {
  const [line] = renderHud(baseCtx({ layout: 'compact' }));
  const parts = line.split(' │ ');
  assert.equal(parts[0], 'K3');
  assert.equal(parts[1], 'git:(main*)');
  assert.equal(parts[2], 'ctx ██████░░░░ 62% (159K/256K)');
  assert.equal(parts[3], '⚡47');
  assert.equal(parts[4], '5h ███░░░░░░░ 31%');
  assert.equal(parts.length, 5); // no project, no wk, no countdowns, no version
});

test('normal layout adds project, t/s+TTFT, countdown and weekly', () => {
  const [line] = renderHud(baseCtx({ layout: 'normal' }));
  assert.equal(
    line,
    'K3 │ kimi-code-hud git:(main*) │ ctx ██████░░░░ 62% (159K/256K) │ ⚡47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ↻2h18m │ wk ██░░░░░░░░ 25%',
  );
});

test('full layout adds weekly countdown, version, thinking suffix', () => {
  const [line] = renderHud(baseCtx({ layout: 'full', payload: basePayload({ planMode: true }) }));
  assert.equal(
    line,
    '[plan] K3 thinking │ kimi-code-hud git:(main*) │ ctx ██████░░░░ 62% (159K/256K) │ ⚡47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ↻2h18m │ wk ██░░░░░░░░ 25% ↻3d2h │ v0.31.0',
  );
});

test('badges for yolo/auto permission modes', () => {
  const [yolo] = renderHud(baseCtx({ payload: basePayload({ permissionMode: 'yolo' }) }));
  assert.ok(yolo.startsWith('[yolo] '));
  const [auto] = renderHud(baseCtx({ payload: basePayload({ permissionMode: 'auto' }) }));
  assert.ok(auto.startsWith('[auto] '));
  const [manual] = renderHud(baseCtx());
  assert.ok(!manual.startsWith('['));
});

test('optional segments drop cleanly', () => {
  const [line] = renderHud(baseCtx({
    payload: basePayload({ gitBranch: null }),
    quota: null,
    metrics: { tps: null, ttftMs: null },
    gitDirty: false,
  }));
  assert.equal(line, 'K3 │ kimi-code-hud │ ctx ██████░░░░ 62% (159K/256K)');
});

test('ctx fraction prefers exact token counts', () => {
  const [line] = renderHud(baseCtx({
    layout: 'full',
    payload: basePayload({ contextTokens: 10485, maxContextTokens: 262144, contextUsage: 0.9 }),
  }));
  assert.ok(line.includes('ctx ░░░░░░░░░░ 4% (10K/256K)'));
});

test('falls back to contextUsage when token counts are missing', () => {
  const [line] = renderHud(baseCtx({
    layout: 'full',
    payload: basePayload({ contextTokens: undefined, maxContextTokens: undefined, contextUsage: 0.5 }),
  }));
  assert.ok(line.includes('ctx █████░░░░░ 50%'));
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

test('color badges use bright red/yellow', () => {
  const [line] = renderHud(baseCtx({
    color: true,
    payload: basePayload({ permissionMode: 'yolo', planMode: true }),
  }));
  assert.ok(line.includes('\x1b[91m[yolo]\x1b[0m'));
  assert.ok(line.includes('\x1b[93m[plan]\x1b[0m'));
});
