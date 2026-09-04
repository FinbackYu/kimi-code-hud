# kimi-code-hud

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![GitHub release](https://img.shields.io/github/v/release/FinbackYu/kimi-code-hud)](https://github.com/FinbackYu/kimi-code-hud/releases)

[中文](README.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/FinbackYu/kimi-code-hud/issues)

![HUD state gallery (stacked for showcase; only the first line renders in real use)](docs/media/hud-states.png)

A custom status line (HUD) for the [Kimi Code CLI](https://www.kimi.com/) — a zero-dependency Node.js script that shows model & thinking effort, git branch, generation speed (TPS / TTFT), compaction timers, session cache hit rate, Kimi managed-subscription usage, and supported third-party provider balances or session-cost estimates in the TUI footer. Every render finishes within 300ms and all errors degrade silently — the TUI is never blocked.

## Install

Requires Node.js ≥ 18 (global `fetch`). Zero npm dependencies.

In the Kimi Code TUI, run:

```
/plugins install https://github.com/FinbackYu/kimi-code-hud
```

- **Restart or start a new session** to activate: the plugin's `SessionStart` hook points `tui.toml`'s `[status_line]` at the plugin's managed copy and repairs that entry on every session start;
- Toggle: select it in the `/plugins` panel and press `Space`, or run `/plugins disable kimi-code-hud` / `/plugins enable kimi-code-hud`;
- If you already configured your own `[status_line]` command, the hook leaves it untouched;
- **Update**: run the install command again — the managed copy is replaced in place and the status line picks up the new version within ~1 second.

## Configuration

The HUD keeps its own settings in `~/.kimi-code-hud/config.json` (JSON; unknown keys are tolerated, and a missing or malformed file falls back to the defaults wholesale). The environment variable of the same setting wins over the config file.

### config.json

| Key | Values | Default | Meaning |
|---|---|---|---|
| `layout` | `"normal"` / `"compact"` | `normal` | Layout tier; lines wider than 200 visible characters degrade normal→compact automatically |
| `permissionNames` | `"official"` / `"short"` | `official` | Permission badge wording. `official` mirrors the host's 0.40+ display names (`[Always Ask]` / `[Ask When Needed]` / `[Never Ask]`); `short` keeps the compact badges (`[manual]` / `[yolo]` / `[auto]`). Unknown values fall back to the default |
| `disabled` | `true` | (absent = enabled) | The disable flag. No need to edit it by hand |

```json
{ "layout": "normal", "permissionNames": "official" }
```

### Environment variables

| Variable | Values | Meaning |
|---|---|---|
| `KIMI_HUD_LAYOUT` | `normal` / `compact` | Layout override; wins over the config file |
| `KIMI_HUD_PERMISSION_NAMES` | `official` / `short` | Permission badge wording override; wins over the config file |
| `KIMI_HUD_THEME` | `dark` / `light` / `auto` | Pin the color theme; by default follows the top-level `theme` in `tui.toml` |
| `NO_COLOR` / `KIMI_HUD_NO_COLOR` | presence | Disable all ANSI colors |
| `KIMI_HUD_HOME` | directory | Override the HUD's own config and cache root (default `~/.kimi-code-hud`) |
| `KIMI_CODE_HOME` | directory | Override the Kimi Code data root (default `~/.kimi-code`; every `~/.kimi-code` path in this README means this default) |

With `KIMI_HUD_THEME=auto` (or unset with no host `theme`) the palette is resolved from `COLORFGBG` with a dark fallback — a status line can't run the host's OSC 11 query on the 300ms hot path; custom theme names fall back to dark. On light, badges (model name, `[plan]`, `[Ask When Needed]`, `[swarm]`, `[tower]`, `[Never Ask]`) render bold, the amber/teal are brighter than the host defaults (`#D97706`/`#14B8A6`), and the quota bars use calmer truecolor hues (`#B91C1C`/`#D97706`/`#0E7A38`) instead of glaring ANSI red. Dark mode is unchanged: bars keep terminal-remapped ANSI colors.

### Permission badges

- Official wording (default): `[Always Ask]` (manual — faded primary blue, dark `#54658A` / light `#7D92B8`, quieter than the default foreground and always present so the left edge stays put), `[Ask When Needed]` (yolo — amber, matching the host), `[Never Ask]` (auto — bright red, for contrast with the amber);
- `short` wording renders `[manual]` / `[yolo]` / `[auto]` with the same color rules.

## Temporary off / uninstall

To fall back to the built-in status line temporarily: `/plugins disable kimi-code-hud`, and `/plugins enable kimi-code-hud` to restore it.

Uninstall: `/plugins remove kimi-code-hud` — the managed copy clears its own `tui.toml` entry on its next run. **`/reload-tui` or a new session applies the change** (the host replays the last custom frame meanwhile).

## Segment details

The precise rules per segment (sample acceptance, wire derivation paths, fail-closed boundaries, persisted files) live in [CAPABILITIES.md](CAPABILITIES.md). Highlights:

- Speed samples only accept `step.end` rows with ≥250ms of streaming and ≤1000 t/s; the median covers at most the freshest 5 samples within 10 minutes — warmup and expired windows render dimmed, and a model change restarts the warmup;
- Model/thinking prefers the wire (`profile.bind` plus every request's `llm.request`); without wire rows it is pinned by the per-session snapshot `~/.kimi-code-hud/sessions/thinking-<sessionId>.json`, and only then falls back to `config.toml` (writing the snapshot) — so another session running `/effort` never bleeds into this one;
- goal / swarm / tower states are folded from the main agent wire's `goal.*` / `swarm_mode.*` / `tower_mode.*` events; background-task badges merge `task.started` / `task.terminated` ops with the `tasks/<taskId>.json` sidecars (fresher record wins) and count `running` only (with the resumed-subagent exception for a `lost` mark followed by fresh writes — upstream issue MoonshotAI/kimi-code#3350);
- Quota renders and refreshes only for models attributable to `managed:kimi-code`; provider balances/costs fail closed on unknown currency, custom proxies, unknown models, or mixed-provider ledgers;
- Session cost is computed locally against the official price tables checked on **2026-08-09**, always `≈` (no server-side tool fees, taxes, or discounts); DeepSeek cache-hit tokens are conservatively priced as misses until the host maps that field, so its estimate can run high;
- Usage coloring: <60% green / <85% yellow / ≥85% red; lines wider than 200 visible characters degrade normal→compact automatically.

## How it works

Once per second the host pipes a JSON snapshot to stdin (capped at 1 MiB with a 150ms timeout), the **first line** of the command's stdout takes over footer line 1 (line 2 is always drawn by the host and cannot be taken over), and the command must finish within **300ms**; on failure/timeout/empty output the host renders the built-in line or replays the last good frame — so the script degrades silently on every error path and never logs anything (the single deliberate non-zero exit is the managed copy of a disabled/removed plugin stripping its own `tui.toml` entry, which is how the on/off switch works).

Four data sources: the stdin snapshot and a cross-process cached Git probe (cwd stored only as a SHA-256, 15s TTL); incremental parsing of the session's `wire.jsonl` files (main + every subagent, content-free, cursors and counters persisted under `~/.kimi-code-hud/sessions/`, where files written by earlier versions migrate automatically the next time their session is touched; session state idle for over 30 days and orphaned `*.tmp-*` temporaries from killed processes are swept once a day by the SessionStart hook); the official `/usages` quota API (60s cache plus detached background refresh, dual-region via the oauth host); and provider official balance APIs with locally priced cost estimates (cached isolated by provider + key fingerprint).

## Capabilities & known issues

- [Capabilities](CAPABILITIES.md): coverage of Kimi Code 0.40.1's line-1 slots, data sources, and readable-but-unrendered Cache/token/goal/task/Git information;
- [Known issues](KNOWN_ISSUES.md): open Git, terminal-width, stale-frame, and fullscreen verification gaps with acceptance criteria.

## Privacy & security

- The Kimi access token is read locally from `~/.kimi-code/credentials/` (the CLI renews it; this tool never writes it) and is only used for the official `api.kimi.com` / `api.kimi.ai` quota endpoints; the DeepSeek API key is read only when both the provider name and base URL select official `api.deepseek.com`, and only hits the fixed official balance endpoint;
- Neither credential is written to logs, caches, or output; provider-usage caches contain only a one-way SHA-256 fingerprint and normalized balance facts;
- All dynamic display text is stripped of OSC, CSI, and C0/DEL/C1 control characters before the HUD adds its own ANSI styling; HUD-generated sequences bypass that sanitizer;
- Session cost is computed entirely locally without an extra API-key request; the persisted ledger contains only model aliases and four token counters, never session content.

## FAQ

**Nothing changed?** Make sure you ran `/reload-tui` or restarted; check `echo '{}' | node ~/.kimi-code/plugins/managed/kimi-code-hud/bin/kimi-hud.mjs` prints a line.

**No TPS segment?** Only one state hides TPS entirely: no valid `step.end` sample yet (a brand-new session mid-first-step — TTFT shows on its own meanwhile). Warmup with fewer than 3 samples, an expired window, and a model change all render a muted provisional reading or the last median; normal brightness resumes at 3 valid samples. If TTFT is also absent, this session has not completed a `step.end` yet.

**No Cache segment?** It stays omitted only while the session has no complete `step.end` usage yet. Once the first valid usage lands, the segment appears and stays on permanently. After upgrades, a bounded restoration (at most 1 MiB of the wire tail) rebuilds the cumulative counters once.

**No quota segment?** First check whether the active model comes from a third-party provider (models added via `/provider` never show quota — the API covers the managed subscription only) and whether its model config resolves explicitly to `managed:kimi-code`; an unknown provider fails closed. For managed models, the whole section is omitted until the first cache exists. Run `node ~/.kimi-code/plugins/managed/kimi-code-hud/bin/kimi-hud.mjs --refresh-quota` (silent) and check `~/.kimi-code-hud/quota.json`.

**No DeepSeek balance or Session Cost?** The active supported model must use a provider named `deepseek`, `type = "openai"`, and the official `https://api.deepseek.com` base (optionally `/v1`). Balance additionally requires a valid `api_key`. Before the first detached refresh finishes, neither balance nor cost has a loading placeholder (cost must first learn CNY or USD from the balance response). Once the complete usage ledger is ready, Session Cost can appear alone even when balance is unavailable if its currency is known. Run `node ~/.kimi-code/plugins/managed/kimi-code-hud/bin/kimi-hud.mjs --refresh-provider-usage deepseek` silently and then inspect `~/.kimi-code-hud/provider-usage/`. Compatible proxies are intentionally refused for both.

**No DeepSeek / OpenAI / Anthropic Session Cost?** The active model must use the corresponding official direct service and a model ID in the built-in price table. No partial number is shown before all wires catch up; if the same session contains nonzero usage from another provider or an unresolved model, the whole estimate hides. This is a local estimate for the current session, not an API balance and not a ChatGPT / Claude subscription allowance.

**Where did the Context segment go?** The plugin no longer draws its own Context segment — read the host-drawn line 2 (`context: N% (tokens/max)`), which can never be taken over by a plugin.

## Development

```bash
npm test        # node --test
```

## License

Released under the [MIT License](LICENSE). © 2026 FinbackYu
