# kimi-code-hud

自定义底部状态栏（HUD）for [Kimi Code CLI](https://www.kimi.com/) — 零依赖 Node.js 脚本，在终端 TUI 底部显示模型、Git 分支、上下文用量、生成速度（TPS/TTFT）与 API 配额。

A zero-dependency custom status line (HUD) for **Kimi Code CLI** — shows model, git branch, context usage, generation speed (TPS/TTFT) and API quota in the TUI footer.

<!-- 效果截图占位 / screenshot placeholder -->
<!-- ![screenshot](docs/screenshot.png) -->

```
K3 thinking: high │ kimi-code-hud git:(main*) │ ⚡47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ↻2h18m │ wk ██░░░░░░░░ 25%
```

---

## 中文

### 原理

Kimi Code 的 `~/.kimi-code/tui.toml` 支持 `[status_line]` 自定义命令：

- 每次刷新（每秒最多一次）宿主通过 stdin 传入一个 JSON 快照（model、cwd、gitBranch、permissionMode、planMode、contextTokens 等字段）；
- 命令 stdout 的**第一行**接管底部 Footer 第一行（第二行固定由宿主绘制 `context: N%`，插件无法接管）；
- 命令须在 **300ms** 内完成，失败/超时/空输出时宿主静默回退内置布局——所以本脚本对所有错误静默降级，绝不非零退出、绝不打印日志。

三段数据来源：

| 段 | 来源 |
|---|---|
| 模型 / 分支 / Context | stdin 快照 + `git status --porcelain`（150ms 超时） |
| TPS / TTFT | 增量解析 `~/.kimi-code/sessions/*/ses_<id>/agents/main/wire.jsonl` 的 `step.end` 事件（byte offset 存 `~/.kimi-code-hud/metrics-<sessionId>.json`，每秒只读新增字节） |
| 配额（5h/wk） | `GET https://api.kimi.com/coding/v1/usages`，60 秒 TTL 缓存于 `~/.kimi-code-hud/quota.json`，过期时热路径用过期缓存渲染并 spawn 后台刷新，绝不阻塞 |

### 安装

要求 Node.js ≥ 18（用到全局 `fetch`），无 npm 依赖。

```bash
git clone <repo-url> ~/kimi-code-hud
node ~/kimi-code-hud/bin/kimi-hud.mjs --install
```

`--install` 会先备份 `~/.kimi-code/tui.toml` 为 `tui.toml.<时间戳>.bak`，再在 `[status_line]` 段写入 `command = "node <绝对路径>"`（幂等，已有 `items` 会保留）。**重启 Kimi Code 或运行 `/reload-tui` 生效。**

### 配置

- `~/.kimi-code-hud/config.json`：`{"layout":"compact"|"normal"|"full"}`（默认 `normal`）
- 环境变量 `KIMI_HUD_LAYOUT` 优先于配置文件
- `NO_COLOR` 或 `KIMI_HUD_NO_COLOR`：禁用全部 ANSI 颜色

三档布局：

```
compact: K3 │ git:(main*) │ Context ██████░░░░ 62% (159K/256K) │ ⚡47 │ 5h ███░░░░░░░ 31%
normal:  K3 thinking: high │ kimi-code-hud git:(main*) │ ⚡47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ↻2h18m │ wk ██░░░░░░░░ 25%
full:    K3 thinking: high │ kimi-code-hud git:(main*) │ Context ██████░░░░ 62% (159K/256K) │ ⚡47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ↻2h18m │ wk ██░░░░░░░░ 25% ↻3d2h │ v0.31.0
```

- 模型后缀显示 thinking 状态：布尔模型为 ` thinking`，支持 effort 的模型为 ` thinking: <effort>`（数据来自会话日志的 `config.update` 事件，status line payload 不含此字段）；compact 档省略后缀；
- normal 档不含 Context 段（宿主第二行已有精确数值），compact/full 档保留柱+百分比+token 数；
- `permissionMode` 为 yolo/auto 时行首加 `[yolo]`（琥珀黄，对齐宿主默认）/`[auto]`（亮红，便于区分）徽章，plan 模式加 `[plan]`（蓝色）；`[swarm]`（青色）已实现，但当前宿主 status line payload 尚未携带 `swarmMode` 字段，上游补齐后自动生效；
- 柱条按用量分级着色：<60% 绿、<85% 黄、≥85% 红；
- 输出超过 200 字符自动降级 full→normal→compact。

### 卸载

```bash
node ~/kimi-code-hud/bin/kimi-hud.mjs --uninstall
```

同样先备份，然后移除 `[status_line]` 中本工具的 `command` 行。

### 隐私与安全

access token 仅从 `~/.kimi-code/credentials/kimi-code.json` **本地读取**（Kimi Code CLI 自己负责续期，本工具只读不写），仅用于请求官方 `api.kimi.com` 配额接口，不写入任何日志、缓存或输出。

### FAQ

**状态栏没变化？** 确认 `/reload-tui` 或重启过；确认 `node <path>` 直接 `echo '{}' | node bin/kimi-hud.mjs` 有输出。

**没有 TPS/TTFT 段？** 新会话还没有 `step.end` 样本；第一次运行只建立读取 offset，之后出现。

**没有配额段？** 缓存首次生成前整段省略（不显示"加载中"）。可手动 `node bin/kimi-hud.mjs --refresh-quota` 后重试；该命令静默执行，检查 `~/.kimi-code-hud/quota.json` 是否生成。

**Context 段在哪些档显示？** compact/full 档自带柱、百分比和 token 数；normal 档不显示，直接看宿主第二行的 `context: N% (tokens/max)`（该行永远由宿主绘制，插件无法接管）。

---

## English

### How it works

Kimi Code's `~/.kimi-code/tui.toml` accepts a `[status_line]` custom command:

- On each refresh (at most once per second) the host pipes a JSON snapshot to stdin (`model`, `cwd`, `gitBranch`, `permissionMode`, `planMode`, `contextTokens`, ...);
- The **first line** of the command's stdout takes over footer line 1 (line 2 is always drawn by the host as `context: N%` and cannot be taken over);
- The command must finish within **300ms**; on failure/timeout/empty output the host silently falls back to the built-in layout — so this script degrades silently on every error path and never exits non-zero or logs anything.

Data sources:

| Segment | Source |
|---|---|
| model / branch / Context | stdin snapshot + `git status --porcelain` (150ms timeout) |
| TPS / TTFT | incremental parsing of `step.end` events in `~/.kimi-code/sessions/*/ses_<id>/agents/main/wire.jsonl` (byte offset persisted in `~/.kimi-code-hud/metrics-<sessionId>.json`; only new bytes are read each second) |
| quota (5h/wk) | `GET https://api.kimi.com/coding/v1/usages`, cached 60s in `~/.kimi-code-hud/quota.json`; when stale, the hot path renders the stale cache and spawns a detached background refresh — never blocking |

### Install

Requires Node.js ≥ 18 (global `fetch`). Zero npm dependencies.

```bash
git clone <repo-url> ~/kimi-code-hud
node ~/kimi-code-hud/bin/kimi-hud.mjs --install
```

`--install` backs up `~/.kimi-code/tui.toml` to `tui.toml.<timestamp>.bak`, then writes `command = "node <abs path>"` into `[status_line]` (idempotent; existing `items` are preserved). **Restart Kimi Code or run `/reload-tui` to apply.**

### Configuration

- `~/.kimi-code-hud/config.json`: `{"layout":"compact"|"normal"|"full"}` (default `normal`)
- `KIMI_HUD_LAYOUT` env var overrides the config file
- `NO_COLOR` or `KIMI_HUD_NO_COLOR`: disable all ANSI colors

The model suffix shows thinking state: ` thinking` for boolean models, ` thinking: <effort>` for effort-capable ones (sourced from `config.update` events in the session log; the status-line payload does not carry it); compact omits the suffix. The normal layout drops the Context segment (the host's line 2 already shows the exact numbers); compact/full keep bar + percentage + token counts. See the layout table above. Badges `[yolo]` (amber, matching the host default), `[auto]` (bright red, for contrast) and `[plan]` (blue) appear at the line start; `[swarm]` (cyan) is implemented but the host status-line payload does not expose `swarmMode` yet — it activates automatically once upstream adds it. Bars are colored by usage (<60% green, <85% yellow, ≥85% red); lines longer than 200 chars automatically degrade full→normal→compact.

### Uninstall

```bash
node ~/kimi-code-hud/bin/kimi-hud.mjs --uninstall
```

Backs up first, then removes this tool's `command` line from `[status_line]`.

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
