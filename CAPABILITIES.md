# HUD capabilities

- Last verified: 2026-09-04
- HUD behavior baseline: `v0.8.2` (`ae66403`)
- Kimi Code baseline: `0.40.1` (`0d45dddc57510e6b1306dd12c0b0703c37b8c63a`)

This is the canonical inventory of footer coverage, readable data, and
information that the HUD can already derive but does not currently render.
Open parity gaps and their acceptance criteria live in
[KNOWN_ISSUES.md](KNOWN_ISSUES.md).

Upstream references are pinned to the audited commit so a later `main` change
cannot silently change the baseline:

- [footer slots and rendering](https://github.com/MoonshotAI/kimi-code/blob/0d45dddc57510e6b1306dd12c0b0703c37b8c63a/apps/kimi-code/src/tui/components/chrome/footer.ts)
- [`status_line.command` payload](https://github.com/MoonshotAI/kimi-code/blob/0d45dddc57510e6b1306dd12c0b0703c37b8c63a/apps/kimi-code/src/tui/utils/status-line-command.ts)
- [Git status model](https://github.com/MoonshotAI/kimi-code/blob/0d45dddc57510e6b1306dd12c0b0703c37b8c63a/apps/kimi-code/src/utils/git/git-status.ts)
- [persisted wire record manifest](https://github.com/MoonshotAI/kimi-code/blob/0d45dddc57510e6b1306dd12c0b0703c37b8c63a/packages/agent-core-v2/docs/wire-manifest.d.ts)
- [built-in slash-command registry](https://github.com/MoonshotAI/kimi-code/blob/0d45dddc57510e6b1306dd12c0b0703c37b8c63a/apps/kimi-code/src/tui/commands/registry.ts)

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

Baseline delta (0.36.0 → 0.36.1):

- The status-line payload, first-line stdout contract, 300ms host ceiling,
  footer ownership, persisted wire manifest, provider/usage/goal structures,
  and plugin manifest remain unchanged.
- Nested subagent task metadata is additive: task information gains optional
  `agentId`, `subagentType`, and `parentToolCallId`, while KAP `/tasks` exposes
  `agent_id`, `subagent_type`, and `parent_tool_call_id`. HUD task badges still
  consume only `taskId`, `kind`, and `status`, so the counts remain compatible.
- New `event.plugin.changed` / `event.capability.changed` event variants and
  independent approval/question IDs are ignored by the HUD's known-event
  reducers. Background task previews are sanitized upstream before display.
- Experimental automatic session titles are default-off and outside the HUD
  contract; the HUD does not consume or persist session titles.

Baseline delta (0.36.1 → 0.37.2):

- The status-line payload, first-line stdout contract, 300ms host ceiling,
  and footer line ownership are unchanged. Footer line 2 gains a longer-lived
  `warningHint` shown only when no transient hint is active; line 2 remains
  host-owned.
- The persisted wire manifest drops five transient record types (`cron.*`,
  `permission.rules.add`, `skill.activate`) and adds durable `prompt.accepted`,
  `runtime.set_binding`, and `tower_mode.enter` / `tower_mode.exit`. HUD
  reducers gate on known types; this 0.39.0 prep branch now folds the Tower
  pair and renders `[tower]`, while every other addition remains ignored.
- Durable wire records now always carry a `time` stamp; HUD reducers already
  read `time` defensively, so the change is additive.
- agent-core-v2 rewired its journal internals from op-based Models to
  Event2/defineState. The on-disk wire format, session layout, quota endpoint,
  plugin manifest, and hook payloads are unchanged.

Baseline delta (0.37.2 → 0.38.0):

- The `status_line.command` payload/runner contract, the first-stdout-line
  contract, the 300ms host ceiling, footer line ownership, and the Git status
  model are unchanged; `footer.ts`, `status-line-command.ts`, and
  `git-status.ts` are byte-identical across the release range.
- The persisted wire manifest grows from 48 to 55 record types: `cron.add`,
  `cron.cursor`, `cron.delete`, `staleGuard.recorded`, `staleGuard.cleared`,
  `task.waitDelivered`, and `token_counting.turn_recorded` are new, and every
  durable record now carries a required `agentId` (the host backfills it when
  replaying older journals; `WIRE_PROTOCOL_VERSION` stays 1.5). HUD reducers
  read known fields and ignore the additions, so wire parsing stays
  compatible.
- Failed or interrupted steps now also persist a `step.end` record, but
  without `usage`, `llmFirstTokenLatencyMs`, or `llmStreamDurationMs`. The
  HUD gates — TPS requires nonzero `output` and a valid stream duration,
  cache-hit requires all four usage fields, turn requires `finishReason ===
  'end_turn'` — filter these rows, so no statistic is polluted; only
  `lastStepEndAt` updates early for a failed step, which makes the last-step
  presentation more accurate and is recorded as a variant.
- Quota: the managed usages endpoint for mainland-cn is unchanged
  (`https://api.kimi.com/coding/v1/usages`), and 0.38.0 adds a global region
  (`https://api.kimi.ai/coding/v1/usages`, with credentials persisted in a
  scoped slot `credentials/kimi-code-env-<16 hex>.json` via
  `packages/oauth/src/region.ts` / `managed-kimi-code.ts`). Shipped in HUD
  v0.7.3, the detached `--refresh-quota` path now
  resolves the region (env `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`, then
  the `[providers."managed:kimi-code"]` `oauth` sub-table and `base_url` in
  config.toml, then the mainland default), derives the credential file from
  the persisted `oauth.key`, and sends the token only to the two official
  hosts, failing closed on any custom or mismatched configuration. The
  render hot path is unchanged, and `quota.json` carries no account,
  credential-slot, or endpoint tag. After an account or region switch, the
  previous cache may continue to render; the 60s TTL marks it stale and
  schedules refresh but does not evict it. A successful refresh replaces the
  value, while repeated 401/403 responses with a remaining `refresh_token`
  may preserve the stale value beyond one TTL.
- The `SessionStart` hook, plugin manifest, `KIMI_CODE_HOME` resolution, and
  credentials directory layout are unchanged; upstream only moved internal
  modules between packages.

Baseline delta (0.38.0 → 0.39.0):

- The `status_line.command` payload/runner contract is unchanged: the 300ms
  host ceiling, 1s rerun interval, and 64KB capture budget are the same, and
  the payload still carries no `towerMode` field. The wire event set stays at
  55 record types with no renames, so HUD reducers need no rework for the
  events.
- Tower became a first-class orchestration mode (`/tower`, PR #3099) behind
  the experimental `KIMI_CODE_EXPERIMENTAL_TOWER` flag (off by default). The
  durable `tower_mode.enter` / `tower_mode.exit` records carry a required
  `agentId`, and `enter` gains an optional `sessionId`, which the HUD ignores
  while keeping the boolean last-enter/exit-wins fold over both Tower records
  and the upstream `tower` / `tower.owner` state keys (`tower.owner` is not
  itself a wire record); it renders the `[tower]` accent badge (covered, verified
  end to end against a live 0.39.0 `/tower` session). The
  host `AppState` exposes `towerMode`, but the status-line payload does not
  carry it, so it stays host-owned and is not drawn by the command. A one-time
  bounded projection upgrade re-scans existing main-wire history so a resumed
  Tower session is not stuck off because an older HUD cursor passed the enter
  row; sessions with no Tower records keep the prior badge (`towerMode`
  defaults false).
- Concurrent `subagent_fork` (PR #3007, `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK`,
  off by default) forks subagents that keep the ordinary session layout
  (`agents/<id>/wire.jsonl`) and report task `kind` as `agent`; session
  discovery and usage enumeration are unaffected (covered).
- The shared protocol `taskSchema` adds optional `parent_tool_call_id` and
  `run_in_background`, and KAP REST adds `POST /tasks/{id}:detach`; both are
  host-owned and not consumed by the HUD.
- `--allow-remote-terminals` was removed; it is a host security surface with no
  HUD dependency.

Baseline delta (0.39.0 → 0.39.1):

- The `status_line.command` payload/runner contract, first-stdout-line
  contract, 300ms host ceiling, footer line ownership, Git status model, and
  persisted wire manifest are unchanged; `status-line-command.ts`, the footer,
  and `wire-manifest.d.ts` are untouched in the release range, so HUD reducers
  need no rework.
- Additive upstream changes are all outside HUD consumption: `turn.started`
  prompt attachments gain an optional `file` variant, a global
  `event.config.warning` push and kap-server `event.config.changed` fan-out
  were added on the WebSocket side, and the shared REST `GET /v1/auth` summary
  renames `ready` to `models_ready` and drops `default_model`. The HUD parses
  no `promptAttachments`, consumes no WebSocket events, and does not call
  kap-server REST, so these are ignored rather than consumed.

Baseline delta (0.39.1 → 0.40.0):

- The `status_line.command` payload/runner contract is unchanged:
  `status-line-command.ts` is untouched in the release range and the payload
  keeps the same fields, so HUD parsing needs no rework.
- The persisted wire manifest grows from 55 to 60 record types: new
  `prompt.aborted` / `prompt.completed` / `prompt.steered` and
  `turn.step.interrupted` / `turn.step.retrying` records. HUD reducers gate on
  known types and ignore the new records; `usage.record`, `task.started`, and
  `task.terminated` payloads are unchanged (covered).
- `config.update` / `profile.bind` drop the optional
  `environmentDisclosure.date` subfield, and `turn.prompt` gains an optional
  `promptId`; the HUD folds read fixed field sets — it never read
  `environmentDisclosure` — so removals cannot surface and additions are
  ignored (covered).
- `plan.revision` renames `path` to `key`; the HUD folds no `plan.revision`
  rows (host-owned).
- `tower_mode.enter` gains an optional `base` field, tower mode becomes
  mutually exclusive with plan/swarm mode, and upstream tower workers now
  start from the base checkout's uncommitted changes. The HUD's
  last-enter/exit-wins boolean fold ignores the new field and keeps working
  (covered; the worker-checkout change is an upstream workflow fix with no
  HUD surface).
- The footer line-1 permission badge wording is now sourced from a new
  `permission-mode.ts` display table (`manual` → "Always Ask", `yolo` →
  "Ask When Needed", `auto` → "Never Ask"). The payload `permissionMode`
  values are unchanged; the HUD mirrors the official labels by default
  (`[Always Ask]` / `[Ask When Needed]` / `[Never Ask]`), with the historical
  short badges available via `KIMI_HUD_PERMISSION_NAMES=short` (covered;
  `short` is a HUD presentation variant, and the always-present manual badge
  renders in a faded primary blue (`#54658A` dark / `#7D92B8` light) so muted
  gray keeps its reserved inferred/degraded meaning).
- The shared protocol `sessionAgentConfigSchema` gains optional `tower_base`,
  kap-server REST adds workspace/skill/prompt routes, `kimi acp` no longer
  honors `KIMI_CODE_LEGACY_FLAG`, and the `[secondary_model]` subagent pool
  is enabled by default; none of these touch the status-line payload or the
  wire records the HUD folds (host-owned / not consumed).
- Upstream now parses `git status --porcelain` with `-z` for non-ASCII paths
  (PR #3415). The HUD's own dirty probe reads non-`-z` porcelain output but
  only derives a boolean from any non-`##` line, so quoted non-ASCII paths
  cannot flip it (verified, no HUD impact).

Baseline delta (0.40.0 → 0.40.1):

- The `status_line.command` payload/runner contract, the footer, the shared
  protocol, KAP WebSocket event schemas, and the task/subagent record shapes
  are all untouched in the release range, so HUD parsing needs no rework.
- The persisted wire manifest grows from 60 to 62 record types: new
  `file_history.checkpoint` / `file_history.tracked` records behind the
  experimental turn-level file history flag. HUD reducers gate on known types
  and ignore both records; their payloads carry only path/hash/size metadata,
  not file contents (covered).
- The agent state manifest drops the internal `agentsMdReminder.pending` key
  and adds a `fileHistory` key; no consumer reads agent state directly
  (host-owned).
- kap-server REST registers experimental file-history routes; the HUD calls
  no kap-server REST (host-owned).
- Other upstream fixes (AGENTS.md re-reminder after context loss, kimi-cli
  migration re-prompt, vscode engine-backed @ suggestions) sit outside HUD
  consumption (not consumed).

## Footer coverage

Legend: **covered** means the state is reconstructed end to end; **variant** is
an intentional presentation choice; **degraded** loses useful upstream detail;
**missing** is an open parity gap; **host-owned** remains on footer line 2 and
does not need to be redrawn by the command.

| Official line-1 slot or state | Upstream 0.40.1 | HUD main | Status |
|---|---|---|---|
| permission mode | `manual` has no badge; official naming "Always Ask" / "Ask When Needed" / "Never Ask"; `auto` / `yolo` use the warning color | Reads `permissionMode`; always shows a badge with the official labels by default (`short` opt-out), paints `[Never Ask]` red and `[Always Ask]` faded blue | covered, presentation variant |
| plan mode | `plan` in the mode slot | Reads `planMode` | covered, presentation variant |
| swarm mode | `swarm` in the mode slot | Rebuilds state from main-wire `swarm_mode.enter` / `swarm_mode.exit`; a future `payload.swarmMode` also works | covered since HUD 0.2.7 |
| tower mode | separate orchestration state | Rebuilds state from main-wire `tower_mode.enter` / `tower_mode.exit`; optional enter `sessionId` is metadata only; a future `payload.towerMode` also works | covered |
| goal | status, elapsed time, turns, optional turn budget | Rebuilds `goal.create` / `goal.update` / `goal.clear` / `forked`; renders a shortened badge — status lives on the goal word's color (active blue, blocked amber, paused muted), turns and optional turn budget kept, elapsed clock dropped | covered, presentation variant |
| model and thinking | display name plus `thinking` or `thinking: <effort>` | Uses payload model plus wire/config snapshot; renders bare effort (`K3 high`), muted while only config-inferred (pre-first-turn lazy start) until the wire confirms it | covered, presentation variant |
| background Shell | `[N task(s) running]` for running `process` / `bash-*` tasks | Reduces main-wire `task.started` / `task.terminated` and reconciles `tasks/<taskId>.json` sidecars; renders the same badge between model and cwd | covered — [KI-1](KNOWN_ISSUES.md#ki-1-background-task-badges-are-absent) closed |
| background Agent | `[N agent(s) running]` for running `agent` tasks | Same reducer; `agent` kind is counted and badged separately; a lost-then-resumed agent counts while its own wire stays fresh — [KI-15](KNOWN_ISSUES.md#ki-15-a-resumed-background-agent-was-invisible-to-the-task-badges) | covered — [KI-1](KNOWN_ISSUES.md#ki-1-background-task-badges-are-absent) closed |
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
built into Kimi Code 0.40.1. HUD installation, configuration, and lifecycle
commands are documented in [README.md](README.md#安装) and
[README.en.md](README.en.md#install).

| Capability | How to trigger or configure it | What the HUD shows | Availability |
|---|---|---|---|
| HUD lifecycle | install as described in the README; plugin installs use `/plugins disable kimi-code-hud` / `/plugins enable kimi-code-hud`, while manual installs use `node <checkout>/bin/kimi-hud.mjs --off` / `--on` | the complete HUD line when enabled | available |
| permission mode | use `/permission`, `/ask-when-needed` (alias `/yolo`), or `/never-ask` (alias `/auto`) | `[Always Ask]`, `[Ask When Needed]`, or `[Never Ask]` by default (`short` wording: `[manual]`, `[auto]`, `[yolo]`) | available |
| plan mode | use `/plan`, `/plan on`, or `/plan off` | `[plan]` while plan mode is active | available |
| swarm mode | use `/swarm`, `/swarm on`, `/swarm off`, or `/swarm <task>` | `[swarm]`; fleet speed appears when multiple agent wires contribute | available |
| tower mode | start the Tower workflow with `/tower` | `[tower]`; a parked main is excluded and live workers retain fleet-style speed | available behind the upstream experimental flag |
| goal lifecycle | start with `/goal <objective>`; inspect or manage with `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, or `/goal replace <objective>` | goal status as the badge word's color, turns, and optional turn budget | available |
| model and thinking | use `/model`; set thinking effort with `/effort` or its `/thinking` alias | model display name and thinking-effort suffix | available |
| TPS, TTFT, and generation time | run normal prompts; no separate command is required | live `gen` anchored at the latest user prompt (tower notification and goal-continuation turns never reset it), dimmed settled total afterwards; TPS and TTFT after enough valid samples exist | available, automatic |
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
| goal records | objective, criterion, status/reason, turns, tokens, elapsed time, and turn/token/time budgets | status (the goal word's color), turns, and turn budget | numeric token/time budget progress is readable with a reducer extension; elapsed time is no longer rendered, since the badge carries no clock; objective, criterion, and reasons are content and should not enter the footer by default |
| task records | task ID, kind, status, timestamps, timeout, plus kind-specific process/agent details | the two running counts (`tasks.bash` / `tasks.agents`) | command, PID, description, subagent type, stop reason, and output tail stay out of the footer; they belong in task/debug views |
| `subagent.spawned` model fields | display-normalized model alias and effective thinking effort per subagent (optional, added upstream 0.34.0) | not rendered | deliberately not shown: the footer stays aggregated, consistent with the fleet-speed presentation; a task/debug view could expose per-subagent model and effort |
| compaction records | begin/end timing; compaction records also carry message counts and summaries | live and last compaction duration | compaction count/message count could support diagnostics; summaries are content and should remain hidden |
| Git commands | diff stats, upstream divergence, PR number and URL | dirty boolean only, collected with a bounded cross-process 15-second per-cwd cache and `GIT_OPTIONAL_LOCKS=0` | full diff/upstream/PR parity still requires richer persistent facts and async PR lookup |
| quota cache | exact `used`, `limit`, `resetAt`, and `fetchedAt` for short and weekly windows | percentage, bar, and reset countdown | exact units and cache freshness are available for a detail/debug surface; do not relabel subscription quota as token billing or API balance |
| provider-usage cache | provider, one-way SHA-256 credential fingerprint, `fetchedAt`, availability, and normalized currency balances | DeepSeek balance fact; it composes with the independent local Session Cost fact, and only stale balance text is dimmed | only the active credential's cache is read; API keys never enter cache, filenames, logs, or output |
| model/profile config | model alias, provider, provider base URL/API key, thinking effort; potentially profile/tool metadata | an exact `managed:kimi-code` provider gates Kimi quota; unknown attribution hides all quota/provider usage; exact DeepSeek provider plus official base URL selects both its balance adapter and local pricing contract; official direct OpenAI/Anthropic base plus model ID selects a local pricing contract; thinking suffix | DeepSeek credentials are read only inside its balance adapter; local cost estimation sends no credential; provider/profile remain available for non-secret diagnostics |
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
