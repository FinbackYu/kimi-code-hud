---
name: upstream-release-review
description: 审查一个新发布或指定的 stable Kimi Code release 对 kimi-code-hud 的兼容性——锁定 release 事实、比较精确 range、审查 HUD 依赖的契约面与用户可见文案 parity、前移 CAPABILITIES/KNOWN_ISSUES 基线、修复消费者问题。当用户说"审查上游新版本"、"kimi-code X.Y.Z 兼容性"、"前移基线"、"upstream release review"时使用。发布走 release skill；本 skill 保持上游 checkout 只读。
---

# Upstream Release Review（kimi-code-hud）

把未经修改的官方 stable release 当作输入，验证 HUD 的兼容性并前移本仓基线证据。上游 `MoonshotAI/kimi-code` 是外部只读事实源：只读取实现、协议、文档与测试；不修改、不 merge、不 patch。

## 与其他 skill 的分工

- 监测报警投递的 issue 锚定的工作（prep/fix/observe 分类、分支策略、验收合并）→ 本仓 `AGENTS.md`「Issue Workflow」的规则。
- 版本位、CHANGELOG、showcase 重生成、tag、GitHub Release → `release`。
- 本 skill 覆盖「release 事实 → 影响审查 → 基线前移 → 修复验证」，产物是本仓的兼容性证据与代码。

## 开始前

1. 完整读取本仓 `AGENTS.md`。
2. `git status --short -uall` 确认工作树状态，保留既有 dirty 内容。
3. 从 `CAPABILITIES.md` 头部读当前基线：`Kimi Code baseline`（previous）与 `HUD behavior baseline`。

## 工作流

### 1. 锁定 release 事实

- 完整 tag 名来自官方 Release 元数据或实际 tag 列表，不按版本号拼接 `vX.Y.Z`。
- 记录：tag 类型、peeled commit、previous 是否 target 祖先、`previous..target` 提交数与 changed paths。
- 用 `git show '<target>:<path>'` / `git grep <pattern> <commit>` 读 target 源码，保持纯只读；不得 fetch、checkout、merge、patch 上游仓（`git ls-remote` 等不写本地对象的远端只读查询可用）；target 对象本地缺失时停下请用户更新 checkout，不得代为执行。

### 2. 比较精确 range 并收集必审输入

- `git rev-list --count`、`git diff --name-only` / `--stat`，release notes 与实际路径核对。
- 结论范围不超过证据范围：「X 变了」凭单次命中成立；「未变」「未触及」「零命中」先把 range 文件清单完整落盘，用 `grep -q` 或 API `--jq` 精确查询做机器判定，并留验证命令。
- 呈现层内容单独成清单：显示名映射表（如权限模式显示表）、footer 文案与 tips、slash 命令注册表（主名与别名）、默认值提示。payload/config 里的 stable id 不变不等于无变化。
- `gh issue list -R FinbackYu/kimi-code-hud --label upstream-watch` 检查有无沉没的待办（显式 `-R`：在 fork clone 中缺省会查到自己的 fork）；用户另行提供的上游监测 WATCH 条目一并列为必审输入，每条必须有结论（已覆盖 / 转跟进物 / 明确关闭）。

### 3. 审查 HUD 依赖面

逐项写清「定义方 → HUD 消费入口 → 字段/路径 → 稳定等级 → 失败降级 → 证据」：

- status line：`status_line.command` payload 字段、可空性和命名；stdout 行数、字节上限、host timeout；命令失败、空输出、超时、malformed 输出的 fallback。
- footer：line 1/line 2 与 transient hint 所有权；width、fullscreen、experimental TUI 是否实际进入 stable；Git branch/status 的来源、调用频率和信任边界。
- wire：`wire-manifest.d.ts` 记录增删改名、transient/persisted 变化；HUD reducers 消费的 `turn.*`/`step.end`/task 事件与 sidecar schema；session 目录命名、rotation、legacy 布局。
- plugin 与 host config：manifest、SessionStart hook、安装/卸载/hook 修复路径；`config.toml`/`tui.toml` 的 `[status_line]` 契约。
- quota/provider：managed subscription quota 读取面、credentials 边界（HUD 不落 token）；不把本地估算当官方 API 余额。
- 热路径与安全：`300ms host / 220ms internal` 预算不得回退；OSC/CSI/ESC/C0/DEL/C1 动态文本防护；缓存原子、限额、并发安全、失败静默。

### 4. 显示内容 parity（用户可见文案）

- 从 range diff 提取全部被替换旧词——旧显示名、旧命令名、旧默认值提示——形成旧词清单。
- 对每个旧词在本仓 `README.md`、`README.en.md`、`CAPABILITIES.md`、`KNOWN_ISSUES.md`、`CHANGELOG.md`、fixtures 和源码字符串中全文检索。
- 检索命中 = 具体跟进物：逐条给出 parity 决策（跟随官方新称 / 保留旧称 / 做成可配置），进 findings；未命中也要留证（检索了哪些文件、哪些关键词、命中 0）。
- HUD 自绘显示值（权限徽章文案等）逐值对账官方显示表；stable id 与显示值分开记录，不得互相推断。

### 5. 结论分级

- P0：不可用、安全、数据破坏、严重错误归因；P1：行为错误、热路径失稳、门禁假绿；P2：低频边界、测试/文档缺口；证据不足写「无法判断」。
- 状态用 covered / variant / degraded / missing / readable-but-unrendered / host-owned。additive 字段不是 bug，「测试没失败」不等于「契约没变化」。

### 6. 前移基线（需用户授权修改）

- `CAPABILITIES.md` + `KNOWN_ISSUES.md`：`Last verified` 与 `Kimi Code baseline` 两处一致；pinned 上游链接换到 target peeled commit，防止上游 main 漂移污染基线；保留「可读取但不渲染」「实验性」「人工验证缺口」边界。
- `README.md` + `README.en.md` 双语同步用户可见变化；showcase 页面的 `CLI_VERSION` 只在基线变更时动（`HUD_VERSION` 归 release skill）。
- 为每个行为变化补正向 fixture 和至少一个能使旧实现失败的反例（未知字段、malformed 输出、超时、空输入）。

### 7. 修复与验证

- 消费者修复遵循 `AGENTS.md`「Issue Workflow」的分支与验证规范；对未发布上游契约的实现必须对当前已发布版本惰性。
- 门禁：`npm test` 全绿、改动文件逐个 `node --check`、`git diff --check`。不安装依赖、不写真实用户配置、不为「确认」而写缓存。

## 交付格式

1. previous → target、tag 类型/peeled commit、提交数与审查日期；
2. 契约与呈现层变化摘要（含旧词清单与检索留证）；
3. HUD 影响矩阵与 P0/P1/P2/无法判断；
4. 基线前移与已写入内容；已验证 / 未验证 / 无关既有问题；
5. 明确声明上游 checkout 保持未修改。

## 不可突破的边界

- 不用 patched upstream 验证兼容性；不把 `main` 或 PR 状态当成已发布 release。
- 不把失败/未授权来源解释成零、空或无变化。
- commit、推送、合并 main 需用户明确授权；发布只走 `release` skill。
- 不把上游监测的 WATCH 条目原样留到下一轮。
