# kimi-code-hud

自定义底部状态栏（HUD）for [Kimi Code CLI](https://www.kimi.com/) — 零依赖 Node.js 脚本，在终端 TUI 底部显示模型、Git 分支、上下文用量、生成速度（TPS/TTFT）与 API 配额。

A zero-dependency custom status line (HUD) for **Kimi Code CLI** — shows model, git branch, context usage, generation speed (TPS/TTFT) and API quota in the TUI footer.

<!-- 效果截图占位 / screenshot placeholder -->
<!-- ![screenshot](docs/screenshot.png) -->

```
K3 thinking:high │ kimi-code-hud git:(main*) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ↻2h18m │ wk ██░░░░░░░░ 25%
```

---

## 中文

### 安装

要求 Node.js ≥ 18（用到全局 `fetch`），无 npm 依赖。

**方式一：作为 Kimi Code 插件安装（推荐，方便开关）**

在 Kimi Code TUI 中运行：

```
/plugins install https://github.com/FinbackYu/kimi-code-hud
```

- 安装后**重启或开新会话**生效：插件声明的 `SessionStart` hook 会把 `tui.toml` 的 `[status_line]` 指向插件托管副本（`~/.kimi-code/plugins/managed/kimi-code-hud/`），并在每次会话启动时自动修复该条目；
- 开关：在 `/plugins` 面板选中后按 `Space`，或运行 `/plugins disable kimi-code-hud` / `/plugins enable kimi-code-hud`。禁用或移除后，状态栏在下次刷新（约 1 秒内）自动回退为内置布局；
- 如果你已经在 `[status_line]` 配置了自己的其他命令，hook 不会覆盖它。

**方式二：手动安装（git checkout）**

```bash
git clone https://github.com/FinbackYu/kimi-code-hud ~/kimi-code-hud
node ~/kimi-code-hud/bin/kimi-hud.mjs --install
```

`--install` 会先备份 `~/.kimi-code/tui.toml` 为 `tui.toml.<时间戳>.bak`，再在 `[status_line]` 段写入 `command = "node <绝对路径>"`（幂等，已有 `items` 会保留）。**重启 Kimi Code 或运行 `/reload-tui` 生效。**

> 两种方式不要混用：插件启用期间，hook 会把 `tui.toml` 指向托管副本。想回到手动安装，先 `/plugins remove kimi-code-hud`，再重新 `--install`。

### 卸载

插件方式安装：`/plugins remove kimi-code-hud`（按官方行为托管副本仍留在磁盘上，但安装记录已删除，状态栏会立即回退内置布局）。

手动方式安装：

```bash
node ~/kimi-code-hud/bin/kimi-hud.mjs --uninstall
```

同样先备份，然后移除 `[status_line]` 中本工具的 `command` 行。

### 配置

- `~/.kimi-code-hud/config.json`：`{"layout":"compact"|"normal"|"full"}`（默认 `normal`）
- 环境变量 `KIMI_HUD_LAYOUT` 优先于配置文件
- `NO_COLOR` 或 `KIMI_HUD_NO_COLOR`：禁用全部 ANSI 颜色

三档布局：

```
compact: K3 │ git:(main*) │ Context ██████░░░░ 62% (159K/256K) │ ⚡ 47 │ 5h ███░░░░░░░ 31%
normal:  K3 thinking:high │ kimi-code-hud git:(main*) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ↻2h18m │ wk ██░░░░░░░░ 25%
full:    K3 thinking:high │ kimi-code-hud git:(main*) │ Context ██████░░░░ 62% (159K/256K) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ↻2h18m │ wk ██░░░░░░░░ 25% ↻3d2h │ v0.31.0
```

- 模型后缀显示 thinking 状态：布尔模型为 ` thinking`，支持 effort 的模型为 ` thinking:<effort>`（status line payload 不含此字段；优先取会话日志 `config.update` 事件——新版宿主键为 `thinkingEffort`，会话启动即有初始记录；旧版为 `thinkingLevel`，只在会话内切换过 effort 时记录。两者都没有时按会话快照固定取值，快照存 `~/.kimi-code-hud/thinking-<sessionId>.json`；快照不存在时才回退解析 `~/.kimi-code/config.toml` 的 `[thinking]` 与模型表并写入快照——这样其他会话执行 `/effort` 改写全局配置后，本会话显示不会跟着变）；compact 档省略后缀；
- normal 档不含 Context 段（宿主第二行已有精确数值），compact/full 档保留柱+百分比+token 数；
- 行首徽章与权限模式对齐：`[yolo]`（琥珀黄，对齐宿主默认）/`[auto]`（亮红，便于区分）/`[manual]`（暗灰占位，保持行首对齐），plan 模式加 `[plan]`（蓝色）；`[swarm]`（青色）已实现，但当前宿主 status line payload 尚未携带 `swarmMode` 字段，上游补齐后自动生效；
- 柱条按用量分级着色：<60% 绿、<85% 黄、≥85% 红；
- 输出超过 200 字符自动降级 full→normal→compact。

### 原理

Kimi Code 的 `~/.kimi-code/tui.toml` 支持 `[status_line]` 自定义命令：

- 每次刷新（每秒最多一次）宿主通过 stdin 传入一个 JSON 快照（model、cwd、gitBranch、permissionMode、planMode、contextTokens 等字段）；
- 命令 stdout 的**第一行**接管底部 Footer 第一行（第二行固定由宿主绘制 `context: N%`，插件无法接管）；
- 命令须在 **300ms** 内完成，失败/超时/空输出时宿主静默回退内置布局——所以本脚本对所有错误静默降级、绝不打印日志；唯一的非零退出是有意为之：当脚本是"已禁用/已移除插件的托管副本"时，非零退出让宿主回退内置布局（插件开关即由此实现）。

三段数据来源：

| 段 | 来源 |
|---|---|
| 模型 / 分支 / Context | stdin 快照 + `git status --porcelain`（150ms 超时） |
| TPS / TTFT | 增量解析 `~/.kimi-code/sessions/*/session_<id>/agents/main/wire.jsonl`（旧版为 `ses_<id>`，两者都兼容）的 `step.end` 事件（byte offset 存 `~/.kimi-code-hud/metrics-<sessionId>.json`，每秒只读新增字节） |
| 配额（5h/wk） | `GET https://api.kimi.com/coding/v1/usages`，60 秒 TTL 缓存于 `~/.kimi-code-hud/quota.json`，过期时热路径用过期缓存渲染并 spawn 后台刷新，绝不阻塞 |

### 隐私与安全

access token 仅从 `~/.kimi-code/credentials/kimi-code.json` **本地读取**（Kimi Code CLI 自己负责续期，本工具只读不写），仅用于请求官方 `api.kimi.com` 配额接口，不写入任何日志、缓存或输出。

### FAQ

**状态栏没变化？** 确认 `/reload-tui` 或重启过；确认 `node <path>` 直接 `echo '{}' | node bin/kimi-hud.mjs` 有输出。

**没有 TPS/TTFT 段？** 新会话还没有 `step.end` 样本；第一次运行只建立读取 offset，之后出现。

**没有配额段？** 缓存首次生成前整段省略（不显示"加载中"）。可手动 `node bin/kimi-hud.mjs --refresh-quota` 后重试；该命令静默执行，检查 `~/.kimi-code-hud/quota.json` 是否生成。

**Context 段在哪些档显示？** compact/full 档自带柱、百分比和 token 数；normal 档不显示，直接看宿主第二行的 `context: N% (tokens/max)`（该行永远由宿主绘制，插件无法接管）。

---

## English

### Install

Requires Node.js ≥ 18 (global `fetch`). Zero npm dependencies.

**Option 1: install as a Kimi Code plugin (recommended, easy on/off)**

In the Kimi Code TUI, run:

```
/plugins install https://github.com/FinbackYu/kimi-code-hud
```

- **Restart or start a new session** to activate: the plugin's `SessionStart` hook points `tui.toml`'s `[status_line]` at the plugin's managed copy (`~/.kimi-code/plugins/managed/kimi-code-hud/`) and repairs that entry on every session start;
- Toggle: select it in the `/plugins` panel and press `Space`, or run `/plugins disable kimi-code-hud` / `/plugins enable kimi-code-hud`. After disabling or removing, the status line falls back to the built-in layout on the next refresh (within ~1s);
- If you already configured your own `[status_line]` command, the hook leaves it untouched.

**Option 2: manual install (git checkout)**

```bash
git clone https://github.com/FinbackYu/kimi-code-hud ~/kimi-code-hud
node ~/kimi-code-hud/bin/kimi-hud.mjs --install
```

`--install` backs up `~/.kimi-code/tui.toml` to `tui.toml.<timestamp>.bak`, then writes `command = "node <abs path>"` into `[status_line]` (idempotent; existing `items` are preserved). **Restart Kimi Code or run `/reload-tui` to apply.**

> Do not mix the two: while the plugin is enabled, its hook points `tui.toml` at the managed copy. To go back to a manual install, `/plugins remove kimi-code-hud` first, then re-run `--install`.

### Uninstall

Plugin install: `/plugins remove kimi-code-hud` (per upstream behavior the managed copy stays on disk, but with the install record gone the status line falls back to the built-in layout immediately).

Manual install:

```bash
node ~/kimi-code-hud/bin/kimi-hud.mjs --uninstall
```

Backs up first, then removes this tool's `command` line from `[status_line]`.

### Configuration

- `~/.kimi-code-hud/config.json`: `{"layout":"compact"|"normal"|"full"}` (default `normal`)
- `KIMI_HUD_LAYOUT` env var overrides the config file
- `NO_COLOR` or `KIMI_HUD_NO_COLOR`: disable all ANSI colors

The model suffix shows thinking state: ` thinking` for boolean models, ` thinking:<effort>` for effort-capable ones (the status-line payload does not carry it; prefer `config.update` events from the session log — new hosts write `thinkingEffort`, including an initial event at session start, older hosts wrote `thinkingLevel` only after an in-session change. When neither exists, pin the value per session in `~/.kimi-code-hud/thinking-<sessionId>.json`; only when no snapshot exists does it fall back to the `[thinking]` and model tables in `~/.kimi-code/config.toml` and write the snapshot — so another session running `/effort`, which rewrites the global config, no longer changes what this session shows); compact omits the suffix. The normal layout drops the Context segment (the host's line 2 already shows the exact numbers); compact/full keep bar + percentage + token counts. See the layout table above. Badges `[yolo]` (amber, matching the host default), `[auto]` (bright red, for contrast), `[manual]` (muted gray placeholder that keeps the left edge aligned) and `[plan]` (blue) appear at the line start; `[swarm]` (cyan) is implemented but the host status-line payload does not expose `swarmMode` yet — it activates automatically once upstream adds it. Bars are colored by usage (<60% green, <85% yellow, ≥85% red); lines longer than 200 chars automatically degrade full→normal→compact.

### How it works

Kimi Code's `~/.kimi-code/tui.toml` accepts a `[status_line]` custom command:

- On each refresh (at most once per second) the host pipes a JSON snapshot to stdin (`model`, `cwd`, `gitBranch`, `permissionMode`, `planMode`, `contextTokens`, ...);
- The **first line** of the command's stdout takes over footer line 1 (line 2 is always drawn by the host as `context: N%` and cannot be taken over);
- The command must finish within **300ms**; on failure/timeout/empty output the host silently falls back to the built-in layout — so this script degrades silently on every error path and never logs anything. The single deliberate non-zero exit is when the script is the managed copy of a disabled/removed plugin, which hands the line back to the built-in layout (that is how the plugin on/off switch works).

Data sources:

| Segment | Source |
|---|---|
| model / branch / Context | stdin snapshot + `git status --porcelain` (150ms timeout) |
| TPS / TTFT | incremental parsing of `step.end` events in `~/.kimi-code/sessions/*/session_<id>/agents/main/wire.jsonl` (legacy `ses_<id>` also supported) (byte offset persisted in `~/.kimi-code-hud/metrics-<sessionId>.json`; only new bytes are read each second) |
| quota (5h/wk) | `GET https://api.kimi.com/coding/v1/usages`, cached 60s in `~/.kimi-code-hud/quota.json`; when stale, the hot path renders the stale cache and spawns a detached background refresh — never blocking |

### Privacy & security

The access token is **read locally** from `~/.kimi-code/credentials/kimi-code.json` (Kimi Code CLI renews it; this tool never writes it) and is only used to call the official `api.kimi.com` quota endpoint. It is never written to logs, caches or output.

### FAQ

**Nothing changed?** Make sure you ran `/reload-tui` or restarted; check `echo '{}' | node bin/kimi-hud.mjs` prints a line.

**No TPS/TTFT segment?** A fresh session has no `step.end` samples yet; the first run only establishes the read offset.

**No quota segment?** The whole section is omitted until the first cache exists (no "loading" placeholder). Run `node bin/kimi-hud.mjs --refresh-quota` (silent) and check `~/.kimi-code-hud/quota.json`.

**Which layouts show the Context segment?** compact/full carry the bar, percentage and token counts; normal omits it — read the host-drawn line 2 (`context: N% (tokens/max)`), which can never be taken over by a plugin.

## Development

```bash
npm test        # node --test 'test/**/*.test.mjs'
```

MIT © 2026 FinbackYu
