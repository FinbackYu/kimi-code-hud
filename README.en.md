# kimi-code-hud

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![GitHub release](https://img.shields.io/github/v/release/FinbackYu/kimi-code-hud)](https://github.com/FinbackYu/kimi-code-hud/releases)

[中文](README.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/FinbackYu/kimi-code-hud/issues)

![HUD state gallery (stacked for showcase; only the first line renders in real use)](docs/media/hud-states.png)

## What is kimi-code-hud

A zero-dependency custom status line (HUD) for [Kimi Code CLI](https://www.kimi.com/) — shows model & thinking effort, git branch, generation speed (TPS / TTFT), compaction state, session cache hit rate, Kimi managed-subscription usage, and supported third-party provider API balances or session-cost estimates in the TUI footer.

## Key features

- **Model & thinking effort.** The model name is painted in the host's theme blue with a live suffix for thinking state / effort level (e.g. `K3 max`), pinned per session — another session running `/effort` never changes what this session shows. A suffix still inferred from config (before the first wire rows of a lazy-started session) renders muted gray and returns to the default foreground once the wire confirms the actual effort.
- **Git state.** Directory name plus a `git:(branch*)` dirty marker, with a 150ms timeout so rendering never blocks.
- **Generation speed.** Streaming TPS median plus TTFT; while a turn runs, a live `gen Ns` timer takes over the slot; parallel agents aggregate into a fleet total (`⚡ 156 t/s (3 agents @52)`).
- **Compaction timer.** A live `compacting Ns` ticker during `/compact`, then a dimmed `compacted Ns` holds the slot until the next prompt's `gen` timer takes over.
- **Cache hit rate.** Token-weighted and accumulated across turns — stays bright between prompts instead of flashing gray.
- **Kimi managed-subscription usage.** 5h / 7d bars with percentage and reset countdown, colored green / yellow / red by usage; the whole section hides automatically for third-party provider models and does not represent API balance or spend.
- **DeepSeek API balance and session cost.** Once both facts are ready, the official DeepSeek provider uses the account currency, for example `DeepSeek Balance ¥110.00 · Session Cost ≈¥0.03` for a CNY account; when balance is unavailable but its currency is known, `DeepSeek Session Cost ≈¥0.03` can still appear alone. It uses the full brand and metric names, with no made-up percentage or reset period, and refresh never blocks the footer.
- **OpenAI / Anthropic session cost.** Official direct API models show `OpenAI Session Cost ≈$0.42` or `Anthropic Session Cost ≈$0.68`; the total includes main and every subagent, names its session scope, and never pretends to be a balance or server bill. If the same session contains nonzero usage from another provider or an unresolved model, the whole estimate hides instead of undercounting; Tower workers on another provider follow the same fail-closed rule.
- **Mode badges.** `[yolo]` / `[auto]` / `[plan]` / `[goal …]` / `[swarm]` / `[tower]`, in the same slot order as the built-in footer.
- **Background-task badges.** Running shell tasks and background subagents counted separately — `[N task(s) running]` / `[N agent(s) running]`, inserted between the model and the directory, matching the built-in footer's slot order.
- **Dark & light themes.** Follows the host `theme` setting; light mode bolds badges and softens the bar colors.
- **Hot-path safe.** Every render finishes within 300ms and all errors degrade silently — no logs, never blocking the TUI.

## Install

Requires Node.js ≥ 18 (global `fetch`). Zero npm dependencies.

**Option 1: install as a Kimi Code plugin (recommended, easy on/off)**

In the Kimi Code TUI, run:

```
/plugins install https://github.com/FinbackYu/kimi-code-hud
```

- **Restart or start a new session** to activate: the plugin's `SessionStart` hook points `tui.toml`'s `[status_line]` at the plugin's managed copy (`~/.kimi-code/plugins/managed/kimi-code-hud/`) and repairs that entry on every session start;
- Toggle: select it in the `/plugins` panel and press `Space`, or run `/plugins disable kimi-code-hud` / `/plugins enable kimi-code-hud`. Within ~1s of disabling or removing, the managed copy strips its own `[status_line]` entry from `tui.toml` and stops rendering (the host replays the last custom frame, so `/reload-tui` or a new session is needed to see the built-in layout); when re-enabled, the SessionStart hook writes the entry back on the next session start;
- If you already configured your own `[status_line]` command, the hook leaves it untouched.

**Option 2: manual install (git checkout)**

```bash
git clone https://github.com/FinbackYu/kimi-code-hud ~/kimi-code-hud
node ~/kimi-code-hud/bin/kimi-hud.mjs --install
```

`--install` backs up `~/.kimi-code/tui.toml` to `tui.toml.<timestamp>.bak`, then writes `command = "node <abs path>"` into `[status_line]` (idempotent; existing `items` are preserved). It also appends a managed `SessionStart` hook block to `~/.kimi-code/config.toml` (wrapped in START/END comments, leaving other hooks and settings alone): some host upgrades rewrite `tui.toml` and wipe `[status_line]` (observed on 0.30.0→0.31.0), while config.toml hooks survive upgrades, so on every session start the hook self-checks and repairs the entry. **Restart Kimi Code or run `/reload-tui` to apply.**

> Do not mix the two: while the plugin is enabled, its hook points `tui.toml` at the managed copy. To go back to a manual install, `/plugins remove kimi-code-hud` first, then re-run `--install`.

## Update

- **Reinstall to update**: run `/plugins install https://github.com/FinbackYu/kimi-code-hud` again. The managed copy is replaced in place and the status line picks up the new version within ~1 second — no `/reload-tui` or new session needed.
- See [CHANGELOG.md](CHANGELOG.md) for version history; stable versions are published through GitHub Releases.

## Temporary off / on

To fall back to the built-in status line while debugging, you don't need `--uninstall` (which also strips the self-heal hook):

```bash
node ~/kimi-code-hud/bin/kimi-hud.mjs --off
node ~/kimi-code-hud/bin/kimi-hud.mjs --on
```

- `--off`: writes `"disabled": true` into `~/.kimi-code-hud/config.json` (preserving other keys such as `layout`), backs up and removes the `[status_line]` command from `tui.toml`; the hook block in `config.toml` is left alone — the hook sees the flag and stays silent, so it won't resurrect the HUD on the next session start;
- `--on`: deletes the `disabled` key, writes the command back into `tui.toml`, and ensures the hook block is present.

**Restart Kimi Code or run `/reload-tui` to apply.**

## Uninstall

Plugin install: `/plugins remove kimi-code-hud` (per upstream behavior the managed copy stays on disk while the install record is deleted; the managed copy strips its own `tui.toml` entry on its next run, and `/reload-tui` or a new session brings back the built-in layout).

Manual install:

```bash
node ~/kimi-code-hud/bin/kimi-hud.mjs --uninstall
```

Backs up first, then removes this tool's `command` line from `[status_line]` and the self-heal hook block from `config.toml`.

## Configuration

- `~/.kimi-code-hud/config.json`: `{"layout":"compact"|"normal"}` (default `normal`); `"disabled": true` is the switch flag written by `--off` (absent means enabled; `--on` deletes the key)
- `KIMI_HUD_LAYOUT` env var overrides the config file
- `NO_COLOR` or `KIMI_HUD_NO_COLOR`: disable all ANSI colors
- `KIMI_HUD_THEME=dark|light`: pin the color theme manually. By default it follows the top-level `theme` setting in `tui.toml`; `"auto"` resolves via `COLORFGBG` with a dark fallback (a status line can't run the host's OSC 11 query on the 300ms hot path); custom theme names fall back to dark. On light, badges (model name, `[plan]`, `[yolo]`, `[swarm]`, `[tower]`, `[auto]`) render bold, the amber/teal are brighter than the host defaults (`#D97706`/`#14B8A6`), and the quota bars use calmer truecolor hues (`#B91C1C`/`#D97706`/`#0E7A38`) instead of glaring ANSI red. Dark mode is unchanged: bars keep terminal-remapped ANSI colors

Two layout tiers:

```
compact: [manual] K3 high │ git:(main*) │ ⚡ 47 │ Cache 92% │ 5h 31% ~2h18m
normal:  [manual] K3 high │ kimi-code-hud git:(main*) │ ⚡ 47 t/s · TTFT 1.3s │ Cache 92% │ 5h ███░░░░░░░ 31% ~2h18m · 7d ██░░░░░░░░ 25% ~3d2h
```

In /goal mode a goal badge is inserted between the mode badges and the model (shown in every tier, matching the built-in footer's slot order):

```
[manual] [goal ● active · 4m · 7 turns] K3 high │ …
```

While background tasks run, task badges are inserted between the model and the directory (shown in every tier; each category hides at zero):

```
[manual] K3 high │ [1 task running] [2 agents running] │ kimi-code-hud git:(main*) │ …
```

- Model name: painted in the host's primary blue (dark theme `#4FA8FF` / light theme `#1565C0`, the blue used for links and inline code in the conversation, following the resolved theme). The model suffix shows thinking state: ` thinking` for boolean models, a bare effort level for effort-capable ones (e.g. `K3 high`, compact keeps the same ` <effort>` suffix). The status-line payload does not carry it; prefer the session-log events — newer hosts bind the session profile once at start as `profile.bind` (older hosts used `config.update`) with `modelAlias` + `thinkingEffort` (older key `thinkingLevel`), and every `llm.request` row also carries the effort and model alias the request actually ran with, so an in-session effort/model switch that emits no profile/config row still updates the HUD on the next request. When neither exists, pin the value per session in `~/.kimi-code-hud/thinking-<sessionId>.json`; only when no snapshot exists does it fall back to the `[thinking]` and model tables in `~/.kimi-code/config.toml` and write the snapshot — so another session running `/effort`, which rewrites the global config, no longer changes what this session shows. The snapshot records the provenance: a wire-confirmed level keeps the default foreground, while a level only inferred from config (before the first turn's wire rows on a lazy-started session) renders muted gray and returns to normal once the wire confirms the actual effort;
- Goal badge: mirrors the built-in footer's format (`[goal ● <status> · <elapsed> · <turns>]`, `3/10 turns` when a turn budget is set; dot: active blue / blocked amber / paused muted). The status-line payload carries no goal field, so the state is rebuilt from the session log's `goal.create`/`goal.update`/`goal.clear`/`forked` ops in `wire.jsonl` (same incremental scan as TPS); an active goal ticks every second from `wallClockResumedAt`, and the badge disappears once the goal completes or is cleared. While the badge is up, the speed segment keeps throughput only: the `gen` timer, TTFT and the compaction state all hide — the badge already carries the session clock, the same reason auto-compactions inside a turn stay hidden;
- TPS: only accepts `step.end` samples whose streaming phase lasts at least 250ms and whose calculated rate is no higher than 1000 t/s. With fewer than 3 valid samples a provisional reading (the median of whatever fresh samples exist) shows in muted gray; at 3 samples the full median of the latest 5 at most takes over in normal brightness. When the window expires (the last sample is older than 2 minutes) the segment does not disappear: the last median stays visible in muted gray, and the first sample of a fresh window immediately takes over as a muted provisional reading. A model change discards the old median and restarts the warmup. Only when no valid sample exists at all (e.g. a brand-new session before its first `step.end`) does the latest TTFT show on its own;
- Cache: the token-weighted prompt-cache hit rate for the whole session, `Σ inputCacheRead / Σ (inputOther + inputCacheRead + inputCacheCreation)`, accumulated across turns over every main-agent model request (steps with incomplete usage fields are skipped). Because the number is cumulative, it is always the latest complete value and stays bright between prompts instead of flashing gray at each turn start. The segment is omitted only while the session has no data at all. Both tiers show only the percentage; no red/yellow/green quality threshold is applied;
- Quota: bar + percentage + reset countdown in normal; compact drops the bar and keeps percentage + countdown; the weekly (7d) segment appears only in normal. Quota shows only while the active model is served by the managed Kimi Code subscription (`managed:kimi-code`) — models from third-party providers added via `/provider` hide the whole section (the quota API describes the managed subscription only, not what the session is actually consuming); `/logout` deletes the cache together with the credentials;
- Provider usage facts can be combined. A provider named `deepseek` with the official `https://api.deepseek.com` root (optionally `/v1`) shows the API-reported available balance (CNY preferred, then USD) and locally prices standard text tokens from every agent's session `usage.record` ledger. Cost uses the balance response's account currency and corresponding official table. With both facts a CNY account renders `DeepSeek Balance ¥… · Session Cost ≈¥…`; when balance is unavailable but currency is known, cost can appear alone as `DeepSeek Session Cost ≈¥…`. Before the first balance response, currency is not guessed and DeepSeek cost stays hidden. A 60-second-old balance cache is dimmed while a detached child refreshes it, while cost keeps accumulating locally. Official direct `api.openai.com` / `api.anthropic.com` providers render only `OpenAI Session Cost ≈…` / `Anthropic Session Cost ≈…`. A local cost is neither a balance nor an admin billing report; it stays silently hidden until the ledger is complete, when a model has no built-in price, when a compatible/self-hosted proxy is configured, or when the all-agent ledger contains nonzero usage from another provider or an unresolved model;
- Badges: `[yolo]` (amber, matching the host default), `[auto]` (bright red, for contrast), `[manual]` (muted gray placeholder that keeps the left edge aligned) and `[plan]` (blue) appear at the line start; `[swarm]` (cyan) is derived from the session wire journal's `swarm_mode.enter/exit` lines (the same derivation path as the goal badge — the status-line payload carries no swarm flag); a future `swarmMode` payload field would also activate it; `[tower]` reuses that cyan orchestration slot and follows the main-agent wire's `tower_mode.enter/exit`; the optional `tower_mode.enter.sessionId` does not change the boolean fold;
- Background-task badges: mirror the built-in footer's format (`[N task(s) running]` for shell processes, `[N agent(s) running]` for background subagents; blue, each hidden at zero). The status-line payload carries no task fields, so the running counts are rebuilt from the main wire's `task.started`/`task.terminated` ops and reconciled every frame against the `agents/main/tasks/<taskId>.json` sidecars (hosts that predate the journaled ops are covered by sidecars alone); the fresher record wins per task id. Only `running` tasks count (completed/failed/timed_out/killed/lost do not), only the counts are rendered (command, description and output never enter the footer), and the figures stay fully separate from the throughput `activeAgents` count;
- Usage is color-graded: <60% green, <85% yellow, ≥85% red. Normal paints the bar; compact has no bar, so the percentage number takes over the signal — and the comfortable green level stays default-colored there (only yellow and red paint);
- Output longer than 200 characters automatically degrades normal→compact.

## How it works

Kimi Code's `~/.kimi-code/tui.toml` accepts a `[status_line]` custom command:

- On each refresh (at most once per second) the host pipes a JSON snapshot to stdin (`model`, `cwd`, `gitBranch`, `permissionMode`, `planMode`, `contextTokens`, ...; reads are capped at 1 MiB with a 150ms timeout — past either limit the snapshot is treated as absent and the HUD silently falls back);
- The **first line** of the command's stdout takes over footer line 1 (line 2 is always drawn by the host as `context: N%` and cannot be taken over);
- The command must finish within **300ms**; before the first successful frame, failure/timeout/empty output makes the host render the built-in line 1, and once a good frame exists the host keeps replaying it — so this script degrades silently on every error path and never logs anything. The single deliberate non-zero exit is when the script is the managed copy of a disabled/removed plugin: it strips its own `tui.toml` entry first, then exits non-zero (a bare non-zero exit is not enough — the host replays the last good frame as long as the entry remains), and `/reload-tui` or a new session restores the built-in layout (that is how the plugin on/off switch works).

Data sources:

| Segment | Source |
|---|---|
| model / branch | stdin snapshot + `git status --porcelain=v1 --branch` resolved from PATH to an absolute executable outside the workspace; results persist across command processes in `~/.kimi-code-hud/git-status-cache.json`, keyed only by a cwd SHA-256, for 15 seconds and at most 64 worktrees; the child runs with `GIT_OPTIONAL_LOCKS=0`, and each probe still has a 150ms ceiling; no trusted `git` silently omits the dirty marker |
| TPS / TTFT / Cache / thinking / goal / swarm / tower / model usage | incremental parsing of `turn.prompt`, `step.end`, `usage.record`, `llm.request`, `turn.cancel`, `config.update`, `goal.*`, `swarm_mode.*`, `tower_mode.*` and `full_compaction.*` events in **all** `~/.kimi-code/sessions/*/session_<id>/agents/*/wire.jsonl` of the session (main + every subagent; legacy `ses_<id>` also supported). Samples carry the event timestamp and are bucketed per agent: only the freshest 5 within the last 10 minutes feed each agent's median, so resume continuations, long idle gaps and compactions never mix in stale numbers. With several agents active at once (swarm/Tower/subagent runs — a sample within 2 minutes or a request in flight; a subagent leaves the count the moment its turn ends with the closing `end_turn`, without waiting out the 2-minute window) the segment shows the **fleet total plus head count and per-agent average** (`⚡ 305 t/s (12 agents @25)` — 305 is the sum of the active agents' median speeds, `@25` their mean); when the main agent feeds the figure the head count reads `main+N` (e.g. `⚡ 465 t/s (main+4 @93)`) so it can't be mistaken for a pure subagent count; in swarm or Tower mode a parked main (blocked waiting on its subagents, no request in flight) is excluded immediately, and outside orchestration modes an idle main settles back out once it ages past the 2-minute window. TTFT is the median across active agents so one stuck agent cannot poison the display. While a turn is running (from `turn.prompt` until `end_turn`/`turn.cancel`) the segment swaps TTFT for a live `gen Ns` timer that spans tool calls and steps — how long the command has been working, not just one request (the timer, TTFT and the compaction state all hide while the goal badge is up, leaving throughput only). A between-turns compaction (manual `/compact`, from `full_compaction.begin` until `complete`/`cancel`) takes the same TTFT slot: a live `compacting Ns` ticker, then the dimmed `compacted Ns` holds the slot until the next prompt's `gen` timer takes over — auto-compactions inside a turn are not shown (the `gen` timer covers that span). Cache, thinking, goal, swarm and tower read the main agent's wire only. Model usage has a dedicated cursor over every agent's `usage.record`, accumulates the four token classes by model, and enters cost calculation only after every wire is caught up. Cursors and content-free token counts persist in `~/.kimi-code-hud/metrics-<sessionId>.json`; prompts, responses, and tool output are never stored |
| quota (5h/7d) | the official `/usages` quota API — `GET https://api.kimi.com/coding/v1/usages` by default; with 0.38.0 dual-region, the region is resolved from env `KIMI_CODE_OAUTH_HOST`/`KIMI_OAUTH_HOST` → config.toml's `[providers."managed:kimi-code".oauth]` (`oauth_host`/`key`) and the provider table's `base_url`, and a global login switches to `https://api.kimi.ai/coding/v1/usages` with the scoped credential file derived from the oauth key — any non-official host/base_url fails closed to the default. Cached 60s in `~/.kimi-code-hud/quota.json`; when stale, the hot path renders the stale cache and spawns a detached background refresh — never blocking. Rendered and refreshed only while the active model can be attributed explicitly to `managed:kimi-code` (resolved from the session log's `modelAlias` via the `provider` key of the matching `config.toml` model table). Missing providers, unreadable config, and unresolved models fail closed: neither quota nor provider usage is rendered or refreshed. The cache is deleted when the credentials are gone (`/logout`); a 401 with a refresh_token still present (expired access_token — common while idle, since the CLI refreshes lazily) keeps the stale cache until the refresh succeeds |
| provider usage | active `modelAlias` → model table → provider table in `config.toml`. DeepSeek balance comes from the official `GET https://api.deepseek.com/user/balance`, isolated by provider + API-key fingerprint under `~/.kimi-code-hud/provider-usage/`; the hot path reads cache only and refreshes in the background. Its Session Cost, like OpenAI / Anthropic, combines the local all-agent model-usage ledger with built-in official standard pricing and selects the CNY or USD table from the balance response. Balance and cost facts are collected independently and can render together; unknown currency, custom proxies, unknown models, and mixed-provider ledgers fail closed |

## Privacy & security

The Kimi access token is **read locally** from the credential slot of the current region under `~/.kimi-code/credentials/` (default `kimi-code.json`; a global region login uses the `kimi-code-env-<digest>.json` file derived from the oauth ref key — Kimi Code CLI renews it; this tool never writes it) and is only used for the official `api.kimi.com` / `api.kimi.ai` quota endpoints. The DeepSeek API key is read locally from `~/.kimi-code/config.toml` and is used only when both the provider name and configured base URL select official `api.deepseek.com`; the request URL is fixed to the official balance endpoint. Neither credential is written to logs, caches, or output. Provider-usage caches contain only a one-way SHA-256 credential fingerprint and normalized balance facts. DeepSeek / OpenAI / Anthropic Session Cost is computed entirely locally without an additional API-key request; its persisted ledger contains only model aliases and four token counters, never session content.

All dynamic display text from the status snapshot, wire/config state, Git, and provider/quota caches is stripped of OSC, CSI, other ESC string controls, and C0/DEL/C1 control characters before the HUD adds its own ANSI SGR styling. HUD-generated color sequences do not pass through that sanitizer.

The DeepSeek / OpenAI / Anthropic table is based on the standard text-token rates in the official DeepSeek [CNY pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) and [USD pricing](https://api-docs.deepseek.com/quick_start/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), and [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) pages checked on **2026-08-09**. It currently covers DeepSeek V4 Flash / Pro (`deepseek-chat` / `deepseek-reasoner` follow the official V4 Flash compatibility mapping), OpenAI GPT-5.6 / Sol / Terra / Luna, and the current Anthropic Claude 5, Claude 4.x, and Haiku 3.5 entries. The estimate includes uncached input, cache reads, cache writes (Kimi Code's Anthropic `ephemeral` cache uses the 5-minute rate), and output. It excludes server-side tool fees, taxes, discounts, Batch / Fast / regional / data-residency modifiers, and OpenAI long-context premiums, so the footer always uses `≈`. DeepSeek reports cache hits as `prompt_cache_hit_tokens`, but Kimi Code's current OpenAI-compatible usage normalizer does not yet copy that field into `inputCacheRead`; until the host adds that mapping, those input tokens are conservatively priced as cache misses and the DeepSeek estimate can be high. It is not the provider's final bill, and a price/model mismatch is hidden rather than guessed.

## FAQ

**Nothing changed?** Make sure you ran `/reload-tui` or restarted; check `echo '{}' | node bin/kimi-hud.mjs` prints a line.

**No TPS segment?** Only one state hides TPS entirely: no valid `step.end` sample yet (a brand-new session mid-first-step — TTFT shows on its own meanwhile). Warmup with fewer than 3 samples, an expired window, and a model change (which discards the previous median) all render a muted provisional reading or the last median; normal brightness resumes at 3 valid samples. If TTFT is also absent, this session has not completed a `step.end` yet.

**No Cache segment?** It stays omitted only while the session has no complete `step.end` usage yet. Once the first valid usage lands, the segment appears and stays on permanently. After upgrades, a bounded restoration (at most 1 MiB of the wire tail) rebuilds the cumulative counters once.

**No quota segment?** First check whether the active model comes from a third-party provider (models added via `/provider` never show quota — the API covers the managed subscription only) and whether its model config resolves explicitly to `managed:kimi-code`; an unknown provider fails closed. For managed models, the whole section is omitted until the first cache exists (no "loading" placeholder). Run `node bin/kimi-hud.mjs --refresh-quota` (silent) and check `~/.kimi-code-hud/quota.json`.

**No DeepSeek balance or Session Cost?** The active supported model must use a provider named `deepseek`, `type = "openai"`, and the official `https://api.deepseek.com` base (optionally `/v1`). Balance additionally requires a valid `api_key`. Before the first detached refresh finishes, neither balance nor cost has a loading placeholder because cost must first learn CNY or USD from the balance response instead of guessing a currency. Once the complete usage ledger is ready, Session Cost can appear alone even when balance is unavailable if its currency is known. You can run `node bin/kimi-hud.mjs --refresh-provider-usage deepseek` silently and then inspect `~/.kimi-code-hud/provider-usage/`. Compatible proxies are intentionally refused for both balance requests and cost estimates.

**No DeepSeek / OpenAI / Anthropic Session Cost?** The active model must use the corresponding official direct service and a model ID in the built-in price table. After an upgrade, a dedicated reader incrementally rebuilds `usage.record` from main and every subagent within the render budget; no partial number is shown before all wires catch up. If the same session contains nonzero usage from another provider or an unresolved model, the whole estimate also hides rather than presenting one provider's subtotal as the session total. Compatible proxies, unknown models, and sessions with no valid token usage stay hidden. This is a local estimate for the current Kimi Code session, not an API balance and not a ChatGPT / Claude subscription allowance.

**Where did the Context segment go?** The plugin no longer draws its own Context segment (the full tier was removed along with it) — read the host-drawn line 2 (`context: N% (tokens/max)`), which can never be taken over by a plugin.

## Capabilities & known issues

- [Capabilities](CAPABILITIES.md): coverage of Kimi Code 0.36.1's line-1 slots, data sources, and readable-but-unrendered Cache/token/goal/task/Git information;
- [Known issues](KNOWN_ISSUES.md): open Git, terminal-width, stale-frame, and fullscreen verification gaps with acceptance criteria.

## Development

```bash
npm test        # node --test
```

## License

Released under the [MIT License](LICENSE). © 2026 FinbackYu
