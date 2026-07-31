# kimi-code-hud

A zero-dependency custom status line (HUD) for **Kimi Code CLI** — shows model, git branch, context usage, generation speed (TPS/TTFT) and API quota in the TUI footer.

**[中文](README.md)**

<!-- screenshot placeholder -->
<!-- ![screenshot](docs/screenshot.png) -->

```
K3 thinking:high │ kimi-code-hud git:(main*) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ~2h18m │ wk ██░░░░░░░░ 25%
```

---

### Install

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

### Update

- **Reinstall to update**: run `/plugins install https://github.com/FinbackYu/kimi-code-hud` again. The managed copy is replaced in place and the status line picks up the new version within ~1 second — no `/reload-tui` or new session needed.

### Uninstall

Plugin install: `/plugins remove kimi-code-hud` (per upstream behavior the managed copy stays on disk while the install record is deleted; the managed copy strips its own `tui.toml` entry on its next run, and `/reload-tui` or a new session brings back the built-in layout).

Manual install:

```bash
node ~/kimi-code-hud/bin/kimi-hud.mjs --uninstall
```

Backs up first, then removes this tool's `command` line from `[status_line]` and the self-heal hook block from `config.toml`.

### Configuration

- `~/.kimi-code-hud/config.json`: `{"layout":"compact"|"normal"|"full"}` (default `normal`)
- `KIMI_HUD_LAYOUT` env var overrides the config file
- `NO_COLOR` or `KIMI_HUD_NO_COLOR`: disable all ANSI colors

Three layout tiers:

```
compact: [manual] K3 high │ git:(main*) │ ⚡ 47 │ 5h 31% ~2h18m
normal:  [manual] K3 thinking:high │ kimi-code-hud git:(main*) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ~2h18m │ wk ██░░░░░░░░ 25%
full:    [manual] K3 thinking:high │ kimi-code-hud git:(main*) │ Context ██████░░░░ 62% (159K/256K) │ ⚡ 47 t/s · TTFT 1.3s │ 5h ███░░░░░░░ 31% ~2h18m │ wk ██░░░░░░░░ 25% ~3d2h │ v0.31.0
```

