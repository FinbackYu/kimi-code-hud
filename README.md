# kimi-code-hud

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![GitHub release](https://img.shields.io/github/v/release/FinbackYu/kimi-code-hud)](https://github.com/FinbackYu/kimi-code-hud/releases)

[English](README.en.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/FinbackYu/kimi-code-hud/issues)

![HUD 状态示例（堆叠展示，实际使用只渲染第一行）](docs/media/hud-states.png)

Kimi Code CLI 的自定义底部状态栏（HUD）——零依赖 Node.js 脚本，在终端 TUI 底部显示模型与思考强度、Git 分支、生成速度（TPS / TTFT）、压缩计时、缓存命中率、Kimi 托管订阅额度，以及受支持第三方 provider 的余额或会话成本估算。每次渲染 300ms 内完成，所有错误静默降级，绝不阻塞 TUI。

## 安装

要求 Node.js ≥ 18（用到全局 `fetch`），无 npm 依赖。

在 Kimi Code TUI 中运行：

```
/plugins install https://github.com/FinbackYu/kimi-code-hud
```

- 安装后**重启或开新会话**生效：`SessionStart` hook 会把 `tui.toml` 的 `[status_line]` 指向插件托管副本，并在每次会话启动时自动修复；
- 开关：`/plugins` 面板选中按 `Space`，或 `/plugins disable kimi-code-hud` / `/plugins enable kimi-code-hud`；
- 如果你已在 `[status_line]` 配置了自己的命令，hook 不会覆盖它；
- **更新**：重跑一遍安装命令即原地更新，约 1 秒自动生效。

## 配置

HUD 自有设置保存在 `~/.kimi-code-hud/config.json`（JSON；容忍未知键，文件缺失或损坏时整体回退默认值）。同名设置的环境变量优先于配置文件。

### config.json

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `layout` | `"normal"` / `"compact"` | `normal` | 布局档位；可见宽度超过 200 字符时自动 normal→compact 降级 |
| `permissionNames` | `"official"` / `"short"` | `official` | 权限徽标措辞。`official` 跟随宿主 0.40+ 官方称呼（`[Always Ask]` / `[Ask When Needed]` / `[Never Ask]`）；`short` 保留旧短徽标（`[manual]` / `[yolo]` / `[auto]`）。非法值回落默认 |
| `disabled` | `true` | （缺省即启用） | 禁用旗标；一般无需手改 |

```json
{ "layout": "normal", "permissionNames": "official" }
```

### 环境变量

| 变量 | 取值 | 说明 |
|---|---|---|
| `KIMI_HUD_LAYOUT` | `normal` / `compact` | 布局覆盖，优先于配置文件 |
| `KIMI_HUD_PERMISSION_NAMES` | `official` / `short` | 权限徽标措辞覆盖，优先于配置文件 |
| `KIMI_HUD_THEME` | `dark` / `light` / `auto` | 手动固定配色主题；缺省跟随 `tui.toml` 顶层的 `theme` |
| `NO_COLOR` / `KIMI_HUD_NO_COLOR` | 设置即生效 | 禁用全部 ANSI 颜色 |
| `KIMI_HUD_HOME` | 目录路径 | 覆盖 HUD 自有配置与缓存根（默认 `~/.kimi-code-hud`） |
| `KIMI_CODE_HOME` | 目录路径 | 覆盖 Kimi Code 数据根（默认 `~/.kimi-code`，本文出现的 `~/.kimi-code` 均指未设置时的默认路径） |

`KIMI_HUD_THEME` 为 `auto`（或未设置且宿主无 `theme`）时经 `COLORFGBG` 判定深浅、回退 dark——状态行无法在 300ms 热路径上执行宿主的 OSC 11 查询；自定义主题名回退 dark。light 下徽标（模型名、`[plan]`、`[Ask When Needed]`、`[swarm]`、`[tower]`、`[Never Ask]`）加粗显示，琥珀/青色比宿主默认更亮（`#D97706`/`#14B8A6`），额度柱体从刺眼的 ANSI 红改为柔和真彩色（`#B91C1C`/`#D97706`/`#0E7A38`）；dark 模式不变，柱体 ANSI 色由终端按自身主题重映射。

### 权限徽标

- 默认（official 措辞）：`[Always Ask]`（manual 档，褪色蓝 dark `#54658A` / light `#7D92B8`——比默认前景安静，常驻以保持行首对齐）、`[Ask When Needed]`（yolo 档，琥珀黄，对齐宿主）、`[Never Ask]`（auto 档，亮红，便于与琥珀区分）；
- `short` 措辞下为 `[manual]` / `[yolo]` / `[auto]`，配色规则不变。

## 临时关闭 / 卸载

调试时临时退回内置状态栏：`/plugins disable kimi-code-hud`，恢复用 `/plugins enable kimi-code-hud`。

卸载：`/plugins remove kimi-code-hud`，托管副本下次运行时自动清除 `tui.toml` 条目。改完后 **`/reload-tui` 或新会话生效**（宿主会缓存最后一帧自定义状态栏）。

## 状态栏明细

每段的精确口径（样本接纳规则、wire 推导路径、失败关闭边界、持久化文件）见 [CAPABILITIES.md](CAPABILITIES.md)。要点：

- 速度样本只接纳流式 ≥250ms、≤1000 t/s 的 `step.end`，取最近 10 分钟内最多 5 个的中位数；预热与窗口过期以暗灰显示，模型切换重新预热；
- 模型/thinking 优先取 wire（`profile.bind` 与每次请求的 `llm.request`），无 wire 时按会话快照 `~/.kimi-code-hud/thinking-<sessionId>.json` 固定，最后才回退解析 `config.toml` 并写快照——其他会话执行 `/effort` 改写全局配置不会串台；
- goal / swarm / tower 状态从主 agent wire 的 `goal.*` / `swarm_mode.*` / `tower_mode.*` 事件折叠；后台任务徽章从 `task.started` / `task.terminated` 与 `tasks/<taskId>.json` 旁车双源合并（取较新记录），只计 `running`（被标 `lost` 后仍有新写入的续跑子代理除外，上游 issue MoonshotAI/kimi-code#3350）；
- 配额仅对可归因到 `managed:kimi-code` 的模型显示与刷新；provider 余额/成本在币种未知、自建代理、未知模型或混合 provider ledger 时失败关闭；
- 会话成本本地计算，价格表以 **2026-08-09** 官方定价核对，不含服务端工具费等修正所以始终带 `≈`；DeepSeek 缓存命中字段在宿主补齐映射前按未命中价保守估算，数值可能偏高；
- 用量分级着色 <60% 绿 / <85% 黄 / ≥85% 红；可见宽度超过 200 字符自动 normal→compact 降级。

## 工作原理

宿主每秒通过 stdin 传一个 JSON 快照（读取上限 1 MiB、150ms 超时），命令 stdout 的**第一行**接管 footer line 1（line 2 固定由宿主绘制，插件无法接管），命令须在 **300ms** 内完成；失败/超时/空输出时宿主渲染内置行或重播上一帧——所以脚本对所有错误静默降级、绝不打印日志（唯一的非零退出是"已禁用/已移除插件的托管副本"自我清除 `tui.toml` 条目，插件开关由此实现）。

数据来自四路：stdin 快照与跨进程缓存的 Git 探针（cwd 只存 SHA-256，TTL 15s）；会话 `wire.jsonl` 增量解析（main + 全部 subagent，无正文，cursor 与计数持久化在 `~/.kimi-code-hud/`）；官方 `/usages` 配额接口（60s 缓存 + 后台刷新，双区域按 oauth host 判定）；provider 官方余额接口与本地定价的成本估算（按 provider + key 指纹隔离缓存）。

## 能力与已知问题

- [能力清单](CAPABILITIES.md)：Kimi Code 0.40.1 第一行 slots 的覆盖情况、数据来源，以及已经可读但尚未展示的 Cache/token/goal/task/Git 等信息；
- [已知问题](KNOWN_ISSUES.md)：Git、终端宽度、失败帧与全屏动态验证缺口及验收条件。

## 隐私与安全

- Kimi access token 仅从 `~/.kimi-code/credentials/` 本地读取（CLI 自己负责续期，本工具只读不写），仅用于官方 `api.kimi.com` / `api.kimi.ai` 配额接口；DeepSeek API Key 仅在 provider 名与基址均为官方 `api.deepseek.com` 时读取，请求固定的官方余额接口；
- 两类凭证都不写入日志、缓存或输出；provider usage 缓存只保存 API Key 的单向 SHA-256 指纹和规范化余额；
- 所有动态显示文本在 HUD 加 ANSI 样式前剥离 OSC、CSI 及 C0/DEL/C1 控制字符；HUD 自身颜色序列不经过该清洗器；
- Session Cost 完全在本地计算，不额外发送 API Key；持久化 ledger 只有模型别名与四类 Token 计数，无会话正文。

## FAQ

**状态栏没变化？** 确认 `/reload-tui` 或重启过；确认 `echo '{}' | node ~/.kimi-code/plugins/managed/kimi-code-hud/bin/kimi-hud.mjs` 有输出。

**没有 TPS？** 只有一种状态会完全看不到 TPS：当前会话连一个有效 `step.end` 样本都还没有（全新会话的首个 step 进行中，期间先单独显示 TTFT）。预热期（不足 3 个样本）、窗口过期与刚切换模型都以暗灰显示临时读数或最后一次中位数，攒够 3 个有效样本后转为正常亮度。若连 TTFT 也没有，说明当前会话还没有完成过 `step.end`。

**没有 Cache？** 会话还没有任何完整 `step.end` 用量时整段省略；首个有效用量计入后出现，此后常亮不再消失。升级后旧状态会从 wire 尾巴（最多 1 MiB）一次性重建累计计数。

**没有配额段？** 先确认当前模型不是第三方 provider（`/provider` 接入的模型本就不显示配额，接口只覆盖托管订阅），并且其模型配置能明确解析到 `managed:kimi-code`；provider 未知时按安全边界失败关闭。managed 模型下，缓存首次生成前整段省略。可手动 `node ~/.kimi-code/plugins/managed/kimi-code-hud/bin/kimi-hud.mjs --refresh-quota` 后重试。

**没有 DeepSeek 余额或 Session Cost？** 必须正在使用 provider 名为 `deepseek` 的支持模型，且其 `type = "openai"`、`base_url` 是官方 `https://api.deepseek.com`（可带 `/v1`）。余额还要求有效 `api_key`；首次后台刷新完成前不显示占位（成本必须先从余额响应确认币种）。完整用量 ledger 就绪后，即使余额不可用也可按已知币种单独显示 Session Cost。可静默运行 `node ~/.kimi-code/plugins/managed/kimi-code-hud/bin/kimi-hud.mjs --refresh-provider-usage deepseek` 后检查 `~/.kimi-code-hud/provider-usage/`。兼容代理会按安全设计拒绝余额请求和成本估算。

**没有 DeepSeek / OpenAI / Anthropic Session Cost？** 当前模型必须使用对应官方直连服务，且模型 ID 位于内置价格表。所有日志追平前不显示不完整数字；同一会话只要存在其他 provider 或无法解析模型的非零用量，整项隐藏。该值是本次会话的本地估算，不是 API 余额，也与 ChatGPT / Claude 订阅额度无关。

**Context 段去哪了？** 插件不再自绘 Context 段，直接看宿主第二行的 `context: N% (tokens/max)`（该行永远由宿主绘制，插件无法接管）。

## 本地开发

```bash
npm test        # node --test
```

## 许可证

基于 [MIT](LICENSE) 协议发布。© 2026 FinbackYu
