# Known issues

- Last verified: 2026-08-02
- HUD behavior baseline: `v0.6.0` (`af3b43b`)
- Kimi Code baseline: `0.31.0` (`5c0ec2938ac3a01624b6503e5e5df80c9b08f46a`)

This file tracks open footer parity problems and information boundaries. Close
or move an entry when its acceptance criteria are met. Current coverage and
readable-but-unrendered data are documented separately in
[CAPABILITIES.md](CAPABILITIES.md).

## KI-1: Background task badges are absent

Status: open

Affected upstream slot: `tasks`

The built-in footer separately renders running Shell processes and background
agents, but the HUD currently renders neither count. The main wire has durable
`task.started` and `task.terminated` records; older session layouts may also
require reconciliation with `tasks/<taskId>.json`.

The implementation should keep a `taskId -> { kind, status }` reducer, count
only `status === "running"`, and group `kind === "process"` separately from
`kind === "agent"`. It must not reuse `metrics.activeAgents`: that metric
includes the main agent and describes recent LLM generation, not durable
background-task state.

Acceptance criteria:

- recover both counts from a real payload that contains no task fields;
- handle completed, failed, timed-out, killed, and lost terminal states;
- keep task counts separate from throughput `activeAgents` / `tpsAgents`;
- render counts only, never command text, descriptions, or output tails;
- retain bounded incremental reads and the shared 220ms frame deadline.

## KI-2: Git is lower fidelity than the built-in footer

Status: open

Affected upstream slot: `git`

The HUD renders the payload branch plus a dirty `*`. It does not render upstream
diff counts, ahead/behind, or linked PR information.

Adding these directly to the synchronous hot path would be unsafe: upstream
uses TTL caches and performs `gh pr view` asynchronously. Parity work needs an
equally bounded persistent cache/detached-refresh design and silent fallbacks.

Acceptance criteria:

- show diff `+N/-N` or `±` and ahead/behind without exceeding the frame budget;
- never block rendering on PR or network lookup;
- handle a missing `gh` binary, detached HEAD, no upstream, and non-repositories;
- expire or invalidate cached data when cwd or branch changes;
- preserve the current silent render fallback.

## KI-3: Layout downgrade is not terminal-width aware

Status: open information boundary

Affected area: cross-cutting layout

The status-line payload does not include terminal width. The HUD downgrades
`normal -> compact` only when its own line exceeds 200 visible characters; on a
narrower terminal the host may truncate the custom line before that heuristic
fires.

Exact width-aware composition requires an upstream payload field or another
reliable width contract. A fix must not assume `process.stdout.columns` is
available because the command writes to a pipe.

Acceptance criteria:

- obtain a reliable per-frame terminal width without blocking the hot path;
- choose normal/compact against that width using ANSI-aware visible length;
- retain the 200-character ceiling as a defensive maximum, not the primary
  terminal-width signal.

## KI-4: A failed command can leave a stale frame

Status: open upstream behavior / documented limitation

Affected area: command lifecycle

Before the first successful custom frame, command failure lets the built-in
line 1 render. After a successful frame, the upstream runner keeps that cached
line when a later run fails. A non-zero exit is therefore not a dynamic way to
fall back.

The current disable/remove workflow mitigates this by removing the managed
`[status_line]` command, after which `/reload-tui` or a new session restores the
built-in footer.

Acceptance criteria for closing as a HUD problem:

- upstream exposes a way to clear the cached custom frame, or the HUD gains an
  equivalent supported handoff mechanism;
- disable, remove, failure, and recovery behavior is covered by an end-to-end
  contract test;
- README instructions remain consistent with the observed runner behavior.
