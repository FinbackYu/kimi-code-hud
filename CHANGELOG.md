# Changelog

All notable changes to this project are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/FinbackYu/kimi-code-hud/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.3.1
[0.3.0]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.3.0
[0.2.7]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.2.7
