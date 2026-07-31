# Changelog

All notable changes to this project are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/FinbackYu/kimi-code-hud/compare/v0.2.7...HEAD
[0.2.7]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v0.2.7
