import path from 'node:path';

import { formatGoalBadge } from './goal.mjs';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** 24-bit truecolor foreground, matching the host's dark-theme hex values. */
function rgb(r, g, b) {
  return `${ESC}38;2;${r};${g};${b}m`;
}

const C = {
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  brightYellow: `${ESC}93m`,
  brightRed: `${ESC}91m`,
  muted: `${ESC}90m`, // bright black / gray — placeholder badges
  // Host defaults (dark theme, from kimi-code tui/theme/colors.ts):
  warning: rgb(232, 168, 56), // #E8A838 — auto/yolo badges
  primary: rgb(79, 168, 255), // #4FA8FF — plan badge
  accent: rgb(91, 192, 190), //  #5BC0BE — swarm badge
};

const BAR_WIDTH = 10;
const MAX_WIDTH = 200;
const LAYOUT_ORDER = ['full', 'normal', 'compact'];

function colorize(enabled, color, str) {
  return enabled ? `${color}${str}${RESET}` : str;
}

/** Usage-graded bar color: <60% green, <85% yellow, >=85% red. */
function levelColor(frac) {
  if (frac >= 0.85) return C.red;
  if (frac >= 0.6) return C.yellow;
  return C.green;
}

/**
 * Render a 10-cell progress bar for a 0..1 fraction.
 * @param {number} frac
 * @param {boolean} color
 * @returns {string}
 */