In /goal mode a goal badge is inserted between the mode badges and the model (shown in every tier, matching the built-in footer's slot order):

```
[manual] [goal ● active · 4m · 7 turns] K3 thinking:high │ …
```

The goal badge mirrors the built-in footer's format (`[goal ● <status> · <elapsed> · <turns>]`, `3/10 turns` when a turn budget is set; dot: active blue / blocked amber / paused muted). The status-line payload carries no goal field, so the state is rebuilt from the session log's `goal.create`/`goal.update`/`goal.clear`/`forked` ops in `wire.jsonl` (same incremental scan as TPS); an active goal ticks every second from `wallClockResumedAt`, and the badge disappears once the goal completes or is cleared.

TPS only accepts `step.end` samples whose streaming phase lasts at least 250ms and whose calculated rate is no higher than 1000 t/s. It appears after 3 valid samples and uses the median of the latest 5 at most. A model change or a gap of more than 2 minutes restarts the warmup; the latest TTFT remains visible during warmup.

The model name is painted in the host's primary blue (dark theme `#4FA8FF`, the blue used for links and inline code in the conversation). The model suffix shows thinking state: ` thinking` for boolean models, ` thinking:<effort>` for effort-capable ones (the status-line payload does not carry it; prefer `config.update` events from the session log — new hosts write `thinkingEffort`, including an initial event at session start, older hosts wrote `thinkingLevel` only after an in-session change. When neither exists, pin the value per session in `~/.kimi-code-hud/thinking-<sessionId>.json`; only when no snapshot exists does it fall back to the `[thinking]` and model tables in `~/.kimi-code/config.toml` and write the snapshot — so another session running `/effort`, which rewrites the global config, no longer changes what this session shows); compact drops the `thinking` label and keeps only the space-separated `<effort>` suffix (e.g. `K3 high`). Quota segments show bar + percentage + reset countdown in normal/full; compact drops the bar and keeps percentage + countdown; the weekly (wk) segment appears only in normal/full. Quota appears only while the active model is served by the managed Kimi Code subscription (`managed:kimi-code`) — models from third-party providers added via `/provider` hide the whole section (the quota API describes the managed subscription only, not what the session is actually consuming), and `/logout` deletes the cache together with the credentials. The Context segment appears only in full (bar + percentage + token counts); compact/normal omit it — read the host-drawn line 2 for the exact numbers there. Badges `[yolo]` (amber, matching the host default), `[auto]` (bright red, for contrast), `[manual]` (muted gray placeholder that keeps the left edge aligned) and `[plan]` (blue) appear at the line start; `[swarm]` (cyan) is implemented but the host status-line payload does not expose `swarmMode` yet — it activates automatically once upstream adds it. Bars are colored by usage (<60% green, <85% yellow, ≥85% red); lines longer than 200 chars automatically degrade full→normal→compact.

### How it works

Kimi Code's `~/.kimi-code/tui.toml` accepts a `[status_line]` custom command:

- On each refresh (at most once per second) the host pipes a JSON snapshot to stdin (`model`, `cwd`, `gitBranch`, `permissionMode`, `planMode`, `contextTokens`, ...);
- The **first line** of the command's stdout takes over footer line 1 (line 2 is always drawn by the host as `context: N%` and cannot be taken over);
- The command must finish within **300ms**; on failure/timeout/empty output the host silently falls back to the built-in layout — so this script degrades silently on every error path and never logs anything. The single deliberate non-zero exit is when the script is the managed copy of a disabled/removed plugin: it strips its own `tui.toml` entry first, then exits non-zero (a bare non-zero exit is not enough — the host replays the last good frame as long as the entry remains), and `/reload-tui` or a new session restores the built-in layout (that is how the plugin on/off switch works).

Data sources:

| Segment | Source |
|---|---|
| model / branch / Context | stdin snapshot + `git status --porcelain` (150ms timeout) |
| TPS / TTFT / thinking / goal | incremental parsing of `step.end` events, `config.update` and `goal.*` ops in `~/.kimi-code/sessions/*/session_<id>/agents/main/wire.jsonl` (legacy `ses_<id>` also supported) (byte offset persisted in `~/.kimi-code-hud/metrics-<sessionId>.json`; only new bytes are read each second) |
| quota (5h/wk) | `GET https://api.kimi.com/coding/v1/usages`, cached 60s in `~/.kimi-code-hud/quota.json`; when stale, the hot path renders the stale cache and spawns a detached background refresh — never blocking. Rendered and refreshed only while the active model belongs to `managed:kimi-code` (resolved from the session log's `modelAlias` via the `provider` key of the matching `config.toml` model table; undetermined → keep showing); the cache is deleted when the credentials are gone (`/logout`) |

### Privacy & security

The access token is **read locally** from `~/.kimi-code/credentials/kimi-code.json` (Kimi Code CLI renews it; this tool never writes it) and is only used to call the official `api.kimi.com` quota endpoint. It is never written to logs, caches or output.

### FAQ

**Nothing changed?** Make sure you ran `/reload-tui` or restarted; check `echo '{}' | node bin/kimi-hud.mjs` prints a line.

**No TPS segment?** A fresh session, a model change, or a TPS gap longer than 2 minutes requires 3 new valid `step.end` samples. TTFT appears on its own during warmup. If TTFT is also absent, this session has not completed a `step.end` yet.

**No quota segment?** First check whether the active model comes from a third-party provider (models added via `/provider` never show quota — the API covers the managed subscription only). For managed models, the whole section is omitted until the first cache exists (no "loading" placeholder). Run `node bin/kimi-hud.mjs --refresh-quota` (silent) and check `~/.kimi-code-hud/quota.json`.

**Which layouts show the Context segment?** Only full carries the bar, percentage and token counts; compact/normal omit it — read the host-drawn line 2 (`context: N% (tokens/max)`), which can never be taken over by a plugin.

## Development

```bash
npm test        # node --test 'test/**/*.test.mjs'
```

MIT © 2026 FinbackYu
