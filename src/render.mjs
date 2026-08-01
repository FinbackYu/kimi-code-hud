import path from 'node:path';

import { formatGoalBadge } from './goal.mjs';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** 24-bit truecolor foreground, matching the host's theme hex values. */
function rgb(r, g, b) {
  return `${ESC}38;2;${r};${g};${b}m`;
}

// The ANSI slots are theme-independent (the terminal remaps them per its own
// theme); only the badges and bar levels follow the resolved theme. Base hex
// values from the host's tui/theme/colors.ts dark and light palettes.
const ANSI = {
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  brightYellow: `${ESC}93m`,
  brightRed: `${ESC}91m`,
  muted: `${ESC}90m`, // bright black / gray — placeholder badges
};

const DARK = {
  ...ANSI,
  warning: rgb(232, 168, 56), // #E8A838 — auto/yolo badges
  primary: rgb(79, 168, 255), // #4FA8FF — plan badge
  accent: rgb(91, 192, 190), //  #5BC0BE — swarm badge
  barRed: ANSI.red,
  barYellow: ANSI.yellow,
  barGreen: ANSI.green,
};

// Light theme: badges go bold — short labels need the extra weight on a
// white background. Amber/teal use brighter hues than the host's (its
// #92660A / #00838F read muddy); the bar red/green take the host's calmer
// light error/success instead of the terminal's glaring ANSI red.
const LIGHT = {
  ...ANSI,
  brightRed: `${ESC}1;91m`, //                bold — auto badge
  warning: `${ESC}1m${rgb(217, 119, 6)}`, //  bold #D97706 — yolo/goal blocked
  primary: `${ESC}1m${rgb(21, 101, 192)}`, // bold #1565C0 — plan/model
  accent: `${ESC}1m${rgb(20, 184, 166)}`, //  bold #14B8A6 — swarm
  barRed: rgb(185, 28, 28), //                #B91C1C — host light error
  barYellow: rgb(217, 119, 6), //             #D97706 — matches the badge amber
  barGreen: rgb(14, 122, 56), //              #0E7A38 — host light success
};

const BAR_WIDTH = 10;
const MAX_WIDTH = 200;
const LAYOUT_ORDER = ['full', 'normal', 'compact'];

function colorize(enabled, color, str) {
  return enabled ? `${color}${str}${RESET}` : str;
}

/** Usage-graded bar color: <60% green, <85% yellow, >=85% red. The palette
 * decides the concrete hues — ANSI on dark, truecolor on light. */
function levelColor(frac, C = DARK) {
  if (frac >= 0.85) return C.barRed;
  if (frac >= 0.6) return C.barYellow;
  return C.barGreen;
}

/**
 * Render a 10-cell progress bar for a 0..1 fraction.
 * @param {number} frac
 * @param {boolean} color
 * @param {object} [C] palette (default DARK)
 * @returns {string}
 */
export function bar(frac, color, C = DARK) {
  const clamped = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  const filled = Math.floor(clamped * BAR_WIDTH);
  const s = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  return colorize(color, levelColor(clamped, C), s);
}

/**
 * Format a reset countdown from an ISO timestamp: "~2h18m" / "~3d2h",
 * "~reset" when already past, null when unknown. The marker is plain ASCII:
 * ↻ (U+21BB) is East-Asian Ambiguous width and overlaps the digits in
 * terminals/fonts that draw it wider than one cell.
 * @param {string|null} resetAt
 * @param {number} [now]
 * @returns {string|null}
 */
