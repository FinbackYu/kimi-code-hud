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
const LAYOUT_ORDER = ['normal', 'compact'];

function skipCsi(input, start) {
  for (let i = start; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
  }
  return input.length;
}

function skipStringControl(input, start, bellTerminates) {
  for (let i = start; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (bellTerminates && code === 0x07) return i + 1;
    if (code === 0x9c) return i + 1;
    if (code === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return input.length;
}

/**
 * Remove terminal controls from untrusted display text before HUD styling is
 * applied. OSC/DCS-style strings are removed with their payload; CSI/ESC
 * commands and every C0, DEL, and C1 control byte are removed as controls.
 */
function sanitizeTerminalText(value) {
  const input = String(value ?? '');
  let output = '';
  for (let i = 0; i < input.length;) {
    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b) {
        i = skipCsi(input, i + 2);
      } else if (next === 0x5d) {
        i = skipStringControl(input, i + 2, true);
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        i = skipStringControl(input, i + 2, false);
      } else {
        // A two-byte ESC command, or an incomplete trailing ESC.
        i += next >= 0x20 && next <= 0x7e ? 2 : 1;
      }
      continue;
    }
    if (code === 0x9b) {
      i = skipCsi(input, i + 1);
      continue;
    }
    if (code === 0x9d) {
      i = skipStringControl(input, i + 1, true);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      i = skipStringControl(input, i + 1, false);
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      i += 1;
      continue;
    }
    output += input[i];
    i += 1;
  }
  return output;
}

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

/** Compact-mode percentage color: same 60/85% thresholds as the bar, but the
 * comfortable green level stays default-colored — a bare percentage only
 * paints when usage is actually worth attention. */
