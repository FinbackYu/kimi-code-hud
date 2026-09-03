#!/usr/bin/env node
/**
 * HUD 状态墙生成器
 * ────────────────
 * 把一组定义好的 HUD 状态（payload/metrics/quota/layout/theme）直接喂给真实的
 * src/render.mjs renderHud()，ANSI 转 HTML 后写入 docs/showcase/hud-states.js。
 * states-gallery.html 与 startup-page.html（轮播）都从这个文件取 HUD 行，
 * 因此 HUD 样式更新后只需重跑一次本脚本即可同步，永不漂移：
 *
 *   node docs/showcase/render-states.mjs
 *
 * 新增/调整状态：改下方 STATES 数组（每个状态一个 ctx，字段见 renderHud 的 JSDoc）。
 * 输出末尾会打印每行可见宽度；normal 超过 200 字符会自动降级为
 * compact，并让脚本以非零退出码报警。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHud } from '../../src/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'hud-states.js');

/** 固定时钟，保证每次生成的文案（~2h43m、gen 45s 等）完全一致。 */
const NOW = Date.parse('2026-08-01T09:30:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

/* ── 基础数据：各状态在此之上做最小覆盖 ── */

const basePayload = {
  model: 'K3',
  cwd: '/workspace/kimi-code-hud',
  gitBranch: 'main',
  contextTokens: 31457, // 3% of 1M
  maxContextTokens: 1048576,
  version: '0.5.0',
  permissionMode: 'manual',
};

const baseMetrics = {
  tps: 52,
  ttftMs: 10200,
  thinkingLevel: 'max',
  cache: { hitRate: 0.98, readTokens: 25088, inputTokens: 25600 },
};

const baseQuota = {
  windows: [{ label: '5h', used: 47, limit: 100, resetAt: iso(NOW + 2 * HOUR + 43 * MIN) }],
  weekly: { used: 41, limit: 100, resetAt: iso(NOW + 2 * DAY + 12 * HOUR) },
};

const ctx = (over = {}) => ({
  payload: { ...basePayload, ...(over.payload || {}) },
  metrics: over.metrics === null ? null : { ...baseMetrics, ...(over.metrics || {}) },
  quota: over.quota === null ? null : { ...baseQuota, ...(over.quota || {}) },
  gitDirty: over.gitDirty ?? false,
  layout: over.layout || 'normal',
  theme: over.theme || 'dark',
  color: true,
  now: NOW,
});

/* ── 状态清单：每行展示一个（或一组顺路的）维度，组内不重复 ── */

const STATES = [
  {
    id: 'startup',
    group: '基线',
    label: '启动页复刻行（states-gallery 的 line 1）',
    note: '首轮预热（不足 3 个有效样本）：provisional TPS 暗显 + TTFT；未确认 effort high 暗显；配额 47% / 87%',
    ctx: ctx({ metrics: { tps: 52, tpsStale: true, thinkingLevel: 'high', thinkingProvisional: true, cache: { hitRate: 0.98 } } }),
  },

  /* 权限与模式徽标 */
  {
    id: 'auto',
    group: '权限与模式徽标',
    label: '[Never Ask] 自动审批',
    note: '亮红徽标，permissionMode = auto',
    ctx: ctx({ payload: { permissionMode: 'auto' } }),
  },
  {
    id: 'yolo',
    group: '权限与模式徽标',
    label: '[Ask When Needed] 跳过全部确认',
    note: '琥珀徽标，permissionMode = yolo',
    ctx: ctx({ payload: { permissionMode: 'yolo' } }),
  },
  {
    id: 'plan',
    group: '权限与模式徽标',
    label: '[plan] 计划模式',
    note: '蓝色徽标，可与权限徽标叠加',
    ctx: ctx({ payload: { planMode: true } }),
  },
  {
    id: 'swarm',
    group: '权限与模式徽标',
    label: '[swarm] 子智能体聚合',
    note: '青色徽标；速度段聚合为 总t/s (N agents @均值)',
    ctx: ctx({ metrics: { swarmMode: true, tps: 52, tpsTotal: 156, tpsAgents: 3, activeAgents: 3, ttftMs: undefined } }),
  },
  {
    id: 'goal-active',
    group: '权限与模式徽标',
    label: '[goal] 目标进行中',
    note: 'goal 一词蓝色；轮次预算 3/10 turns（已用/上限）；回合进行中速度槽显示 gen 计时（分钟格式）',
    ctx: ctx({
      metrics: {
        goal: { status: 'active', turnsUsed: 3, turnBudget: 10 },
        turnStartedAt: NOW - 75_000,
      },
    }),
  },
  {
    id: 'goal-blocked',
    group: '权限与模式徽标',
    label: '[goal] 目标受阻',
    note: 'goal 一词琥珀色；无预算时显示累计轮次',
    ctx: ctx({
      metrics: {
        goal: { status: 'blocked', turnsUsed: 7 },
      },
    }),
  },
  {
    id: 'goal-paused',
    group: '权限与模式徽标',
    label: '[goal] 目标暂停',
    note: '整串暗灰；单数轮次显示 1 turn',
    ctx: ctx({
      metrics: {
        goal: { status: 'paused', turnsUsed: 1 },
      },
    }),
  },

  /* 速度槽位（互斥状态机：gen > compacting > compacted > TTFT） */
  {
    id: 'gen',
    group: '速度槽位',
    label: '生成中 · gen 45s',
    note: '回合进行时的实时计时；本行顺路展示脏工作区标记 git:(main*)',
    ctx: ctx({ metrics: { turnStartedAt: NOW - 45_000 }, gitDirty: true }),
  },
  {
    id: 'gen-cold',
    group: '速度槽位',
    label: '回合刚启动 · 尚无 tps',
    note: '没有 token 统计时速度槽只剩 ⚡ gen 计时；模型无 thinking 等级时只显示模型名',
    ctx: ctx({ metrics: { tps: undefined, ttftMs: undefined, thinkingLevel: undefined, turnStartedAt: NOW - 8_000 } }),
  },
  {
    id: 'stale',
    group: '速度槽位',
    label: '数据过期 · 整段变灰',
    note: 'tps/TTFT 是上一回合的遗留值，变灰提示已过期',
    ctx: ctx({ metrics: { tpsStale: true } }),
  },
  {
    id: 'compacting',
    group: '速度槽位',
    label: '压缩中 · compacting 12s',
    note: '手动 /compact 占用 TTFT 槽位，实时计时（v0.5.0）',
    ctx: ctx({ metrics: { ttftMs: undefined, compactingSince: NOW - 12_000 } }),
  },
  {
    id: 'compacted',
    group: '速度槽位',
    label: '压缩完成 · compacted 8s',
    note: '暗灰驻留，直到下一条 prompt 被 gen 取代（v0.5.0）',
    ctx: ctx({ metrics: { ttftMs: undefined, compactionMs: 8_000 } }),
  },

  /* 配额水位（条色随用量：绿 <60%，黄 60–85%，红 ≥85%） */
  {
    id: 'quota-warn',
    group: '配额水位',
    label: '5h 配额 72% · 黄条',
    note: '60–85% 区间配额条变黄',
    ctx: ctx({ quota: { windows: [{ label: '5h', used: 72, limit: 100, resetAt: iso(NOW + 58 * MIN) }] } }),
  },
  {
    id: 'quota-crit',
    group: '配额水位',
    label: '5h 配额 93% · 红条',
    note: '≥85% 配额条变红',
    ctx: ctx({
      quota: { windows: [{ label: '5h', used: 93, limit: 100, resetAt: iso(NOW + 21 * MIN) }] },
    }),
  },
  {
    id: 'quota-reset',
    group: '配额水位',
    label: '配额窗口已过期 · ~reset',
    note: 'resetAt 已过当前时间，倒计时显示 ~reset',
    ctx: ctx({ quota: { windows: [{ label: '5h', used: 3, limit: 100, resetAt: iso(NOW - MIN) }] } }),
  },

  /* 布局与主题 */
  {
    id: 'layout-normal',
    group: '布局与主题',
    label: 'normal 布局（默认）',
    note: '对比基线：去掉 Context 条、Cache token 明细与版本号；thinking 无等级时只显示 thinking',
    ctx: ctx({ metrics: { thinkingLevel: 'on' } }),
  },
  {
    id: 'layout-compact',
    group: '布局与主题',
    label: 'compact 布局 · 窄终端兜底',
    note: '行宽超 200 字符自动降级至此：配额与 Cache 无条/无明细、7d 周窗口不显示、模型只带等级词、项目段只剩 git 分支',
    ctx: ctx({ layout: 'compact' }),
  },
  {
    id: 'light-theme',
    group: '布局与主题',
    label: 'light 主题',
    note: '浅色终端整套配色切换：徽标加粗，琥珀 yolo / 蓝 plan / 黄条',
    ctx: ctx({
      theme: 'light',
      payload: { permissionMode: 'yolo', planMode: true },
      quota: { windows: [{ label: '5h', used: 72, limit: 100, resetAt: iso(NOW + 58 * MIN) }] },
    }),
  },
];

/* ── ANSI → HTML：本页即“终端”，ANSI 槽位映射到页面同款 Catppuccin 色 ── */

const ANSI_COLORS = {
  31: '#f38ba8', // red
  32: '#a6e3a1', // green
  33: '#f9e2af', // yellow
  90: '#888888', // bright black / muted
  91: '#ff7a85', // bright red
  93: '#ffe3ae', // bright yellow
};

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ansiToHtml(line) {
  let out = '';
  let color = null;
  let bold = false;
  let open = false;
  const closeSpan = () => {
    if (open) { out += '</span>'; open = false; }
  };
  const openSpan = () => {
    const style = [color ? `color:${color}` : '', bold ? 'font-weight:700' : '']
      .filter(Boolean).join(';');
    if (style) { out += `<span style="${style}">`; open = true; }
  };
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { out += escapeHtml(part); continue; }
    closeSpan();
    const codes = (m[1] === '' ? '0' : m[1]).split(';');
    if (codes[0] === '38' && codes[1] === '2' && codes.length === 5) {
      color = `rgb(${codes[2]},${codes[3]},${codes[4]})`;
    } else {
      for (const c of codes) {
        if (c === '0') { color = null; bold = false; }
        else if (c === '1') bold = true;
        else if (ANSI_COLORS[c]) color = ANSI_COLORS[c];
      }
    }
    openSpan();
  }
  closeSpan();
  return out;
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/* 终端字体把 ░ 渲染成实色暗块（见原截图），浏览器等宽字体却是点阵；
 * 换成压暗的 █，未填充段呈现实色暗条，与 CLI 中 HUD 的观感一致 */
const softenTrack = (html) =>
  html.replace(/░+/g, (m) => `<span style="opacity:.36">${'█'.repeat(m.length)}</span>`);

/* 终端把 ⚡ 渲染成彩色 emoji 图标，浏览器对裸 U+26A1 用文本呈现（字符样）；
 * 补 VS16（U+FE0F）强制 emoji 呈现，与 CLI 中 HUD 的彩色闪电图标一致 */
const emojiIcon = (html) => html.replace(/⚡/g, '⚡\uFE0F');

/* ── 生成 ── */

const toRow = ({ id, group, label, note, ctx: stateCtx }) => {
  const [line] = renderHud(stateCtx);
  const width = stripAnsi(line).length;
  const compactLine = stateCtx.layout === 'normal'
    ? renderHud({ ...stateCtx, layout: 'compact' })[0]
    : null;
  const downgraded = compactLine !== null && line === compactLine;
  return { id, group, label, note, width, downgraded, html: emojiIcon(softenTrack(ansiToHtml(line))) };
};

const rows = STATES.map(toRow);

/* states-gallery 状态示例堆叠专用徽标变体：共 5 行——yolo / auto 组各有一行
 * 用新官方称呼（[Ask When Needed] / [Never Ask]），其余三行经 permissionNames:
 * 'short' 覆盖保留旧短徽标（[yolo] / [auto]），两种措辞同图对照。
 * 以 原id@模式 为 id 追加生成，startup-page 轮播引用的原始状态不受影响；
 * 条目可写成 { id, ctx } 在徽标之外做额外覆盖（此处只给 gen 行换黄条配额） */
const GALLERY_BADGES = {
  yolo: [
    // 官方称呼行（组内第一）：gen 计时 + 脏工作区，顺路展示黄条（5h 72%）
    { id: 'gen', ctx: { quota: { windows: [{ label: '5h', used: 72, limit: 100, resetAt: iso(NOW + 58 * MIN) }] } } },
    // 短徽标行：唯一的红条（5h 93%）
    { id: 'quota-crit', ctx: { permissionNames: 'short' } },
  ],
  auto: [
    // 官方称呼行（组内第一）：[swarm] 徽标 + 舰队总速
    'swarm',
    // 短徽标行：compacted 状态 + 绿条
    { id: 'compacted', ctx: { permissionNames: 'short' } },
    // 短徽标行：[goal] 长徽标
    { id: 'goal-active', ctx: { permissionNames: 'short' } },
  ],
};
for (const [mode, items] of Object.entries(GALLERY_BADGES)) {
  for (const item of items) {
    const { id: baseId, ctx: extra = {} } = typeof item === 'string' ? { id: item } : item;
    const base = STATES.find((s) => s.id === baseId);
    rows.push(toRow({
      ...base,
      id: `${baseId}@${mode}`,
      ctx: {
        ...base.ctx,
        ...extra,
        payload: { ...base.ctx.payload, ...(extra.payload || {}), permissionMode: mode },
        quota: extra.quota ? { ...base.ctx.quota, ...extra.quota } : base.ctx.quota,
      },
    }));
  }
}

const banner = `/* 由 docs/showcase/render-states.mjs 生成 —— 请勿手改。
 * HUD 样式或状态变更后运行：node docs/showcase/render-states.mjs */`;
const body = `window.HUD_STATES = ${JSON.stringify(rows.map(({ width, downgraded, ...r }) => r), null, 2)};\n`;
writeFileSync(OUT, `${banner}\n${body}`);

console.log(`已生成 ${OUT}`);
let bad = 0;
for (const r of rows) {
  const flag = r.downgraded ? '  ⚠ normal 布局超 200 字符，已降级为 compact' : '';
  if (r.downgraded) bad += 1;
  console.log(`  ${r.id.padEnd(14)} ${String(r.width).padStart(3)} 字符${flag}`);
}
if (bad) process.exitCode = 1;