export function bar(frac, color) {
  const clamped = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  const filled = Math.floor(clamped * BAR_WIDTH);
  const s = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  return colorize(color, levelColor(clamped), s);
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

function badges(payload, color, swarmOn) {
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
function goalBadge(goal, color, now) {
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

/**
 * Build the segment list for one layout tier.
 * compact: model <effort> │ git:(branch) │ ⚡tps │ Cache pct │ window pct+countdown
 * normal:  + project prefix, thinking suffix, t/s+TTFT, bars, weekly+countdown
 * full:    + Context segment, cache token counts, version
 * (Context only in full — the host's line 2 already shows the numbers)
 */
function buildSegments(layout, ctx) {
  const { payload, quota, metrics, gitDirty, color, now } = ctx;
  const segs = [];

  // Model with thinking suffix, mirroring the host footer: boolean models
  // show " thinking", effort-capable ones " thinking:<effort>" (halfwidth
  // colon, no space — keeps the suffix compact). Compact drops the
  // "thinking" label and keeps only " <effort>" (space-separated). The level comes from the
  // session log's config.update events (the status-line payload does not
  // carry thinking state). The model name is painted in the host's primary
  // blue (#4FA8FF), the suffix stays in default text color.
  const level = metrics && typeof metrics.thinkingLevel === 'string' ? metrics.thinkingLevel : null;
  let modelSeg = colorize(color, C.primary, String(payload.model));
  if (level && level !== 'off') {
    if (layout === 'compact') modelSeg += ` ${level}`;
    else modelSeg += level === 'on' ? ' thinking' : ` thinking:${level}`;
  }
  segs.push(modelSeg);

  // Project + git in Claude HUD style: "my-project git:(main*)". Compact
  // drops the project name; without a branch the project stands alone.
  const project =
    layout !== 'compact' && payload.cwd ? path.basename(payload.cwd) || payload.cwd : null;
  if (payload.gitBranch) {
    const git = `git:(${payload.gitBranch}${gitDirty ? '*' : ''})`;
    segs.push(project ? `${project} ${git}` : git);
  } else if (project) {
    segs.push(project);
  }

  // Context usage: bar + exact percentage + token counts. Only full shows
  // it; compact/normal leave the exact numbers to the host's line 2.
  if (layout === 'full') {
    let ctxFrac = 0;
    const hasCounts =
      typeof payload.contextTokens === 'number' &&
      typeof payload.maxContextTokens === 'number' &&
      payload.maxContextTokens > 0;
    if (hasCounts) {
      ctxFrac = payload.contextTokens / payload.maxContextTokens;
    } else if (typeof payload.contextUsage === 'number') {
      ctxFrac = payload.contextUsage;
    }
    let ctxSeg = `Context ${bar(ctxFrac, color)} ${Math.round(ctxFrac * 100)}%`;
    if (hasCounts) {
      ctxSeg += ` (${formatTokens(payload.contextTokens)}/${formatTokens(payload.maxContextTokens)})`;
    }
    segs.push(ctxSeg);
  }

  // Speed segment. A fresh solo window (enough recent, reliable samples)
  // renders bright; once it expires the last median stays visible in muted
  // gray instead of disappearing. With several active agents
  // (swarm/subagents) show the fleet total plus "N agents @avg". While the
  // turn is running (turnStartedAt set — from the user's prompt until
  // end_turn/cancel) the segment swaps the static last-step TTFT for a live
  // "gen <elapsed>" turn-work timer, so long generations and tool runs show
  // how long the command has been working, not just one request. Only the
  // initial warmup (no median yet, no turn in flight) falls back to a bare
  // TTFT.
  const turnStart = metrics && typeof metrics.turnStartedAt === 'number' ? metrics.turnStartedAt : null;
  const multi = metrics && typeof metrics.tpsTotal === 'number' && metrics.activeAgents > 1;
  const gen = turnStart !== null ? formatElapsed(now - turnStart) : null;
  if (metrics && typeof metrics.tps === 'number') {
    const avg = Math.round(metrics.tps);
    // Stale (2 min without samples) dims the speed/TTFT text only; a live gen
    // timer stays bright — the turn is actively working even though the last
    // median is old.
    const paint = (s) => (metrics.tpsStale === true ? colorize(color, C.muted, s) : s);
    if (layout === 'compact') {
      const head = multi ? `⚡ ${Math.round(metrics.tpsTotal)} (${metrics.activeAgents}@${avg})` : `⚡ ${avg}`;
      segs.push(gen ? `${paint(head)} gen ${gen}` : paint(head));
    } else {
      const base = multi
        ? `⚡ ${Math.round(metrics.tpsTotal)} t/s (${metrics.activeAgents} agents @${avg})`
        : `⚡ ${avg} t/s`;
      if (gen) {
        segs.push(`${paint(base)} · gen ${gen}`);
      } else {
        const ttft = formatTtft(metrics.ttftMs);
        segs.push(paint(`${base}${ttft ? ` · TTFT ${ttft}` : ''}`));
      }
    }
  } else if (metrics && turnStart !== null) {
    const n = metrics.activeAgents > 1 ? ` (${metrics.activeAgents} agents)` : '';
    segs.push(`⚡ gen ${gen}${n}`);
  } else if (metrics) {
    const ttft = formatTtft(metrics.ttftMs);
    if (ttft) segs.push(`TTFT ${ttft}`);
  }

  // Current user-turn prompt-cache hit rate. The reducer guarantees a
  // complete token-weighted metric; rendering stays neutral because a useful
  // rate depends on provider and workload rather than universal thresholds.
  const cache = metrics?.cache;
  if (
    cache &&
    typeof cache.hitRate === 'number' &&
    Number.isFinite(cache.hitRate) &&
    cache.hitRate >= 0 &&
    cache.hitRate <= 1
  ) {
    let cacheSeg = `Cache ${Math.round(cache.hitRate * 100)}%`;
    if (
      layout === 'full' &&
      typeof cache.readTokens === 'number' &&
      typeof cache.inputTokens === 'number'
    ) {
      cacheSeg += ` (${formatTokens(cache.readTokens)}/${formatTokens(cache.inputTokens)})`;
    }
    segs.push(cacheSeg);
  }

  // Quota group (omitted when no quota cache exists): all windows join into
  // one segment with "·", lighter than the "│" between segments — the 5h and
  // 7d windows read as one quota block. Compact drops the bar and keeps pct +
  // reset countdown; other tiers show bar + pct, and all tiers show the
  // countdown when the reset time is known.
  if (quota) {
    const parts = [];
    for (const w of quota.windows || []) {
      const frac = w.used / w.limit;
      let s = layout === 'compact'
        ? `${w.label} ${pctOf(w.used, w.limit)}%`
        : `${w.label} ${bar(frac, color)} ${pctOf(w.used, w.limit)}%`;
      const cd = formatCountdown(w.resetAt, now);
      if (cd) s += ` ${cd}`;
      parts.push(s);
    }
    // Weekly window, labeled "7d" to match the 5h-style window labels; its
    // reset countdown shows from normal up (compact drops the segment).
    if (layout !== 'compact' && quota.weekly) {
      const frac = quota.weekly.used / quota.weekly.limit;
      let s = `7d ${bar(frac, color)} ${pctOf(quota.weekly.used, quota.weekly.limit)}%`;
      const cd = formatCountdown(quota.weekly.resetAt, now);
      if (cd) s += ` ${cd}`;
      parts.push(s);
    }
    if (parts.length) segs.push(parts.join(' · '));
  }

  if (layout === 'full' && payload.version) {
    segs.push(`v${payload.version}`);
  }

  return segs;
}

/**
 * Render the HUD. Returns an array of lines (currently a single line; the
 * array shape leaves room for a future second line). Downgrades the layout
 * full -> normal -> compact when the line exceeds MAX_WIDTH visible chars.
 * @param {object} ctx
 * @param {object} ctx.payload stdin snapshot from the host
 * @param {object|null} ctx.quota parsed quota cache (without fetchedAt)
 * @param {object|null} ctx.metrics {tps, tpsStale, ttftMs, thinkingLevel, goal, swarmMode, cache, tpsTotal, activeAgents, turnStartedAt}
 * @param {boolean} ctx.gitDirty
 * @param {string} [ctx.layout] full|normal|compact
 * @param {boolean} [ctx.color]
 * @param {number} [ctx.now]
 * @returns {string[]}
 */
export function renderHud(ctx) {
  const color = ctx.color !== false;
  const now = ctx.now ?? Date.now();
  const payload = ctx.payload || {};
  const startIdx = Math.max(0, LAYOUT_ORDER.indexOf(ctx.layout || 'normal'));
  for (let i = startIdx; i < LAYOUT_ORDER.length; i++) {
    const layout = LAYOUT_ORDER[i];
    const prefix = badges(payload, color, ctx.metrics?.swarmMode === true);
    const goal = goalBadge(ctx.metrics?.goal, color, now);
    if (goal) prefix.push(goal);
    const segs = buildSegments(layout, { ...ctx, payload, color, now });
    const line = [...prefix, segs.join(' │ ')].filter(Boolean).join(' ');
    if (stripAnsi(line).length <= MAX_WIDTH || layout === 'compact') return [line];
  }
  return [String(payload.model || 'kimi')];
}