function numberLevelColor(frac, C) {
  if (frac >= 0.85) return C.barRed;
  if (frac >= 0.6) return C.barYellow;
  return null;
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
 * Goal badge in the built-in footer's goal slot (`mode → goal → model`):
 * `[goal 7 turns]` (`3/10 turns` with a turn budget). All three states
 * share the same shape and differ only in color: the word "goal" carries
 * the status color — active = primary blue, blocked = warning amber —
 * with the brackets and turn count in the default foreground; paused
 * renders the whole badge muted. The status-line payload carries no goal
 * field; the state comes from the wire journal's goal ops. Shown in every
 * layout tier — a live goal is too important to drop.
 */
function goalBadge(goal, color, C) {
  const badge = formatGoalBadge(goal);
  if (!badge) return null;
  const text = sanitizeTerminalText(badge.text);
  if (!color) return text;
  if (badge.status === 'paused') return `${C.muted}${text}${RESET}`;
  const statusColor = badge.status === 'active' ? C.primary : C.warning;
  return `[${statusColor}goal${RESET}${text.slice('[goal'.length)}`;
}

const LAYOUT_LEVEL = { compact: 0, normal: 1 };

function modelSegment({ layout, payload, metrics, color, C }) {
  const level = metrics && typeof metrics.thinkingLevel === 'string'
    ? sanitizeTerminalText(metrics.thinkingLevel)
    : null;
  let segment = colorize(color, C.primary, sanitizeTerminalText(payload.model));
  if (level && level !== 'off') {
    // Effort-capable models show the bare level ("K3 max"); only boolean
    // thinking keeps the " thinking" label (compact: " on"). A level still
    // waiting for wire confirmation renders muted, like provisional TPS.
    const suffix = level === 'on' && layout !== 'compact' ? ' thinking' : ` ${level}`;
    segment += metrics && metrics.thinkingProvisional === true
      ? colorize(color, C.muted, suffix)
      : suffix;
  }
  return segment;
}

function projectSegment({ layout, payload, gitDirty }) {
  const cwd = typeof payload.cwd === 'string' ? sanitizeTerminalText(payload.cwd) : '';
  const project = layout !== 'compact' && cwd
    ? path.basename(cwd) || cwd
    : null;
  const gitBranch = sanitizeTerminalText(payload.gitBranch);
  if (gitBranch) {
    const git = `git:(${gitBranch}${gitDirty ? '*' : ''})`;
    return project ? `${project} ${git}` : git;
  }
  return project;
}

/**
 * Background-task badges, mirroring the built-in footer's `tasks` slot
 * (`model → tasks → cwd`): `[N task(s) running]` for shell processes and
 * `[N agent(s) running]` for background subagents, primary blue, each hidden
 * at zero. Counts come from the durable task registry (wire journal +
 * sidecar reconcile), never from the throughput head counts.
 */
function taskSegment({ metrics, color, C }) {
  const tasks = metrics?.tasks;
  if (!tasks || typeof tasks !== 'object') return null;
  const bash = Number.isInteger(tasks.bash) && tasks.bash > 0 ? tasks.bash : 0;
  const agents = Number.isInteger(tasks.agents) && tasks.agents > 0 ? tasks.agents : 0;
  if (bash === 0 && agents === 0) return null;
  const badges = [];
  if (bash > 0) badges.push(`[${bash} ${bash === 1 ? 'task' : 'tasks'} running]`);
  if (agents > 0) badges.push(`[${agents} ${agents === 1 ? 'agent' : 'agents'} running]`);
  return colorize(color, C.primary, badges.join(' '));
}

function speedSegment({ layout, metrics, color, now, C }) {
  const turnStart = metrics && typeof metrics.turnStartedAt === 'number'
    ? metrics.turnStartedAt
    : null;
  // Live subagents: every active agent except main. A swarm that has run
  // down to its last member is still a fleet, so fleet style holds while at
  // least one subagent lives; once only main remains it falls back to solo.
  const liveSubagents =
    metrics && typeof metrics.activeAgents === 'number'
      ? metrics.activeAgents - (metrics.mainActive === true ? 1 : 0)
      : 0;
  // The parenthetical head count must match the agents actually feeding the
  // total/average: an agent still waiting on its first step counts as active
  // (gen ticker) but has no speed reading yet (tpsAgents).
  const multi =
    metrics &&
    typeof metrics.tpsAgents === 'number' &&
    (metrics.tpsAgents > 1 || (metrics.swarmMode === true && liveSubagents >= 1 && metrics.tpsAgents >= 1));
  const generatedFor =
    turnStart !== null ? formatElapsed(now - turnStart) : null;
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
      const count = multi && metrics.mainSpeed === true
        ? `main+${metrics.tpsAgents - 1}`
        : metrics.tpsAgents;
      const head = multi
        ? `⚡ ${Math.round(metrics.tpsTotal)} (${count}@${average})`
        : `⚡ ${average}`;
      const live = generatedFor
        ? `gen ${generatedFor}`
        : compacting ? `compacting ${compacting}` : null;
      return live ? `${paint(head)} ${live}` : paint(head);
    }
    const base = multi
      ? `⚡ ${Math.round(metrics.tpsTotal)} t/s (${fleetLabel(metrics.tpsAgents, metrics.mainSpeed)} @${average})`
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
    const agents = metrics.activeAgents > 1 || (metrics.swarmMode === true && liveSubagents >= 1)
      ? ` (${fleetLabel(metrics.activeAgents, metrics.mainActive)})`
      : '';
    return `⚡ gen ${generatedFor}${agents}`;
  }
  if (metrics && compacting) return `compacting ${compacting}`;
  if (metrics && compacted && layout !== 'compact') {
    return colorize(color, C.muted, `compacted ${compacted}`);
  }
  const ttft = metrics ? formatTtft(metrics.ttftMs) : null;
  return ttft ? `TTFT ${ttft}` : null;
}

/**
 * Fleet head-count label. The main agent is named explicitly whenever it is
 * part of the figure, so "main+4 agents" can't be misread as a pure subagent
 * count while a swarm is running — or while a main blocked in a single Agent
 * tool call (non-swarm turn still open) is still counted. A lone member is
 * singular ("1 agent").
 * @param {number} count agents feeding the figure
 * @param {boolean} [includesMain]
 * @returns {string}
 */
function fleetLabel(count, includesMain) {
  if (includesMain === true) return `main+${count - 1} agents`;
  return `${count} ${count === 1 ? 'agent' : 'agents'}`;
}

function cacheSegment({ metrics }) {
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
  return `Cache ${Math.round(cache.hitRate * 100)}%`;
}