export function formatCountdown(resetAt, now = Date.now()) {
  if (!resetAt) return null;
  const t = Date.parse(resetAt);
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  if (diff <= 0) return '~reset';
  const mins = Math.floor(diff / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `~${d}d${h}h`;
  if (h > 0) return `~${h}h${m}m`;
  return `~${m}m`;
}

function formatTtft(ms) {
  if (typeof ms !== 'number' || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Elapsed wall-clock for the live generation ticker: "45s" / "4m5s" / "1h12m" / "2d3h". */
function formatElapsed(ms) {
  if (typeof ms !== 'number' || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  // Keep the seconds past the one-minute mark: a bare "4m" changes only once
  // a minute and reads as a static number while the turn is still working.
  if (mins < 60) return `${mins}m${s % 60}s`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h${mins % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function pctOf(used, limit) {
  return Math.round((used / limit) * 100);
}

/** 1024-based token count: 10485 -> "10K", 262144 -> "256K", 1048576 -> "1M". */
function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return String(Math.round(n));
  if (n < 1048576) return `${Math.round(n / 1024)}K`;
  const m = n / 1048576;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function badges(payload, color, swarmOn, C) {
  const out = [];
  // Host defaults render auto/yolo in warning amber and plan in primary
  // blue; auto keeps bright red here per user preference to stay distinct.
  // Manual mode shows a muted [manual] so the line's left edge stays put
  // when no elevated-permission badge is present.
  if (payload.permissionMode === 'yolo') out.push(colorize(color, C.warning, '[yolo]'));
  else if (payload.permissionMode === 'auto') out.push(colorize(color, C.brightRed, '[auto]'));
  else out.push(colorize(color, C.muted, '[manual]'));
  if (payload.planMode) out.push(colorize(color, C.primary, '[plan]'));
  // Swarm mode comes from the wire journal's swarm_mode.enter/exit lines,
  // folded into metrics (same derivation path as the goal badge); a future
  // payload.swarmMode field also turns it on (accent cyan, same as the
  // built-in footer).
  if (swarmOn || payload.swarmMode) out.push(colorize(color, C.accent, '[swarm]'));
  return out;
}

/**
 * Goal badge, mirroring the built-in footer's goal slot (`mode → goal →
 * model`): colored status dot (active = primary blue, blocked = warning
 * amber, paused = muted) inside muted brackets. The status-line payload
 * carries no goal field; the state comes from the wire journal's goal ops.
 * Shown in every layout tier — a live goal is too important to drop.
 */
function goalBadge(goal, color, now, C) {
  const badge = formatGoalBadge(goal, now);
  if (!badge) return null;
  const dotColor =
    badge.status === 'active' ? C.primary : badge.status === 'blocked' ? C.warning : C.muted;
  if (!color) return badge.text;
  // Repaint the dot (always the 7th char: "[goal ●") and mute the rest.
  const dotIdx = badge.text.indexOf('●');
  const before = badge.text.slice(0, dotIdx);
  const after = badge.text.slice(dotIdx + 1);
  return `${C.muted}${before}${RESET}${dotColor}●${RESET}${C.muted}${after}${RESET}`;
}

const LAYOUT_LEVEL = { compact: 0, normal: 1, full: 2 };

function modelSegment({ layout, payload, metrics, color, C }) {
  const level = metrics && typeof metrics.thinkingLevel === 'string'
    ? metrics.thinkingLevel
    : null;
  let segment = colorize(color, C.primary, String(payload.model));
  if (level && level !== 'off') {
    segment += layout === 'compact'
      ? ` ${level}`
      : level === 'on' ? ' thinking' : ` thinking:${level}`;
  }
  return segment;
}

function projectSegment({ layout, payload, gitDirty }) {
  const project = layout !== 'compact' && payload.cwd
    ? path.basename(payload.cwd) || payload.cwd
    : null;
  if (payload.gitBranch) {
    const git = `git:(${payload.gitBranch}${gitDirty ? '*' : ''})`;
    return project ? `${project} ${git}` : git;
  }
  return project;
}

function contextSegment({ payload, color, C }) {
  let fraction = 0;
  const hasCounts =
    typeof payload.contextTokens === 'number' &&
    typeof payload.maxContextTokens === 'number' &&
    payload.maxContextTokens > 0;
  if (hasCounts) fraction = payload.contextTokens / payload.maxContextTokens;
  else if (typeof payload.contextUsage === 'number') fraction = payload.contextUsage;
  let segment = `Context ${bar(fraction, color, C)} ${Math.round(fraction * 100)}%`;
  if (hasCounts) {
    segment += ` (${formatTokens(payload.contextTokens)}/${formatTokens(payload.maxContextTokens)})`;
  }
  return segment;
}

function speedSegment({ layout, metrics, color, now, C }) {
  const turnStart = metrics && typeof metrics.turnStartedAt === 'number'
    ? metrics.turnStartedAt
    : null;
  const multi = metrics && typeof metrics.tpsTotal === 'number' && metrics.activeAgents > 1;
  const generatedFor = turnStart !== null ? formatElapsed(now - turnStart) : null;
  const compacting =
    !generatedFor && metrics && typeof metrics.compactingSince === 'number'
      ? formatElapsed(now - metrics.compactingSince)
      : null;
  const compacted =
    !generatedFor && !compacting && metrics && typeof metrics.compactionMs === 'number'
      ? formatElapsed(metrics.compactionMs)
      : null;
  if (metrics && typeof metrics.tps === 'number') {
    const average = Math.round(metrics.tps);
    const paint = (text) => (
      metrics.tpsStale === true ? colorize(color, C.muted, text) : text
    );
    if (layout === 'compact') {
      const head = multi
        ? `⚡ ${Math.round(metrics.tpsTotal)} (${metrics.activeAgents}@${average})`
        : `⚡ ${average}`;
      const live = generatedFor
        ? `gen ${generatedFor}`
        : compacting ? `compacting ${compacting}` : null;
      return live ? `${paint(head)} ${live}` : paint(head);
    }
    const base = multi
      ? `⚡ ${Math.round(metrics.tpsTotal)} t/s (${metrics.activeAgents} agents @${average})`
      : `⚡ ${average} t/s`;
    if (generatedFor) return `${paint(base)} · gen ${generatedFor}`;
    if (compacting) return `${paint(base)} · compacting ${compacting}`;
    if (compacted) {
      return `${paint(base)}${colorize(color, C.muted, ` · compacted ${compacted}`)}`;
    }
    const ttft = formatTtft(metrics.ttftMs);
    return paint(`${base}${ttft ? ` · TTFT ${ttft}` : ''}`);
  }
  if (metrics && turnStart !== null) {
    const agents = metrics.activeAgents > 1 ? ` (${metrics.activeAgents} agents)` : '';
    return `⚡ gen ${generatedFor}${agents}`;
  }
  if (metrics && compacting) return `compacting ${compacting}`;
  if (metrics && compacted && layout !== 'compact') {
    return colorize(color, C.muted, `compacted ${compacted}`);
  }
  const ttft = metrics ? formatTtft(metrics.ttftMs) : null;
  return ttft ? `TTFT ${ttft}` : null;
}

function cacheSegment({ layout, metrics }) {
  const cache = metrics?.cache;
  if (
    !cache ||
    typeof cache.hitRate !== 'number' ||
    !Number.isFinite(cache.hitRate) ||
    cache.hitRate < 0 ||
    cache.hitRate > 1
  ) {
    return null;
  }
  let segment = `Cache ${Math.round(cache.hitRate * 100)}%`;
  if (
    layout === 'full' &&
    typeof cache.readTokens === 'number' &&
    typeof cache.inputTokens === 'number'
  ) {
    segment += ` (${formatTokens(cache.readTokens)}/${formatTokens(cache.inputTokens)})`;
  }
  return segment;
}

function quotaSegment({ layout, quota, color, now, C }) {
  if (!quota) return null;
  const parts = [];
  for (const window of quota.windows || []) {
    const fraction = window.used / window.limit;
    let text = layout === 'compact'
      ? `${window.label} ${pctOf(window.used, window.limit)}%`
      : `${window.label} ${bar(fraction, color, C)} ${pctOf(window.used, window.limit)}%`;
    const countdown = formatCountdown(window.resetAt, now);
    if (countdown) text += ` ${countdown}`;
    parts.push(text);
  }
  if (layout !== 'compact' && quota.weekly) {
    const fraction = quota.weekly.used / quota.weekly.limit;
    let text = `7d ${bar(fraction, color, C)} ${pctOf(quota.weekly.used, quota.weekly.limit)}%`;
    const countdown = formatCountdown(quota.weekly.resetAt, now);
    if (countdown) text += ` ${countdown}`;
    parts.push(text);
  }
  return parts.length ? parts.join(' · ') : null;
}

function versionSegment({ payload }) {
  return payload.version ? `v${payload.version}` : null;
}

// Each pure builder declares the minimum information tier at which it may
// appear. Builders still receive the actual tier for compact representations.
const SEGMENT_BUILDERS = [
  { minLayout: 'compact', build: modelSegment },
  { minLayout: 'compact', build: projectSegment },
  { minLayout: 'full', build: contextSegment },
  { minLayout: 'compact', build: speedSegment },
  { minLayout: 'compact', build: cacheSegment },
  { minLayout: 'compact', build: quotaSegment },
  { minLayout: 'full', build: versionSegment },
];

function buildSegments(layout, ctx) {
  return SEGMENT_BUILDERS
    .filter(({ minLayout }) => LAYOUT_LEVEL[layout] >= LAYOUT_LEVEL[minLayout])
    .map(({ build }) => build({ ...ctx, layout }))
    .filter(Boolean);
}

/**
 * Render the HUD. Returns an array of lines (currently a single line; the
 * array shape leaves room for a future second line). Downgrades the layout
 * full -> normal -> compact when the line exceeds MAX_WIDTH visible chars.
 * @param {object} ctx
 * @param {object} ctx.payload stdin snapshot from the host
 * @param {object|null} ctx.quota parsed quota cache (without fetchedAt)
 * @param {object|null} ctx.metrics {tps, tpsStale, ttftMs, thinkingLevel, goal, swarmMode, cache, tpsTotal, activeAgents, turnStartedAt, compactingSince, compactionMs}
 * @param {boolean} ctx.gitDirty
 * @param {string} [ctx.layout] full|normal|compact
 * @param {boolean} [ctx.color]
 * @param {string} [ctx.theme] dark|light — badge palette (default dark)
 * @param {number} [ctx.now]
 * @returns {string[]}
 */
export function renderHud(ctx) {
  const color = ctx.color !== false;
  const C = ctx.theme === 'light' ? LIGHT : DARK;
  const now = ctx.now ?? Date.now();
  const payload = ctx.payload || {};
  const startIdx = Math.max(0, LAYOUT_ORDER.indexOf(ctx.layout || 'normal'));
  for (let i = startIdx; i < LAYOUT_ORDER.length; i++) {
    const layout = LAYOUT_ORDER[i];
    const prefix = badges(payload, color, ctx.metrics?.swarmMode === true, C);
    const goal = goalBadge(ctx.metrics?.goal, color, now, C);
    if (goal) prefix.push(goal);
    const segs = buildSegments(layout, { ...ctx, payload, color, now, C });
    const line = [...prefix, segs.join(' │ ')].filter(Boolean).join(' ');
    if (stripAnsi(line).length <= MAX_WIDTH || layout === 'compact') return [line];
  }
  return [String(payload.model || 'kimi')];
}
