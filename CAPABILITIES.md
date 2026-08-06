# HUD capabilities

- Last verified: 2026-08-06
- HUD behavior baseline: `v0.6.4-2` (`77b108c`)
- Kimi Code baseline: `0.33.0` (`53c832dfdf9566afd59a8b3d54ebd36d3cb03d72`)

This is the canonical inventory of footer coverage, readable data, and
information that the HUD can already derive but does not currently render.
Open parity gaps and their acceptance criteria live in
[KNOWN_ISSUES.md](KNOWN_ISSUES.md).

Upstream references are pinned to the audited commit so a later `main` change
cannot silently change the baseline:

- [footer slots and rendering](https://github.com/MoonshotAI/kimi-code/blob/53c832dfdf9566afd59a8b3d54ebd36d3cb03d72/apps/kimi-code/src/tui/components/chrome/footer.ts)
- [`status_line.command` payload](https://github.com/MoonshotAI/kimi-code/blob/53c832dfdf9566afd59a8b3d54ebd36d3cb03d72/apps/kimi-code/src/tui/utils/status-line-command.ts)
- [Git status model](https://github.com/MoonshotAI/kimi-code/blob/53c832dfdf9566afd59a8b3d54ebd36d3cb03d72/apps/kimi-code/src/utils/git/git-status.ts)
- [persisted wire record manifest](https://github.com/MoonshotAI/kimi-code/blob/53c832dfdf9566afd59a8b3d54ebd36d3cb03d72/packages/agent-core-v2/docs/wire-manifest.d.ts)
- [built-in slash-command registry](https://github.com/MoonshotAI/kimi-code/blob/53c832dfdf9566afd59a8b3d54ebd36d3cb03d72/apps/kimi-code/src/tui/commands/registry.ts)

Baseline delta (0.32.0 → 0.33.0):

- The `status_line.command` payload/runner contract, footer slot order, and the
  Git status model are unchanged.
- The persisted wire manifest only adds optional fields
  (`environmentDisclosure`, `renderGeneration` on `config.update` /
  `profile.bind`); HUD reducers read known fields and ignore extras.
- The built-in registry adds `/bug` as a `/feedback` alias and rewords
  `/fork`; neither affects the HUD line.
- The v2 engine is the default and still fires `SessionStart` external hooks
  and persists the main-agent `wire.jsonl` journal.

## Footer coverage

Legend: **covered** means the state is reconstructed end to end; **variant** is
an intentional presentation choice; **degraded** loses useful upstream detail;
**missing** is an open parity gap; **host-owned** remains on footer line 2 and
does not need to be redrawn by the command.

| Official line-1 slot or state | Upstream 0.33.0 | HUD v0.6.4-2 | Status |
|---|---|---|---|
| permission mode | `manual` has no badge; `auto` / `yolo` use the warning color | Reads `permissionMode`; always shows `[manual]`, and makes `[auto]` red | covered, presentation variant |
| plan mode | `plan` in the mode slot | Reads `planMode` | covered, presentation variant |
| swarm mode | `swarm` in the mode slot | Rebuilds state from main-wire `swarm_mode.enter` / `swarm_mode.exit`; a future `payload.swarmMode` also works | covered since HUD 0.2.7 |
| goal | status, elapsed time, turns, optional turn budget | Rebuilds `goal.create` / `goal.update` / `goal.clear` / `forked` and renders the same lifecycle fields | covered |
| model and thinking | display name plus `thinking` or `thinking: <effort>` | Uses payload model plus wire/config snapshot; renders bare effort (`K3 high`) | covered, presentation variant |
| background Shell | `[N task(s) running]` for running `process` / `bash-*` tasks | Reduces main-wire `task.started` / `task.terminated` and reconciles `tasks/<taskId>.json` sidecars; renders the same badge between model and cwd | covered — [KI-1](KNOWN_ISSUES.md#ki-1-background-task-badges-are-absent) closed |
| background Agent | `[N agent(s) running]` for running `agent` tasks | Same reducer; `agent` kind is counted and badged separately | covered — [KI-1](KNOWN_ISSUES.md#ki-1-background-task-badges-are-absent) closed |
| cwd | home-aware path shortened to at most three segments | Normal shows only `basename(cwd)`; compact omits cwd | intentional degradation |
| Git | branch, diff `+N/-N` or `±`, ahead/behind, and linked PR number | Payload branch plus synchronous dirty check, rendered as `git:(branch*)` | degraded — [KI-2](KNOWN_ISSUES.md#ki-2-git-is-lower-fidelity-than-the-built-in-footer) |
| rotating tips | width-aware, weighted 10-second rotation | omitted | intentional omission |
| Context and transient hint | context percentage and exact current/max tokens; transient hint at left | still rendered by the host on line 2 | host-owned, preserved; the reported value follows `[token_counting]` strategy |

The two task rows share one implementation area (`src/metrics-tasks.mjs`).
They are not inferred from `metrics.activeAgents`: that value includes the
main agent and means "recently generating or holding an LLM request", not
"background agent task still running".

## How to use the displayed capabilities

The HUD is observational: once installed and enabled, it reacts to Kimi Code
state and does not define its own slash commands. The slash commands below are
built into Kimi Code 0.33.0. HUD installation, configuration, and lifecycle
commands are documented in [README.md](README.md#安装) and
[README.en.md](README.en.md#install).

| Capability | How to trigger or configure it | What the HUD shows | Availability |
|---|---|---|---|
| HUD lifecycle | install as described in the README; plugin installs use `/plugins disable kimi-code-hud` / `/plugins enable kimi-code-hud`, while manual installs use `node <checkout>/bin/kimi-hud.mjs --off` / `--on` | the complete HUD line when enabled | available |
| permission mode | use `/permission`, `/auto [on\|off]`, or `/yolo [on\|off]` | `[manual]`, `[auto]`, or `[yolo]` | available |
| plan mode | use `/plan`, `/plan on`, or `/plan off` | `[plan]` while plan mode is active | available |
| swarm mode | use `/swarm`, `/swarm on`, `/swarm off`, or `/swarm <task>` | `[swarm]`; fleet speed appears when multiple agent wires contribute | available |
| goal lifecycle | start with `/goal <objective>`; inspect or manage with `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, or `/goal replace <objective>` | goal status, elapsed time, turns, and optional turn budget | available |
| model and thinking | use `/model`; set thinking effort with `/effort` or its `/thinking` alias | model display name and thinking-effort suffix | available |
| TPS, TTFT, and generation time | run normal prompts; no separate command is required | live `gen`; TPS and TTFT after enough valid samples exist | available, automatic |
| compaction | use `/compact [instruction]`, or allow automatic compaction | live and most recent compaction duration | available, automatic |
| prompt-cache ratio | continue using the session normally; the first complete model-step usage record initializes it | rounded session-cumulative `Cache N%` | available, automatic |
| background tasks | start a background shell task or a detached subagent; no HUD action is required | `[N task(s) running]` and `[N agent(s) running]` between model and cwd | available, automatic |
| Git and cwd | run Kimi Code inside a Git worktree; branch/dirty state changes as the worktree changes | shortened cwd, branch, and dirty `*` | partial — [KI-2](KNOWN_ISSUES.md#ki-2-git-is-lower-fidelity-than-the-built-in-footer) |
| Context | no HUD action; Kimi Code owns footer line 2 | context percentage and exact current/max tokens remain on line 2 | available, host-owned; the value follows `[token_counting]` strategy |
| Kimi subscription quota | use a managed Kimi model with a valid Kimi Code login; refresh is automatic | short and weekly usage percentage, bar, and reset countdown | available, automatic |
| layout | set `{"layout":"normal"}` or `{"layout":"compact"}` in `~/.kimi-code-hud/config.json`, or set `KIMI_HUD_LAYOUT` | normal or compact field set | available |
| color and theme | set `NO_COLOR=1` or `KIMI_HUD_NO_COLOR=1`; optionally set `KIMI_HUD_THEME=dark\|light` | plain text or the selected ANSI palette | available |

`--refresh-quota` is a troubleshooting/internal command; normal quota use does
not require invoking it manually.

## Readable but not rendered

The entries below are implementation inputs or future capabilities, not
supported user-facing interfaces. There is currently no stable CLI or API for
querying them. Persisted metrics files and Kimi wire records may be inspected
for development and debugging, but their on-disk shape must not be treated as a
public contract.

| Source | Available information | Current use | Unexposed capability / constraint |
|---|---|---|---|
| status-line payload | full cwd, context ratio, current/max context tokens, session ID, host version | model/mode/cwd/branch display; session ID locates wire data; Context stays on host line 2; host version persists into metrics state for compatibility gating | host version is available for diagnostics; full cwd is deliberately shortened; context values follow `[token_counting]` strategy; duplicating Context on line 1 adds little value |
| `step.end.usage` | `inputOther`, `inputCacheRead`, `inputCacheCreation`, `output` per model step | output + stream duration derive TPS; the three input fields derive Cache | session/turn token totals need new persisted counters and an explicit main-only versus all-agent policy |
| Cache reducer state | exact session-cumulative `readTokens` and `inputTokens` plus their ratio | renders only rounded `Cache N%` | exact `Cache N% (read/input)` is available without new wire parsing; token counts were removed with the full layout in HUD 0.6.0 |
| `usage.record` | the same four usage counters, model, and optional session/turn scope | deliberately ignored | may support a model-scoped ledger or fallback, but must never be added to the duplicate `step.end` usage |
| per-agent wires | per-agent TPS samples, TTFT, request/turn timestamps, and agent directory identity | aggregates fleet total, contributing-agent count, average, and median TTFT | an expanded/debug view could expose per-agent rows; the one-line footer should stay aggregated |
| goal records | objective, criterion, status/reason, turns, tokens, elapsed time, and turn/token/time budgets | status, elapsed time, turns, and turn budget | numeric token/time budget progress is readable with a reducer extension; objective, criterion, and reasons are content and should not enter the footer by default |
| task records | task ID, kind, status, timestamps, timeout, plus kind-specific process/agent details | the two running counts (`tasks.bash` / `tasks.agents`) | command, PID, description, subagent type, stop reason, and output tail stay out of the footer; they belong in task/debug views |
| compaction records | begin/end timing; compaction records also carry message counts and summaries | live and last compaction duration | compaction count/message count could support diagnostics; summaries are content and should remain hidden |
| Git commands | diff stats, upstream divergence, PR number and URL | dirty boolean only | the data is available locally, but safe collection requires persistent TTL caches and async PR lookup |
| quota cache | exact `used`, `limit`, `resetAt`, and `fetchedAt` for short and weekly windows | percentage, bar, and reset countdown | exact units and cache freshness are available for a detail/debug surface; do not relabel subscription quota as token billing or API balance |
| model/profile config | model alias, provider, thinking effort; potentially profile/tool metadata | provider gates Kimi quota; thinking suffix | provider/profile are available for diagnostics; system prompts and tool policy details are sensitive/noisy |
| upstream tip table | tip text, priority, solo/pair behavior | unused | it can be copied only with an explicit sync/drift strategy; it is not present in payload or wire data |

## Token meanings

"Token statistics" is not one number. Any future component must name its layer:

| Layer | Meaning | Current visibility |
|---|---|---|
| context occupancy | tokens currently occupying the model context window | exact current/max values on host line 2; the reported value follows `[token_counting]` strategy (`measured+estimated` default / `measured` / `estimated`, overridable via `KIMI_TOKEN_COUNTING_STRATEGY`) |
| cache ratio counts | cached input tokens divided by all input tokens counted for the session | ratio displayed; exact numerator/denominator retained but hidden |
| model usage | cumulative input split and output tokens across model requests | available in wire rows; not accumulated as a public metric |
| goal usage | tokens charged while a goal is live, optionally against a goal token budget | persisted in goal updates; not reduced by the HUD |
| subscription quota | provider-defined Kimi Code usage windows | percentage/reset displayed; not token billing and not API spend |

Before exposing a token value, decide whether it is per step, turn, session,
goal, model, main agent, or all agents. Do not combine those scopes under an
unqualified `Tokens` label.