function quotaSegment({ layout, quota, color, now, C }) {
  if (!quota) return null;
  const parts = [];
  for (const window of quota.windows || []) {
    const fraction = window.used / window.limit;
    const pct = `${pctOf(window.used, window.limit)}%`;
    const label = sanitizeTerminalText(window.label);
    // Compact drops the bar, so the percentage itself takes over the
    // usage-level signal the bar color carries in the normal layout.
    let text;
    if (layout === 'compact') {
      const level = numberLevelColor(fraction, C);
      text = `${label} ${level ? colorize(color, level, pct) : pct}`;
    } else {
      text = `${label} ${bar(fraction, color, C)} ${pct}`;
    }
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

function providerBalanceText(balance) {
  if (!balance || typeof balance.total !== 'number' || !Number.isFinite(balance.total)) return null;
  const amount = balance.total.toFixed(2);
  if (balance.currency === 'CNY') return `¥${amount}`;
  if (balance.currency === 'USD') return `$${amount}`;
  return `${sanitizeTerminalText(balance.currency)} ${amount}`;
}

function providerCostText(amount, currency) {
  let digits = 2;
  // CNY amounts at or above one fen read like ordinary money. Keep extra
  // precision only below that boundary so a real cost never collapses to ¥0.00.
  if (currency !== 'CNY' || amount < 0.01) {
    if (amount < 0.001) digits = 6;
    else if (amount < 0.1) digits = 4;
    else if (amount < 1) digits = 3;
  }
  let text = amount.toFixed(digits);
  while (text.endsWith('0') && text.includes('.') && text.split('.')[1].length > 2) {
    text = text.slice(0, -1);
  }
  if (currency === 'USD') return `$${text}`;
  if (currency === 'CNY') return `¥${text}`;
  return `${currency} ${text}`;
}

function providerUsageFact(usage) {
  if (!usage || typeof usage.label !== 'string') return null;
  const label = sanitizeTerminalText(usage.label);
  if (usage.kind === 'cost') {
    if (
      usage.scope !== 'session'
      || !['USD', 'CNY'].includes(usage.currency)
      || typeof usage.amount !== 'number'
      || !Number.isFinite(usage.amount)
      || usage.amount <= 0
      || usage.estimated !== true
    ) {
      return null;
    }
    return {
      kind: 'cost', label,
      suffix: `Session Cost ≈${providerCostText(usage.amount, usage.currency)}`,
      stale: false,
    };
  }
  if (usage.kind !== 'balance' || !Array.isArray(usage.balances)) return null;
  let suffix;
  if (usage.available === false) {
    suffix = 'Balance unavailable';
  } else {
    const balance = usage.balances.find((item) => item.currency === 'CNY')
      || usage.balances.find((item) => item.currency === 'USD')
      || usage.balances[0];
    const amount = providerBalanceText(balance);
    if (!amount) return null;
    suffix = `Balance ${amount}`;
  }
  return {
    kind: 'balance', label, suffix,
    available: usage.available,
    stale: usage.stale === true,
  };
}

function providerUsageSegment({ providerUsage, color, C }) {
  const values = Array.isArray(providerUsage) ? providerUsage : [providerUsage];
  let facts = values.map(providerUsageFact).filter(Boolean);
  const costLabels = new Set(facts.filter((fact) => fact.kind === 'cost').map((fact) => fact.label));
  facts = facts.filter((fact) => !(
    fact.kind === 'balance'
    && fact.available === false
    && costLabels.has(fact.label)
  ));
  if (facts.length === 0) return null;

  let previousLabel = null;
  return facts.map((fact) => {
    const text = fact.label === previousLabel ? fact.suffix : `${fact.label} ${fact.suffix}`;
    previousLabel = fact.label;
    return fact.stale ? colorize(color, C.muted, text) : text;
  }).join(' · ');
}

// Each pure builder declares the minimum information tier at which it may
// appear. Builders still receive the actual tier for compact representations.
const SEGMENT_BUILDERS = [
  { minLayout: 'compact', build: modelSegment },
  { minLayout: 'compact', build: taskSegment },
  { minLayout: 'compact', build: projectSegment },
  { minLayout: 'compact', build: speedSegment },
  { minLayout: 'compact', build: cacheSegment },
  { minLayout: 'compact', build: providerUsageSegment },
  { minLayout: 'compact', build: quotaSegment },
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
 * normal -> compact when the line exceeds MAX_WIDTH visible chars.
 * @param {object} ctx
 * @param {object} ctx.payload stdin snapshot from the host
 * @param {object|null} ctx.quota parsed quota cache (without fetchedAt)
 * @param {object|object[]|null} ctx.providerUsage normalized provider facts
 * @param {object|null} ctx.metrics {tps, tpsStale, ttftMs, thinkingLevel, thinkingProvisional, goal, swarmMode, cache, tpsTotal, tpsAgents, activeAgents, mainSpeed, mainActive, turnStartedAt, compactingSince, compactionMs, tasks}
 * @param {boolean} ctx.gitDirty
 * @param {string} [ctx.layout] normal|compact
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
    const goal = goalBadge(ctx.metrics?.goal, color, C);
    if (goal) prefix.push(goal);
    const segs = buildSegments(layout, { ...ctx, payload, color, now, C });
    const line = [...prefix, segs.join(' │ ')].filter(Boolean).join(' ');
    if (stripAnsi(line).length <= MAX_WIDTH || layout === 'compact') return [line];
  }
  return [sanitizeTerminalText(payload.model || 'kimi')];
}
