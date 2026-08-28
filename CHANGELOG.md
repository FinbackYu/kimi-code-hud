# Changelog

All notable changes to this project are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.8.1] - 2026-08-28

### Fixed

- The gen timer no longer resets mid-run in tower mode: worker completions
  are delivered as their own main turns whose `turn.prompt` records carry
  `origin.kind: "task"`, and the timer previously re-anchored at every one of
  them while the parked gaps in between read as no turn at all — an
  83-minute tower run displayed barely the last notification's processing
  span. The timer now anchors at the user's latest prompt (only
  user-initiated origins move it; goal continuations no longer reset it
  either), stays live for the whole cascade — main turn open or any subagent
  still generating, parked-dispatch gaps included — and once everything
  settles, the dimmed total span holds the slot until the next user prompt
  ([KI-16](KNOWN_ISSUES.md#ki-16-tower-notification-turns-kept-resetting-the-gen-timer)).
- The background-agent badge no longer reads zero for a lost-then-resumed
  agent: when the host restarts and a lost background agent is resumed,
  upstream journals no fresh `task.started`, so the journal's latest state
  stayed `lost` for the whole resumed run while the built-in footer kept
  showing the agent. A merged `lost` record of kind `agent` now counts as
  running while its own `agents/<agentId>/wire.jsonl` shows a fresh post-lost
  write, with terminal records always winning (upstream:
  [MoonshotAI/kimi-code#3350](https://github.com/MoonshotAI/kimi-code/issues/3350);
  [KI-15](KNOWN_ISSUES.md#ki-15-a-resumed-background-agent-was-invisible-to-the-task-badges)).

## [0.8.0] - 2026-08-28

### Added

- Tower mode support for Kimi Code 0.39.0 (experimental, behind the upstream
  `KIMI_CODE_EXPERIMENTAL_TOWER` flag): the HUD rebuilds tower state from the
  main-wire `tower_mode.enter` / `tower_mode.exit` records (last record wins;
  the optional `sessionId` on enter is metadata only) and renders the
  `[tower]` accent badge; a main parked while its tower workers run drops out
  of the fleet head count and TPS total, while live workers keep the
  fleet-style speed. A one-time bounded backfill re-scan lights the badge for
  resumed tower sessions whose HUD cursor had already passed the enter
  record, and hosts without tower records render exactly as before. Verified
  end to end against a live 0.39.0 `/tower` session.

### Changed

- Advance the audited Kimi Code compatibility baseline from 0.38.0 to 0.39.0:
  the status-line payload/runner contract (300ms ceiling, 1s rerun interval,
  64KB capture budget) is unchanged and still carries no `towerMode` field,
  with the wire event set staying at 55 record types; Tower became a
  first-class `/tower` orchestration mode behind the experimental
  `KIMI_CODE_EXPERIMENTAL_TOWER` flag and `tower_mode.enter` gains an optional
  `sessionId`, which the HUD folds into the `[tower]` accent badge; concurrent
  `subagent_fork` (also experimental, off by default) keeps the ordinary
  session layout and `agent` task kind; the shared protocol `taskSchema` gains
  optional `parent_tool_call_id` / `run_in_background` and KAP REST adds
  `POST /tasks/{id}:detach` (both host-owned, not consumed by the HUD); and
  `--allow-remote-terminals` was removed.

### Fixed

- A main agent parked on a blocking tool call is now excluded from the fleet
  head count and TPS total even in a plain (non-orchestrated) single-`Agent`
  call, not just in swarm mode: the parked-main gate was previously keyed on
  `swarmMode`, so a foreground main blocked inside one `Agent` tool (a
  `tool_use` step whose `step.end` is journaled only when the tool returns)
  stayed counted while its `llm.request` looked in flight — showing
  `main+1 @ (main + agent)` for the whole wait. The discriminator is now an
  orchestration mode (swarm or tower) or an unfinished turn, and
  `waitingOnTool` is tightened to an unanswered `tool.call` (one whose
  `step.end` never lands); hosts that predate the `tool.call` journal keep
  the previous request-based reading.

## [0.7.8] - 2026-08-24

### Fixed

- Swarm mode now also drops a main agent parked inside a blocking tool call,
  not just one with no request in flight: a tool_use step's `step.end` is
  journaled only when the tool returns, so an AgentSwarm block kept main's
  `llm.request` looking in-flight — and the fleet head count at `main+N` —
  for the entire wait. The throughput reducer now folds `tool.call` rows per
  agent, and the fleet summary treats a main whose latest request is
  superseded by an unanswered `tool.call` as waiting rather than generating;
  hosts that predate the `tool.call` journal keep the previous request-based
  reading.

## [0.7.7] - 2026-08-23

### Changed

- Goal badge rework: shortened to `[goal 7 turns]` (`3/10 turns` when the
  goal carries a turn budget) — the status dot, status word and elapsed
  clock are gone. All three states share one shape and differ only in
  color: the word "goal" carries the status color (active blue, blocked
  amber) with the brackets and turn count in the default foreground;
  paused renders the whole badge muted. With the badge clock gone, the
  speed segment shows the gen timer, TTFT and compaction states again
  while a goal is live.

## [0.7.6] - 2026-08-21

### Changed

- The model effort suffix now renders in muted gray while the level is only
  inferred from config.toml — kimi-code lazy-starts, so the wire journal
  carries no effort before the first turn — and returns to the default
  foreground once a wire `profile.bind` / `config.update` / `llm.request`
  row confirms the actual effort (the boolean ` thinking` / ` on` suffix
  follows the same rule; `off` still renders no suffix). Per-session
  snapshots now record whether the pinned level was wire-confirmed;
  snapshots written before this change carry no flag and keep rendering as
  confirmed.

## [0.7.5] - 2026-08-21

### Fixed

- Fleet speed no longer counts a parked main agent in swarm mode: while main
  is blocked inside the AgentSwarm tool (no request in flight), its pre-swarm
  samples previously kept it in the head count and summed into the fleet
  total for the whole 2-minute recency window (e.g. `333 t/s (main+2 agents
  @111)` while only the two subagents were generating). A parked main now
  drops out immediately, like a settled subagent; a main with a request in
  flight still feeds the fleet, and outside swarm mode the just-finished
  speed keeps surviving until the stale TTL as before.

## [0.7.4] - 2026-08-20

### Changed

- Cold-start catch-up: a cold reader's first frame may spend the whole 1 MiB
  frame budget on the main wire (previously capped at one 256 KiB slice), so
  a typical session catches up — and shows TPS — in a single frame instead of
  over several seconds. Warm frames stay slice-capped.
- Provisional TPS: with fewer than 3 fresh samples (new turn after the
  2-minute TTL, a model switch, or the first steps of a session) the segment
  now shows the median of the available samples in muted gray instead of
  waiting out the warmup or falling back to the expired median.

## [0.7.3] - 2026-08-20

### Added

- Support Kimi Code 0.38.0 dual-region logins for the quota segment: the
  detached refresh resolves the region from `KIMI_CODE_OAUTH_HOST` /
  `KIMI_OAUTH_HOST`, then config.toml's `[providers."managed:kimi-code"]`
  oauth ref and `base_url`, and defaults to mainland China; a global login
  switches the request to `https://api.kimi.ai/coding/v1/usages` and reads
  the scoped credential file derived from the oauth ref key. Any custom or
  contradictory host/base URL fails closed to the default, and tokens are
  only ever sent to the two official usages endpoints. After a region switch
  the previous region's cached figures may render for up to one 60s TTL.

### Changed

- Advance the audited Kimi Code compatibility baseline from 0.37.2 to 0.38.0:
  the status-line payload/runner contract, footer line ownership, and the Git
  status model are byte-identical; the persisted wire manifest grows from 48
  to 55 durable record types (new `cron.*`, `staleGuard.*`,
  `task.waitDelivered`, and `token_counting.turn_recorded` records) and every
  durable record gains a required `agentId`, both of which HUD reducers
  safely ignore; failed or interrupted steps now persist `step.end` without
  usage or timing fields, which the TPS, cache-hit, and turn gates already
  reject; the quota endpoint shape, plugin manifest, SessionStart hook
  payloads, and credential layout are unchanged.

## [0.7.2] - 2026-08-19

### Changed

- Advance the audited Kimi Code compatibility baseline from 0.36.1 to 0.37.2:
  the 10-field status-line payload, first-stdout-line contract, and 300ms host
  ceiling are unchanged; footer line 2 gains a longer-lived `warningHint` and
  remains host-owned; the persisted wire manifest drops five transient record
  types and adds durable `prompt.accepted`, `runtime.set_binding`, and
  `tower_mode.enter` / `tower_mode.exit` records that HUD reducers safely
  ignore. agent-core-v2 rewired its journal internals to Event2/defineState and
  now always stamps `time` on durable records; the on-disk wire format,
  session layout, quota endpoint, plugin manifest, and hook payloads are
  unchanged.

## [0.7.1] - 2026-08-15

### Changed

- Advance the audited Kimi Code compatibility baseline from 0.34.0 through
  0.36.1, including the content-bearing `plugin.session_start` wire row, the
  experimental mixed-provider subagent model-pool boundary, additive nested
  task metadata, and the unchanged 10-field status-line contract.
- Persist the bounded Git status probe across command processes per cwd for
  15 seconds (at most 64 SHA-256-keyed worktrees), collect branch and dirty
  state in one invocation, and disable optional Git locks while preserving the
  existing 150ms ceiling.

### Fixed

- Fail closed when an all-agent Session Cost ledger contains nonzero usage
  from another provider or an unresolved model. The HUD now hides the entire
  estimate instead of silently presenting a partial active-provider subtotal
  as the session total.
- Treat an unresolved model provider as unknown instead of managed Kimi: no
  Kimi subscription quota or provider usage is rendered or refreshed until
  the provider can be attributed explicitly.

### Security

- Resolve `git` through PATH to a canonical absolute executable before the
  dirty-tree probe and refuse workspace-local hits, preventing Windows command
  search from executing a planted `git.exe` before workspace trust.
- Strip OSC, CSI, other ESC string controls, and C0/DEL/C1 characters from
  every dynamic HUD text field before applying HUD-owned ANSI styling.

## [0.7.0] - 2026-08-09

### Added

- Add a provider-usage cache and detached-refresh framework, with the first
  adapter for DeepSeek's official API balance. The active model resolves to
  its provider table, cache files are isolated by a one-way API-key
  fingerprint, the render hot path never performs network I/O, and custom
  DeepSeek-compatible proxies are refused so credentials only reach the
  fixed official balance endpoint. The footer renders currency as compact
  balance text (`DeepSeek Balance ¥N.NN`) instead of inventing a quota
  percentage or relying on unexplained abbreviations. DeepSeek also uses the
  local all-agent cost path, so ready facts compose as
  `DeepSeek Balance ¥N.NN · Session Cost ≈¥N.NN` for CNY accounts (and the
  matching USD form for USD accounts). Cost selects the official price table
  from the balance response's currency and remains visible by itself when the
  balance is unavailable but that account currency is known; an unknown
  currency fails closed instead of guessing the symbol.
- Add local all-agent session-cost estimates for supported models on the
  official direct DeepSeek, OpenAI, and Anthropic APIs. A dedicated content-free
  `usage.record` ledger reconstructs main and subagent history without
  disturbing live metrics, waits for every wire to catch up, and fails closed
  for unknown models or compatible proxies. The footer renders the full brand
  and scope (`DeepSeek Session Cost ≈¥N.NN` / `OpenAI Session Cost ≈$N.NN` /
  `Anthropic Session Cost ≈$N.NN`),
  keeping estimates distinct from balances, admin billing, and subscriptions.

### Changed

- Format CNY session costs with two decimal places once they reach one fen,
  while retaining additional precision below that boundary so small nonzero
  costs do not collapse to `¥0.00`.

### Fixed

- Follow in-session effort and model switches from the per-request ground
  truth: hosts stamp every `llm.request` wire row with the `thinkingEffort`
  and `modelAlias` the request actually ran with, so a switch that emits no
  new `config.update`/`profile.bind` row — the host's own footer (e.g. the
  line-2 context figures) can lag behind here — now updates the HUD on the
  next request. The one-time backfill scan version is bumped so sessions
  tracked by earlier HUD builds re-project effort and model from their
  request journal too.

## [0.6.5] - 2026-08-06

### Fixed

- Track the session model and thinking effort from the host's `profile.bind`
  wire row: newer hosts bind the active profile once at session start
  (`profile.bind` with `modelAlias` + `thinkingEffort`) instead of emitting a
  `config.update` row, so such sessions fell back to the config.toml
  `[thinking]` effort — e.g. showing `high` while the model actually ran at
  `max`.

## [0.6.4] - 2026-08-03

### Added

- Render the built-in footer's background-task badges — `[N task(s) running]`
  for shell processes and `[N agent(s) running]` for background subagents,
  between the model and project segments. Counts come from a bounded
  `taskId -> { kind, status }` reducer over the main-wire `task.started` /
  `task.terminated` Ops, reconciled per frame against the
  `agents/main/tasks/<taskId>.json` sidecars so hosts that predate the
  journaled Ops are covered too; the fresher record wins per task id. The
  counts stay separate from the throughput `activeAgents` / `tpsAgents`
  figures and only `running` tasks badge.

### Fixed

- Keep the fleet speed style when a swarm runs down to its last live
  subagent: falling back to the solo-agent `⚡ 45 t/s · TTFT 1.2s` made the
  HUD look like swarm mode had been exited. A lone live agent with a speed
  reading now reports a one-agent fleet figure (`tpsTotal = tps`,
  `tpsAgents = 1`), and while swarm mode is on the speed segment and gen
  ticker keep the fleet head count, singularized as `1 agent`.

## [0.6.3] - 2026-08-02

### Added

- Label fleet head counts "main+N" whenever the main agent feeds the figure
  (e.g. `⚡ 465 t/s (main+4 @93)`), so the count can't be misread as a pure
  subagent figure while a swarm runs; it settles back to subagents only once
  the idle main agent ages out of the activity window.

## [0.6.2] - 2026-08-02

### Added

- Color the compact-layout quota percentage by usage level (yellow ≥60%,
  red ≥85%) so it takes over the level signal from the missing bar; the
  comfortable green level stays default-colored.

### Fixed

- Drop subagents from the fleet count the moment their turn ends instead of
  waiting for the two-minute activity window to expire.
- Keep the quota cache on a 401/403 while a refresh_token remains, so the
  5h/7d segment no longer disappears during idle access-token expiry.

### Changed

- Clarify in both READMEs that the 5h/7d quota windows represent Kimi managed
  subscription usage, not general API balance or spend.
- Point contributor guidance at the canonical capability and known-issue
  documents so future footer changes update the right knowledge layer.

## [0.6.1] - 2026-08-02

### Added

- Add real HUD screenshots to the Chinese and English READMEs.
- Add a canonical Kimi Code 0.31.0 capability inventory with user-facing
  activation instructions, readable-but-unrendered signals, and explicit
  token-scope definitions.
- Add a separate known-issues register for background tasks, Git fidelity,
  terminal-width awareness, and stale-frame behavior, including acceptance
  criteria for each open item.

### Changed

- Reorganize both READMEs around features, installation, configuration,
  runtime behavior, and links to the capability and issue documents.

## [0.6.0] - 2026-08-02

### Changed

- Show the bare thinking effort level in the model segment (`K3 max` instead
  of `K3 thinking:max`) in every layout; boolean thinking keeps the
  ` thinking` label.
- While the goal badge is up, the speed segment shows throughput only: the
  gen timer, TTFT and the compaction state all hide (the badge already
  carries the session clock), freeing space for the badge.

### Removed

- Drop the full layout tier together with its exclusive Context segment,
  version suffix, and Cache token counts. Layouts are now compact and normal,
  and the width defense degrades normal -> compact; read the host-drawn
  line 2 for context usage.

### Fixed

- Count only agents with a fresh speed reading in the fleet throughput
  figure: an agent still waiting on its first step stays in the gen-ticker
  head count but no longer inflates the `N agents @avg` parenthetical, so
  the displayed total, head count and average stay consistent.

## [0.5.1] - 2026-08-01

### Added

- Add sanitized end-to-end status payload and wire fixtures, bounded 50 MiB
  wire catch-up coverage, and a Node 18/20/22 CI matrix.

### Changed

- Split the executable into command routing, a configuration management
  service, and a budgeted render runtime. Render frames now share one config
  snapshot and a 220ms internal deadline across stdin, metrics, quota refresh,
  and Git collection.
- Split metrics into state migration/storage, session location, bounded wire
  reading, and throughput, turn, compaction, cache, goal, and session metadata
  reducers. Metrics state v8 caps aggregate wire reads at 1 MiB per frame,
  rotates subagent priority, preserves split UTF-8 lines, and incrementally
  replaces historical projections after they catch up.

### Fixed

- Fail closed when the SessionStart hook cannot safely parse a status-line
  command, and quote generated commands whose paths contain spaces or shell
  metacharacters.
- Make management command failures observable through stderr and exit status,
  while preserving render and detached-refresh silent fallbacks.
- Classify quota failures so authorization errors clear stale data while
  transient errors retain it, and make refresh locking atomic and
  ownership-safe.
- Preserve zero-valued quota windows when the usages API omits `used`, deriving
  it from `limit - remaining` so the percentage and reset countdown stay visible.
- Keep stale TPS medians inside their owning agent bucket and fully reset an
  agent when its wire rotates or truncates.

## [0.5.0] - 2026-08-01

### Added

- Compaction timer. The wire journal's `full_compaction.begin` / `complete` /
  `cancel` rows feed the speed segment's TTFT slot the same way the turn
  timer does: a between-turns compaction (manual `/compact`) ticks live
  `compacting Ns` in place of TTFT, and since a finished compaction has no
  TTFT of its own the dimmed `compacted Ns` holds the slot until the next
  prompt's `gen` timer takes over. Compactions inside a turn
  (auto-compaction) are never shown — the `gen` timer owns that span. A
  begin whose close record was lost (host killed mid-compaction) expires
  after 10 minutes instead of ticking a runaway timer; existing state files
  re-scan once (backfill v8) to recover an in-flight compaction.

### Changed

- The session Cache ratio no longer dims between a prompt and its first
  counted step. The number is session-cumulative, so at prompt time it is
  already the latest complete value — the gray flash at every turn start
  was noise, not a freshness signal.

## [0.4.0] - 2026-07-31

### Added

- Light-theme support. Resolved from `tui.toml`'s top-level `theme`
  setting, with `"auto"` resolved via `COLORFGBG` and a dark fallback
  (the status line can't run the host's OSC 11 query on the 300ms hot
  path); `KIMI_HUD_THEME=dark|light` pins the palette manually. On light,
  the badges (model name, `[plan]`, `[yolo]`, `[swarm]`, `[auto]`) render
  bold, and the amber/teal use brighter hues (`#D97706` / `#14B8A6`) than
  the host's muddy `#92660A` / `#00838F`, while the quota and context
  bars switch from glaring terminal ANSI to calmer truecolor hues
  (`#B91C1C` / `#D97706` / `#0E7A38`). Dark mode is unchanged: badges
  keep the host dark hex values and bars keep terminal-remapped ANSI.

## [0.3.2] - 2026-07-31

### Changed

- The `gen` turn timer keeps showing seconds past the one-minute mark
  (`1m5s`), so the live ticker visibly updates every second instead of
  looking static.
- The weekly quota segment is labeled `7d`, consistent with the `5h`-style
  window labels, and the normal layout now shows its reset countdown
  (`~3d2h`) instead of only the full layout. Quota windows group into one
  segment joined by `·` instead of the `│` segment bar.
- The Cache segment now reports the whole session's token-weighted
  cache-read ratio, cumulative across turns, instead of only the current
  user turn; existing states rebuild the counters once from the bounded 1
  MiB wire tail (cache scan v2).

### Fixed

- A live `gen` timer no longer inherits the muted gray of an expired speed
  window: the stale TPS stays dimmed, but the running timer renders bright.
- The Cache segment no longer disappears at each new prompt (which shifted
  the line width every turn): the ratio stays visible dimmed until the new
  turn's first counted step, then brightens again. Steps with incomplete
  usage fields are now skipped instead of hiding the metric.

## [0.3.1] - 2026-07-31

### Changed

- The live `gen Ns` timer now measures the whole turn — from your prompt
  (`turn.prompt`) until the turn ends (`end_turn` or `turn.cancel`), spanning
  tool calls and steps — instead of only the current LLM request.
- Existing state files re-scan once (backfill v6) to recover an in-flight
  turn; the backfill folds turn boundaries through a narrow handler so it
  cannot duplicate TPS samples or clobber cache counters.

## [0.3.0] - 2026-07-31

### Added

- Scan every agent wire in the session (main + subagents): speed samples are
  timestamped and bucketed per agent, and only the freshest 5 within 10
  minutes feed an agent's median, so resume continuations, idle gaps and
  compactions never mix in stale numbers.
- Fleet speed display when several agents are active (swarm/subagent runs):
  total plus head count and per-agent average (`⚡ 305 t/s (12 agents @25)`);
  TTFT is the median across active agents so one stuck agent cannot poison
  the display. Ports the design from PR #2 with fixes (true mean instead of
  a mislabeled median) — thanks @xiayh0107.
- Live `gen Ns` ticker while a request is in flight, replacing the frozen
  TTFT during long generations; `turn.cancel` and `full_compaction.complete`
  close the in-flight window immediately (the PR let aborted generations
  stick for 10 minutes).

### Changed

- Metrics state moves to per-agent buckets; flat state files migrate in
  place, keeping the sample window, badges and cache counters, and cold
  starts no longer read the whole main wire twice.

## [0.2.7] - 2026-07-31

### Added

- Show the token-weighted prompt-cache hit rate for the current user turn in
  every layout, with cache-read and total-input token counts in the full
  layout.
- Restore current-turn cache usage from a bounded 1 MiB wire-log tail after an
  upgrade, while hiding incomplete statistics until the next prompt.
- Recover the `[swarm]` badge from `swarm_mode.enter` and `swarm_mode.exit`
  events in the session wire journal.
- Add reversible `--on` and `--off` commands for temporarily switching the HUD
  without removing its self-heal hook.

### Changed

- Keep the last reliable TPS median visible in muted gray after its live window
  expires, until a new window warms up.
- Hide Kimi managed-subscription quota for models served by third-party
  providers configured through `/provider`.

### Fixed

- Reject unreliable stream durations and implausible TPS outliers, and reset
  the speed window when the active model changes.
- Adopt and remove legacy unmarked SessionStart hook blocks without disturbing
  unrelated hook configuration.

[Unreleased]: https://github.com/FinbackYu/kimi-code-hud/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.8.1
[0.8.0]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.8.0
[0.7.8]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.8
[0.7.7]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.7
[0.7.6]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.6
[0.7.5]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.5
[0.7.4]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.4
[0.7.3]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.3
[0.7.2]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.2
[0.7.1]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.1
[0.7.0]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.7.0
[0.6.5]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.6.5
[0.6.4]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.6.4
[0.6.3]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.6.3
[0.6.2]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.6.2
[0.6.1]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.6.1
[0.6.0]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.6.0
[0.5.1]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.5.1
[0.5.0]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.5.0
[0.4.0]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.4.0
[0.3.2]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.3.2
[0.3.1]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.3.1
[0.3.0]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.3.0
[0.2.7]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.2.7
