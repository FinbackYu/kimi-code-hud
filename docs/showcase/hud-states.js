/* 由 docs/showcase/render-states.mjs 生成 —— 请勿手改。
 * HUD 样式或状态变更后运行：node docs/showcase/render-states.mjs */
window.HUD_STATES = [
  {
    "id": "startup",
    "group": "基线",
    "label": "启动页复刻行（states-gallery 的 line 1）",
    "note": "首轮预热（不足 3 个有效样本）：provisional TPS 暗显 + TTFT；未确认 effort high 暗显；配额 47% / 41%",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span><span style=\"color:#888888\">&nbsp;high</span>&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;<span style=\"color:#888888\">⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s</span>&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "auto",
    "group": "权限与模式徽标",
    "label": "[Never Ask] 自动审批",
    "note": "亮红徽标，permissionMode = auto",
    "html": "<span style=\"color:#ff7a85\">[Never&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "yolo",
    "group": "权限与模式徽标",
    "label": "[Ask When Needed] 跳过全部确认",
    "note": "琥珀徽标，permissionMode = yolo",
    "html": "<span style=\"color:rgb(232,168,56)\">[Ask&nbsp;When&nbsp;Needed]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "plan",
    "group": "权限与模式徽标",
    "label": "[plan] 计划模式",
    "note": "蓝色徽标，可与权限徽标叠加",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">[plan]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "swarm",
    "group": "权限与模式徽标",
    "label": "[swarm] 子智能体聚合",
    "note": "青色徽标；速度段聚合为 总t/s (N agents @均值)",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(91,192,190)\">[swarm]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;156&nbsp;t/s&nbsp;(3&nbsp;agents&nbsp;@52)&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "tower",
    "group": "权限与模式徽标",
    "label": "[tower] 多智能体编排",
    "note": "青色徽标，与 [swarm] 同槽位；wire tower_mode.enter/exit 驱动（v0.8.4），速度槽不做舰队聚合时维持原样",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(91,192,190)\">[tower]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "goal-active",
    "group": "权限与模式徽标",
    "label": "[goal] 目标进行中",
    "note": "goal 一词蓝色；轮次预算 3/10 turns（已用/上限）；回合进行中速度槽显示 gen 计时（分钟格式）",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;[<span style=\"color:rgb(79,168,255)\">goal</span>&nbsp;3/10&nbsp;turns]&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;gen&nbsp;1m15s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "goal-blocked",
    "group": "权限与模式徽标",
    "label": "[goal] 目标受阻",
    "note": "goal 一词琥珀色；无预算时显示累计轮次",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;[<span style=\"color:rgb(232,168,56)\">goal</span>&nbsp;7&nbsp;turns]&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "goal-paused",
    "group": "权限与模式徽标",
    "label": "[goal] 目标暂停",
    "note": "整串暗灰；单数轮次显示 1 turn",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:#888888\">[goal&nbsp;1&nbsp;turn]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "gen",
    "group": "速度槽位",
    "label": "生成中 · gen 45s",
    "note": "回合进行时的实时计时；本行顺路展示脏工作区标记 git:(main*)",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main*)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;gen&nbsp;45s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "gen-cold",
    "group": "速度槽位",
    "label": "回合刚启动 · 尚无 tps",
    "note": "没有 token 统计时速度槽只剩 ⚡ gen 计时；模型无 thinking 等级时只显示模型名",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;gen&nbsp;8s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "stale",
    "group": "速度槽位",
    "label": "数据过期 · 整段变灰",
    "note": "tps/TTFT 是上一回合的遗留值，变灰提示已过期",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;<span style=\"color:#888888\">⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s</span>&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "compacting",
    "group": "速度槽位",
    "label": "压缩中 · compacting 12s",
    "note": "手动 /compact 占用 TTFT 槽位，实时计时（v0.5.0）",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;compacting&nbsp;12s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "compacted",
    "group": "速度槽位",
    "label": "压缩完成 · compacted 8s",
    "note": "暗灰驻留，直到下一条 prompt 被 gen 取代（v0.5.0）",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s<span style=\"color:#888888\">&nbsp;·&nbsp;compacted&nbsp;8s</span>&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "quota-warn",
    "group": "配额水位",
    "label": "5h 配额 72% · 黄条",
    "note": "60–85% 区间配额条变黄",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#f9e2af\">███████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;</span>&nbsp;72%&nbsp;~58m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "quota-crit",
    "group": "配额水位",
    "label": "5h 配额 93% · 红条",
    "note": "≥85% 配额条变红；速度槽展示任务结束后的冻结 gen 总时长（muted 驻留，60s 亮窗已过）",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s<span style=\"color:#888888\">&nbsp;·&nbsp;gen&nbsp;5m32s</span>&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#f38ba8\">█████████</span><span style=\"background:rgb(68,68,68)\">&nbsp;</span>&nbsp;93%&nbsp;~21m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "quota-reset",
    "group": "配额水位",
    "label": "配额窗口已过期 · ~reset",
    "note": "resetAt 已过当前时间，倒计时显示 ~reset",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\"></span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;3%&nbsp;~reset&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "layout-normal",
    "group": "布局与主题",
    "label": "normal 布局（默认）",
    "note": "对比基线：去掉 Context 条、Cache token 明细与版本号；thinking 无等级时只显示 thinking",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;thinking&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "layout-compact",
    "group": "布局与主题",
    "label": "compact 布局 · 窄终端兜底",
    "note": "行宽超 200 字符自动降级至此：配额与 Cache 无条/无明细、7d 周窗口不显示、模型只带等级词、项目段只剩 git 分支",
    "html": "<span style=\"color:rgb(84,101,138)\">[Always&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;47%&nbsp;~2h43m"
  },
  {
    "id": "light-theme",
    "group": "布局与主题",
    "label": "light 主题",
    "note": "浅色终端整套配色切换：徽标加粗，琥珀 yolo / 蓝 plan / 黄条",
    "html": "<span style=\"font-weight:700\"></span><span style=\"color:rgb(217,119,6);font-weight:700\">[Ask&nbsp;When&nbsp;Needed]</span>&nbsp;<span style=\"font-weight:700\"></span><span style=\"color:rgb(21,101,192);font-weight:700\">[plan]</span>&nbsp;<span style=\"font-weight:700\"></span><span style=\"color:rgb(21,101,192);font-weight:700\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:rgb(217,119,6)\">███████</span><span style=\"background:rgb(198,198,198)\">&nbsp;&nbsp;&nbsp;</span>&nbsp;72%&nbsp;~58m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:rgb(14,122,56)\">████</span><span style=\"background:rgb(198,198,198)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "quota-crit@yolo",
    "group": "配额水位",
    "label": "5h 配额 93% · 红条",
    "note": "≥85% 配额条变红；速度槽展示任务结束后的冻结 gen 总时长（muted 驻留，60s 亮窗已过）",
    "html": "<span style=\"color:rgb(232,168,56)\">[yolo]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s<span style=\"color:#888888\">&nbsp;·&nbsp;gen&nbsp;5m32s</span>&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "compacted@yolo",
    "group": "速度槽位",
    "label": "压缩完成 · compacted 8s",
    "note": "暗灰驻留，直到下一条 prompt 被 gen 取代（v0.5.0）",
    "html": "<span style=\"color:rgb(232,168,56)\">[yolo]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s<span style=\"color:#888888\">&nbsp;·&nbsp;compacted&nbsp;8s</span>&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "tower@yolo",
    "group": "权限与模式徽标",
    "label": "[tower] 多智能体编排",
    "note": "青色徽标，与 [swarm] 同槽位；wire tower_mode.enter/exit 驱动（v0.8.4），速度槽不做舰队聚合时维持原样",
    "html": "<span style=\"color:rgb(232,168,56)\">[yolo]</span>&nbsp;<span style=\"color:rgb(91,192,190)\">[tower]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;TTFT&nbsp;10.2s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "gen@yolo",
    "group": "速度槽位",
    "label": "生成中 · gen 45s",
    "note": "回合进行时的实时计时；本行顺路展示脏工作区标记 git:(main*)",
    "html": "<span style=\"color:rgb(232,168,56)\">[Ask&nbsp;When&nbsp;Needed]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main*)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;gen&nbsp;45s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;47%&nbsp;~2h43m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "swarm@auto",
    "group": "权限与模式徽标",
    "label": "[swarm] 子智能体聚合",
    "note": "青色徽标；速度段聚合为 总t/s (N agents @均值)",
    "html": "<span style=\"color:#ff7a85\">[Never&nbsp;Ask]</span>&nbsp;<span style=\"color:rgb(91,192,190)\">[swarm]</span>&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;156&nbsp;t/s&nbsp;(3&nbsp;agents&nbsp;@52)&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#f9e2af\">███████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;</span>&nbsp;72%&nbsp;~58m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  },
  {
    "id": "goal-active@auto",
    "group": "权限与模式徽标",
    "label": "[goal] 目标进行中",
    "note": "goal 一词蓝色；轮次预算 3/10 turns（已用/上限）；回合进行中速度槽显示 gen 计时（分钟格式）",
    "html": "<span style=\"color:#ff7a85\">[auto]</span>&nbsp;[<span style=\"color:rgb(79,168,255)\">goal</span>&nbsp;3/10&nbsp;turns]&nbsp;<span style=\"color:rgb(79,168,255)\">K3</span>&nbsp;max&nbsp;│&nbsp;kimi-code-hud&nbsp;git:(main)&nbsp;│&nbsp;⚡️&nbsp;52&nbsp;t/s&nbsp;·&nbsp;gen&nbsp;1m15s&nbsp;│&nbsp;Cache&nbsp;98%&nbsp;│&nbsp;5h&nbsp;<span style=\"color:#f38ba8\">█████████</span><span style=\"background:rgb(68,68,68)\">&nbsp;</span>&nbsp;93%&nbsp;~21m&nbsp;·&nbsp;7d&nbsp;<span style=\"color:#a6e3a1\">████</span><span style=\"background:rgb(68,68,68)\">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>&nbsp;41%&nbsp;~2d12h"
  }
];
