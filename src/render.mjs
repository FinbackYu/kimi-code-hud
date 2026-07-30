import path from 'node:path';

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

function badges(payload, color) {
  const out = [];
  // Host defaults render auto/yolo in warning amber and plan in primary
  // blue; auto keeps bright red here per user preference to stay distinct.
  // Manual mode shows a muted [manual] so the line's left edge stays put
  // when no elevated-permission badge is present.
  if (payload.permissionMode === 'yolo') out.push(colorize(color, C.warning, '[yolo]'));
  else if (payload.permissionMode === 'auto') out.push(colorize(color, C.brightRed, '[auto]'));
  else out.push(colorize(color, C.muted, '[manual]'));
  if (payload.planMode) out.push(colorize(color, C.primary, '[plan]'));
  // The status-line payload does not carry swarmMode yet; rendered as soon
  // as the host exposes it (accent cyan, same as the built-in footer).
  if (payload.swarmMode) out.push(colorize(color, C.accent, '[swarm]'));
  return out;
}

/**
 * Build the segment list for one layout tier.
 * compact: model <effort> │ git:(branch) │ ⚡tps │ window pct+countdown
 * normal:  + project prefix, thinking suffix, t/s+TTFT, bars, weekly
 * full:    + Context segment, weekly countdown, version
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

  // Speed segment (omitted when no samples yet, e.g. fresh session)
  if (metrics && typeof metrics.tps === 'number') {
    const tps = Math.round(metrics.tps);
    if (layout === 'compact') {
      segs.push(`⚡ ${tps}`);
    } else {
      const ttft = formatTtft(metrics.ttftMs);
      segs.push(`⚡ ${tps} t/s${ttft ? ` · TTFT ${ttft}` : ''}`);
    }
  }

  // Quota segments (whole section omitted when no cache yet). Compact drops
  // the bar and keeps pct + reset countdown; other tiers show bar + pct,
  // and all tiers show the countdown when the reset time is known.
  if (quota) {
    for (const w of quota.windows || []) {
      const frac = w.used / w.limit;
      let s = layout === 'compact'
        ? `${w.label} ${pctOf(w.used, w.limit)}%`
        : `${w.label} ${bar(frac, color)} ${pctOf(w.used, w.limit)}%`;
      const cd = formatCountdown(w.resetAt, now);
      if (cd) s += ` ${cd}`;
      segs.push(s);
    }
    if (layout !== 'compact' && quota.weekly) {
      const frac = quota.weekly.used / quota.weekly.limit;
      let s = `wk ${bar(frac, color)} ${pctOf(quota.weekly.used, quota.weekly.limit)}%`;
      if (layout === 'full') {
        const cd = formatCountdown(quota.weekly.resetAt, now);
        if (cd) s += ` ${cd}`;
      }
      segs.push(s);
    }
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
 * @param {object|null} ctx.metrics {tps, ttftMs}
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
    const prefix = badges(payload, color);
    const segs = buildSegments(layout, { ...ctx, payload, color, now });
    const line = [...prefix, segs.join(' │ ')].filter(Boolean).join(' ');
    if (stripAnsi(line).length <= MAX_WIDTH || layout === 'compact') return [line];
  }
  return [String(payload.model || 'kimi')];
}
