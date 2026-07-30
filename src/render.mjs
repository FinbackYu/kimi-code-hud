import path from 'node:path';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const C = {
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  brightYellow: `${ESC}93m`,
  brightRed: `${ESC}91m`,
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
 * Format a reset countdown from an ISO timestamp: "↻2h18m" / "↻3d2h",
 * "↻reset" when already past, null when unknown.
 * @param {string|null} resetAt
 * @param {number} [now]
 * @returns {string|null}
 */
export function formatCountdown(resetAt, now = Date.now()) {
  if (!resetAt) return null;
  const t = Date.parse(resetAt);
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  if (diff <= 0) return '↻reset';
  const mins = Math.floor(diff / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `↻${d}d${h}h`;
  if (h > 0) return `↻${h}h${m}m`;
  return `↻${m}m`;
}

function formatTtft(ms) {
  if (typeof ms !== 'number' || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function pctOf(used, limit) {
  return Math.round((used / limit) * 100);
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function badges(payload, color) {
  const out = [];
  if (payload.permissionMode === 'yolo') out.push(colorize(color, C.brightRed, '[yolo]'));
  else if (payload.permissionMode === 'auto') out.push(colorize(color, C.brightYellow, '[auto]'));
  if (payload.planMode) out.push(colorize(color, C.brightYellow, '[plan]'));
  return out;
}

/**
 * Build the segment list for one layout tier.
 * compact: model │ git │ ctx bar │ ⚡tps │ window bars
 * normal:  + project, t/s+TTFT, window countdowns, weekly
 * full:    + ctx %, weekly countdown, version
 */
function buildSegments(layout, ctx) {
  const { payload, quota, metrics, gitDirty, color, now } = ctx;
  const segs = [];

  const plan = !!payload.planMode;
  segs.push(layout === 'full' && plan ? `${payload.model} thinking` : String(payload.model));

  if (layout !== 'compact' && payload.cwd) {
    segs.push(path.basename(payload.cwd) || payload.cwd);
  }

  if (payload.gitBranch) {
    segs.push(`${payload.gitBranch}${gitDirty ? '*' : ''}`);
  }

  // Context usage bar (host line 2 already shows exact numbers, so the
  // percentage text only appears in full layout).
  let ctxFrac = 0;
  if (typeof payload.contextTokens === 'number' && typeof payload.maxContextTokens === 'number' && payload.maxContextTokens > 0) {
    ctxFrac = payload.contextTokens / payload.maxContextTokens;
  } else if (typeof payload.contextUsage === 'number') {
    ctxFrac = payload.contextUsage;
  }
  segs.push(`ctx ${bar(ctxFrac, color)}${layout === 'full' ? ` ${Math.round(ctxFrac * 100)}%` : ''}`);

  // Speed segment (omitted when no samples yet, e.g. fresh session)
  if (metrics && typeof metrics.tps === 'number') {
    const tps = Math.round(metrics.tps);
    if (layout === 'compact') {
      segs.push(`⚡${tps}`);
    } else {
      const ttft = formatTtft(metrics.ttftMs);
      segs.push(`⚡${tps} t/s${ttft ? ` · TTFT ${ttft}` : ''}`);
    }
  }

  // Quota segments (whole section omitted when no cache yet)
  if (quota) {
    for (const w of quota.windows || []) {
      const frac = w.used / w.limit;
      let s = `${w.label} ${bar(frac, color)} ${pctOf(w.used, w.limit)}%`;
      if (layout !== 'compact') {
        const cd = formatCountdown(w.resetAt, now);
        if (cd) s += ` ${cd}`;
      }
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
