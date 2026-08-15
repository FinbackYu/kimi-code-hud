# HUD capabilities

- Last verified: 2026-08-14
- HUD behavior baseline: `v0.7.0 + Unreleased`
- Kimi Code baseline: `0.36.0` (`b6144f94ea6b22455a4e750d1750d220987e7bc2`)

This is the canonical inventory of footer coverage, readable data, and
information that the HUD can already derive but does not currently render.
Open parity gaps and their acceptance criteria live in
[KNOWN_ISSUES.md](KNOWN_ISSUES.md).

Upstream references are pinned to the audited commit so a later `main` change
cannot silently change the baseline:

- [footer slots and rendering](https://github.com/MoonshotAI/kimi-code/blob/b6144f94ea6b22455a4e750d1750d220987e7bc2/apps/kimi-code/src/tui/components/chrome/footer.ts)
- [`status_line.command` payload](https://github.com/MoonshotAI/kimi-code/blob/b6144f94ea6b22455a4e750d1750d220987e7bc2/apps/kimi-code/src/tui/utils/status-line-command.ts)
- [Git status model](https://github.com/MoonshotAI/kimi-code/blob/b6144f94ea6b22455a4e750d1750d220987e7bc2/apps/kimi-code/src/utils/git/git-status.ts)
- [persisted wire record manifest](https://github.com/MoonshotAI/kimi-code/blob/b6144f94ea6b22455a4e750d1750d220987e7bc2/packages/agent-core-v2/docs/wire-manifest.d.ts)
- [built-in slash-command registry](https://github.com/MoonshotAI/kimi-code/blob/b6144f94ea6b22455a4e750d1750d220987e7bc2/apps/kimi-code/src/tui/commands/registry.ts)

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

Baseline delta (0.33.0 → 0.34.0):

- The `status_line.command` payload/runner contract, footer slot order, and the
  Git status model are unchanged (`footer.ts` and `status-line-command.ts` are
  untouched in the release range).
- Wire additions are all optional: `subagent.spawned` and agent task info carry
  optional `model` / `thinkingEffort`, `mcp.server.status` gains a `removed`
  state, and `image_source` gains an optional `id`. The records HUD reduces
  (`turn.*`, `step.end`, `llm.request`, `config.update`, `goal.*`,
  `swarm_mode.*`, `full_compaction.*`, `task.started` / `task.terminated`) are
  unchanged, so HUD parsers stay wire-compatible.
- Session metadata gains an optional `lastTurnReason`, and REST session status
  makes `max_context_tokens` optional; neither is consumed by the HUD.
- The v2 engine stays the default; `SessionStart` external hooks and
  main-agent `wire.jsonl` journal persistence are unchanged.

Baseline delta (0.34.0 → 0.35.0):

- The status-line payload, first-stdout-line contract, 300ms timeout, footer
  line ownership, and HUD-reduced wire records are unchanged.
- The host hardens its pre-trust Git and GitHub CLI probes by resolving bare
  commands through PATH to absolute paths and refusing workspace-local hits.
  HUD now applies the same boundary to its synchronous `git status` probe.

Baseline delta (0.35.0 → 0.36.0):

- The status-line payload and runner contract remain the same 10 fields, first
  stdout line, and 300ms ceiling; footer line 2 remains host-owned.
- The persisted manifest adds `plugin.session_start { content: string | null }`.
  HUD treats it as an unknown row, does not retain `content`, and locks that
  boundary with an adversarial-content regression test.
- Experimental subagent model pools can put nonzero usage from different
  providers in one all-agent ledger. A provider Session Cost now fails closed
  for mixed or unresolved ledgers instead of silently pricing only the active
  provider's subset.
- The experimental fullscreen TUI does not alter the static status-line
  contract. Interactive fullscreen rendering remains a manual verification
  gap tracked as KI-8; it is not claimed as dynamically tested here.

## Footer coverage

Legend: **covered** means the state is reconstructed end to end; **variant** is
an intentional presentation choice; **degraded** loses useful upstream detail;
**missing** is an open parity gap; **host-owned** remains on footer line 2 and
does not need to be redrawn by the command.

| Official line-1 slot or state | Upstream 0.36.0 | HUD v0.7.0 + Unreleased | Status |
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
built into Kimi Code 0.36.0. HUD installation, configuration, and lifecycle
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
| DeepSeek API balance and cost | use a supported model whose provider is exactly `deepseek`, configured against official `api.deepseek.com` with an API key | account-currency output such as `DeepSeek Balance ¥N.NN · Session Cost ≈¥N.NN`; `DeepSeek Session Cost ≈¥N.NN` when balance is unavailable but CNY is known; stale balance alone is dimmed | available, automatic; CNY / USD official tables selected from the balance response; cache hits are conservatively priced as misses until the host maps DeepSeek's cache field |
| OpenAI / Anthropic API cost | use a supported model through the official direct API; no admin credential is required | `OpenAI Session Cost ≈$N.NN` / `Anthropic Session Cost ≈$N.NN`, including main and all subagents when every nonzero ledger row belongs to that provider | available, automatic; mixed-provider or unresolved ledgers hide the whole estimate rather than undercounting; local standard-price estimate, not balance or server bill |
| layout | set `{"layout":"normal"}` or `{"layout":"compact"}` in `~/.kimi-code-hud/config.json`, or set `KIMI_HUD_LAYOUT` | normal or compact field set | available |
| color and theme | set `NO_COLOR=1` or `KIMI_HUD_NO_COLOR=1`; optionally set `KIMI_HUD_THEME=dark\|light` | plain text or the selected ANSI palette | available |

`--refresh-quota` and `--refresh-provider-usage` are troubleshooting/internal
commands; normal quota and provider-usage refreshes do not require invoking
them manually.

Provider-usage labels use the full official brand and an unabridged metric
name. `Balance` means the provider-reported amount currently available. A
cost field must name its scope: `Session Cost ≈` for a local estimate,
or `Today Spent` / `Month Spent` / `Total Spent` when the provider reports that
exact server-side window. Bare `Cost`, `Bal`, `Sub`, and a generic `API` tag are
not display contracts. Subscription sources instead use the product name plus
their real quota window, such as `Kimi Code 5h 31%`.

## Readable but not rendered

The entries below are implementation inputs or future capabilities, not
supported user-facing interfaces. There is currently no stable CLI or API for
querying them. Persisted metrics files and Kimi wire records may be inspected
for development and debugging, but their on-disk shape must not be treated as a
public contract.

| Source | Available information | Current use | Unexposed capability / constraint |
|---|---|---|---|
| status-line payload | full cwd, context ratio, current/max context tokens, session ID, host version | model/mode/cwd/branch display; session ID locates wire data; Context stays on host line 2; host version persists into metrics state for compatibility gating | host version is available for diagnostics; full cwd is deliberately shortened; context values follow `[token_counting]` strategy; duplicating Context on line 1 adds little value |
| `step.end.usage` | `inputOther`, `inputCacheRead`, `inputCacheCreation`, `output` per model step | output + stream duration derive TPS; the three input fields derive Cache | not added to the cost ledger because `usage.record` duplicates the same request usage with a model identity |
| Cache reducer state | exact session-cumulative `readTokens` and `inputTokens` plus their ratio | renders only rounded `Cache N%` | exact `Cache N% (read/input)` is available without new wire parsing; token counts were removed with the full layout in HUD 0.6.0 |
| `usage.record` | the same four usage counters, model, and optional session/turn scope | a dedicated all-agent cursor accumulates model-scoped session totals for supported DeepSeek / OpenAI / Anthropic local cost estimates | cursor and content-free counters persist; the estimate remains hidden until every visible wire is caught up and every nonzero row belongs to the active provider, and must never also add duplicate `step.end` usage |
| per-agent wires | per-agent TPS samples, TTFT, request/turn timestamps, and agent directory identity | aggregates fleet total, contributing-agent count, average, and median TTFT | an expanded/debug view could expose per-agent rows; the one-line footer should stay aggregated |
| goal records | objective, criterion, status/reason, turns, tokens, elapsed time, and turn/token/time budgets | status, elapsed time, turns, and turn budget | numeric token/time budget progress is readable with a reducer extension; objective, criterion, and reasons are content and should not enter the footer by default |
| task records | task ID, kind, status, timestamps, timeout, plus kind-specific process/agent details | the two running counts (`tasks.bash` / `tasks.agents`) | command, PID, description, subagent type, stop reason, and output tail stay out of the footer; they belong in task/debug views |
| `subagent.spawned` model fields | display-normalized model alias and effective thinking effort per subagent (optional, added upstream 0.34.0) | not rendered | deliberately not shown: the footer stays aggregated, consistent with the fleet-speed presentation; a task/debug view could expose per-subagent model and effort |
| compaction records | begin/end timing; compaction records also carry message counts and summaries | live and last compaction duration | compaction count/message count could support diagnostics; summaries are content and should remain hidden |
| Git commands | diff stats, upstream divergence, PR number and URL | dirty boolean only | the data is available locally, but safe collection requires persistent TTL caches and async PR lookup |
| quota cache | exact `used`, `limit`, `resetAt`, and `fetchedAt` for short and weekly windows | percentage, bar, and reset countdown | exact units and cache freshness are available for a detail/debug surface; do not relabel subscription quota as token billing or API balance |
| provider-usage cache | provider, one-way SHA-256 credential fingerprint, `fetchedAt`, availability, and normalized currency balances | DeepSeek balance fact; it composes with the independent local Session Cost fact, and only stale balance text is dimmed | only the active credential's cache is read; API keys never enter cache, filenames, logs, or output |
| model/profile config | model alias, provider, provider base URL/API key, thinking effort; potentially profile/tool metadata | provider gates Kimi quota; exact DeepSeek provider plus official base URL selects both its balance adapter and local pricing contract; official direct OpenAI/Anthropic base plus model ID selects a local pricing contract; thinking suffix | DeepSeek credentials are read only inside its balance adapter; local cost estimation sends no credential; provider/profile remain available for non-secret diagnostics |
| upstream tip table | tip text, priority, solo/pair behavior | unused | it can be copied only with an explicit sync/drift strategy; it is not present in payload or wire data |

## Token meanings

"Token statistics" is not one number. Any future component must name its layer:

| Layer | Meaning | Current visibility |
|---|---|---|
| context occupancy | tokens currently occupying the model context window | exact current/max values on host line 2; the reported value follows `[token_counting]` strategy (`measured+estimated` default / `measured` / `estimated`, overridable via `KIMI_TOKEN_COUNTING_STRATEGY`) |
| cache ratio counts | cached input tokens divided by all input tokens counted for the session | ratio displayed; exact numerator/denominator retained but hidden |
| model usage | cumulative input split and output tokens across model requests | accumulated by model across main and all subagents; rendered only as supported DeepSeek / OpenAI / Anthropic `Session Cost ≈` when the complete nonzero ledger belongs to one provider |
| goal usage | tokens charged while a goal is live, optionally against a goal token budget | persisted in goal updates; not reduced by the HUD |
| subscription quota | provider-defined Kimi Code usage windows | percentage/reset displayed; not token billing and not API spend |
| API balance | provider-reported prepaid monetary balance for the active API credential | DeepSeek balance displayed as currency, never as a quota percentage |
| API cost estimate | local standard-price calculation over all-agent session model usage | DeepSeek / OpenAI / Anthropic `Session Cost ≈`; mixed-provider or unresolved ledgers fail closed, may compose with an independent balance fact, excludes provider-side adjustments, and never claims to be balance or final billing |

Before exposing a token value, decide whether it is per step, turn, session,
goal, model, main agent, or all agents. Do not combine those scopes under an
unqualified `Tokens` label.
