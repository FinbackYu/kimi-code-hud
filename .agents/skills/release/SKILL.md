---
name: release
description: 在 kimi-code-hud 仓库执行一次完整发布——版本位判断、版本号双文件提升、CHANGELOG 落盘与链接前移、showcase 图片重生成与读回核验、测试门禁、release commit、tag、推送、gh release create。当用户说"发布 kimi-code-hud"、"发版"、"做一次发布"、"release"/"cut a release vX.Y.Z"时使用。仅适用于 kimi-code-hud 仓库。
---

# Release（kimi-code-hud）

发布不是「打个 tag」：缺了 GitHub Release，CHANGELOG 底部 tag 链接 404、README 的 shields 徽章停在旧版。本 skill 把全流程固化为按序清单，执行时不要跳步。

## 事实源（先读，不要凭记忆）

- HUD 版本：`kimi.plugin.json` 与 `package.json` 的 `version`，两处必须一致（`test/release-metadata.test.mjs` 强制）。
- 兼容性元数据：`CAPABILITIES.md` 与 `KNOWN_ISSUES.md` 的 `Last verified`、`HUD behavior baseline`、`Kimi Code baseline`，两份必须一致；Kimi Code 基线以 `CAPABILITIES.md` 为发布正文事实源。
- 仓库级发布硬性要求：`AGENTS.md`「Commit & Pull Request Guidelines」末条。
- release 正文格式先例：`gh release view <上一版> --json body`。

## 版本位判断

0.x 阶段惯例：`Fixed` / `Changed` 都走 patch（0.7.3→0.7.6 均如此）；只有破坏性行为变更或用户明确要求时才谈 minor。拿不准问用户，不要猜。

## 执行序列

1. **起点检查**：`git status` 干净或只含待发布改动；过一遍自上一 tag 起的 `git log`，确认 CHANGELOG `[Unreleased]` 已覆盖全部用户可见改动；确认 `CAPABILITIES.md` / `KNOWN_ISSUES.md` 已包含本次基线与行为变化，没有把候选 upstream 写成 stable 事实。
2. **版本提升**：
   - `package.json` + `kimi.plugin.json` → 新版本。
   - `CAPABILITIES.md` + `KNOWN_ISSUES.md`：同步 `Last verified`；把 `HUD behavior baseline` 更新为新版本和本次 release 中最后一个相关行为提交；清除已发布项的 working-tree / pending-release 临时说明，并把 closed issue 写成实际首次修复版本。两份文档的 Kimi Code baseline 必须保持一致。
   - `CHANGELOG.md`：`[Unreleased]` 内容落入 `## [X.Y.Z] - <今天 YYYY-MM-DD>`，保留空的 `[Unreleased]` 段；底部链接块前移——`[Unreleased]: .../compare/v<X.Y.Z>...HEAD`，并新增 `[X.Y.Z]: .../releases/tag/v<X.Y.Z>`。
   - `docs/showcase/states-gallery.html` 与 `startup-page.html` 的 `const HUD_VERSION`（两页面是必要的受跟踪生成源，release-metadata 测试会断言；`CLI_VERSION` 只在基线变更时才动）。
3. **图片重生成**（需本机 python3 playwright + Chrome）：

   ```bash
   node docs/showcase/render-states.mjs && python3 docs/showcase/export-assets.py
   ```

4. **读回核验（不能省）**：用读图工具查看 `docs/media/hud-states.png` 与 `docs/media/hud-demo.png`：
   - 标题栏 = `Kimi Code Hud <新版本>`；
   - 欢迎框 `Version:` = CAPABILITIES 基线；
   - 顺带核对内容保真：HUD 行展示是否与当前渲染行为一致（如 startup 行应有暗显 provisional TPS、effort 未确认应置灰）。发现漂移见「已知坑」。
   - 两个 PNG 的 `Author` 元数据 = `FinbackYu`；必须用元数据读取工具读回确认，不能只假定导出脚本已写入。
5. **门禁**：先运行 `KIMI_HUD_RELEASE_CHECK=1 node --test test/release-metadata.test.mjs`，再确认 `npm test` 全绿 + `git diff --check`。仓内门禁会验证 behavior commit 可达对应 release tag；新版本 tag 尚未创建时以当前 HEAD 作为 release candidate，并在第 9 步 tag 创建后重新跑同一检查、落定到精确 tag。严格 metadata 检查还会阻止两份文档版本不一致、HUD behavior baseline 未前移或 closed issue 区块仍写 working-tree / pending-release（含连字符和跨行写法）。
6. **提交**：`chore: release vX.Y.Z`，只含发布元数据、受跟踪生成源与产物：`package.json`、`kimi.plugin.json`、`CHANGELOG.md`、必要的 `docs/showcase/` 生成源、`docs/media/*.png`，以及本次需要收口发布状态时的 `CAPABILITIES.md` / `KNOWN_ISSUES.md`。
7. **打 tag 并推送**：`git tag vX.Y.Z`，推送 main 与 tag。
8. **创建 GitHub Release（史上最易漏的一步）**：

   ```bash
   gh release create vX.Y.Z --title vX.Y.Z --notes "<CHANGELOG 本节正文>

   Compatibility baseline: Kimi Code <基线> (unchanged from v<首次引入该基线的版本>)."
   ```

9. **收尾确认**：`gh release list` 显示新版为 Latest。README 版本徽章是 shields 动态徽章（`github/v/release`），无需改 README，CDN 缓存几分钟内自动刷新；向用户报告时附 release URL。
   再运行一次 `KIMI_HUD_RELEASE_CHECK=1 node --test test/release-metadata.test.mjs`，确保 tag/Release 完成后没有遗留临时兼容性状态。

## 授权边界

commit / tag / push / `gh release create` 均为对外动作，执行前需用户明确授权；用户说「做一次发布」视为对全流程的一次性授权。

## 已知坑

- `docs/showcase/` 的生成脚本与两个 HTML 页面是必要的受跟踪生成源，`docs/media/*.png` 是受跟踪发布产物；生成的 `hud-states.js` 与私有/社媒产物（如 `xhs/`）继续 gitignore。
- release-metadata 测试会校验两个 showcase 页面中的版本常量；升版本忘同步页面会直接失败。
- `hud-demo.png` 的静态首帧来自 `startup-page.html` 里手维护的 CONFIG 复刻，不经过 `render-states.mjs`。发布读图时必须同时核对 provisional TPS 与未确认 effort 的暗显；发现漂移就修 CONFIG 重出图，不把手写首帧当成真实渲染的自动产物。
