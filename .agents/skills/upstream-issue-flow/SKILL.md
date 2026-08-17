---
name: upstream-issue-flow
description: 处理 kimi-code-hud 仓库 GitHub issue 的完整工作流——从读 issue、按上游发布状态分类（发布前准备 vs 当下修复）、分支隔离、实现与验证，到 issue 进度同步、发布后验收合并、关闭与 worklog。当用户说"看一下/处理 kimi-code-hud 的 issue"、"跟进上游变化"、"跑一下 issue #N"、"处理监测报警"时使用。本 skill 只覆盖本仓库的 issue 处理规范，不覆盖上游监测本身（那是 Repo-Overwatch 的职责）。
---

# Upstream Issue Flow

kimi-code-hud 的代码改动以 issue 为锚点。本 skill 定义「读 issue → 分类 → 分支 → 实现 → 验证 → 同步 → 合并/关闭 → worklog」全流程规范；部分约定参照上游 MoonshotAI/kimi-code 的 CONTRIBUTING，但按单人仓库的实际精简过。

## 第零步：是否需要 issue

单人仓库，门槛从简：

- 监测报警投递的 issue 直接用作锚点；用户在对话中提出的需求视为已完成讨论，不必补开 issue（需要跨会话跟踪时再开）。
- agent 自主发现的改动（非用户要求、非微小修复）先开 issue 说清动机再动手，避免无上下文的 drive-by 改动。

## 生态背景

- Issue 主要来自 Repo-Overwatch 的 `kimi-code-watch` 监测工作流（每 6 小时），特征：`upstream-watch` + `kimi-code` label、标题含上游 PR 号、body 末尾有 `<!-- gh-aw-workflow-id: kimi-code-watch -->`、「建议操作」是 checkbox 清单。
- 监测 issue 的分级在「结论」行：**WATCH**（无破坏，观察/准备）、**P2**（有增量需跟进）、**P1**（破坏当前用户，立即修复）。
- 监测器按「标题中的上游 PR 号」去重，并按 body 中的结构续写。**body 和标题归监测器所有，人工与 agent 只通过评论互动**（见「监测 issue 卫生」）。

## 第一步：读取与分类

1. `gh issue view <N> -R FinbackYu/kimi-code-hud`，同时 `gh issue list --label upstream-watch` 看是否有相关 issue 可合并处理。
2. 按**上游发布状态**分类，决定后续路径：

| 情形 | 模式 | 去向 |
| --- | --- | --- |
| 上游变化未发布（候选 changelog / 已 merge 未 release） | **prep（发布前准备）** | `upstream/<version>-prep` 分支 |
| 上游已发布且影响 HUD 当前用户（P1） | **fix（当下修复）** | `fix/<N>-<slug>` 短分支，验完即合 |
| 无代码需求（纯观察/文档/结论） | **observe** | 评论记录结论，保持 open 或关闭 |

拿不准分类时问用户，不要猜。

## 第二步：分支策略（硬性）

- **prep 工作永远不进 main**。一个上游版本共用一个分支 `upstream/<version>-prep`（如 `upstream/0.37.0-prep`），该版本的多个 issue 在同一分支上累积。
- fix 工作用短分支 `fix/<issue-N>-<slug>`（或 `feat/<N>-<slug>`），验证通过后尽快合并，不过夜。
- 例外：与任何上游变化无关的仓库自身琐事（typo、CI、文档）按仓库既有习惯可直接进 main。
- 合并 prep 分支的唯一闸门：**上游正式发布 + 本地按 issue checklist 实测通过**，两者缺一不可。

## 第三步：实现

- 把 issue「建议操作」的 checklist 转成 TodoList 逐项推进。
- 代码风格、测试基建、提交约定一律以仓库根 `AGENTS.md` 为准（`node:test`、2 空格缩进、imperative commit subject、一个 commit 一个行为）。
- 改动面大时用 swarm 拆分并行：按文件所有权切分避免冲突，每个子代理只跑自己的测试文件，全套测试由协调者最后统一跑。
- 针对未发布上游契约写代码时：新行为必须对当前已发布版本**惰性**（无对应 wire 记录/payload 字段时零行为变化），并用 fixture 回归测试锁定。
- **行为变更在同一改动内同步文档**：`README.md` + `README.en.md` 双语同步；涉及兼容性/已知限制时同步 `CAPABILITIES.md` / `KNOWN_ISSUES.md`（对齐上游「docs in the same PR」要求）。
- **能解释才合入**（对齐上游对 AI 辅助贡献的标准）：提交前必须能说明每处改动改了什么、边界行为如何、为什么适合本仓库；解释不了的改动不提交。

## 第四步：验证门槛（提交前必须全绿）

```bash
npm test                 # 全套 node:test
node --check <改动的.mjs> # 逐个语法检查
git diff --check         # 无空白错误
```

## 第五步：提交与推送

- Conventional Commits 前缀（`feat:`/`fix:`/`docs:`，沿用仓库既有习惯）；scope 建议带但不强制（如 `fix(metrics): ...`）。body 引用 `#N` 关联 issue。
- 合并 prep/fix 分支的 commit message 写清三要素：关联 issue（`Closes #N`）、用户可见变化、验证命令与结果——发布日回溯全靠它。
- 提交推送前确认在正确的分支上（prep/fix），推完 `git checkout main` 保持本地工作区停在干净的 main。
- 推送前征得用户同意；合并 main 必须用户明确指示。

## 第六步：issue 进度同步

监测 issue 的进度**只通过评论**同步，按节点评论：

1. **开工**：一句话认领 + 分类结论（prep/fix/observe）+ 计划分支名。
2. **完成时**：复制 issue 的 checklist，已完成项打 `[x]`，附改动摘要（文件、测试数）、分支指针（`[\`branch\`](url)`，commit hash）、剩余 gate。
3. **验收合并后**：`gh issue close <N>` 并附验证结果；或在合并 commit message 中用 `Closes #N`。

## 第七步：发布日验收（prep 的收尾）

上游版本发布后（监测工作流会报警，或用户告知；上游用 changesets 管理发布——head 分支固定为 `changeset-release/main` 的 release PR 被合并即等于 npm 发布，这是可靠的发布信号）：

1. `git checkout upstream/<version>-prep`，确认基于最新 main（必要时 rebase/merge main）。
2. 逐条执行各 issue 评论中留下的实测 checklist（真实安装新版本、真实触发新功能、对照预期行为）。
3. 全部通过 → 合并 main → 推送 → 关闭相关 issue → 删除已合并分支（本地+远端）。
4. 任一不通过 → 在分支上修复后重验；若上游契约已漂移，在 issue 评论记录差异并更新实现。

## 第八步：worklog

每个有意义的工作段结束，按 `creating-worklogs` skill 记项目 worklog 到 `worklog/YYYY-MM/`，一个工作段一篇、不追加旧篇。issue 编号写进 worklog 正文便于回溯。

## 反模式（不要做）

- 不要把未发布上游契约的实现代码合进 main。
- 不要编辑监测 issue 的标题或 body（破坏监测器去重与续写）；进度只发评论。
- 不要在测试未全绿时提交。
- 不要关闭 checklist 尚有未完成项的 prep issue（除非经用户确认降级为 won't-do）。
- 不要跨版本共用一个 prep 分支（0.37.0 的 prep 不混进 0.38.0）。
