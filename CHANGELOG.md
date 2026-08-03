# Changelog

All notable changes to this project are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/FinbackYu/kimi-code-hud/compare/v0.6.3...HEAD
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
