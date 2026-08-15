# Known issues

- Last verified: 2026-08-14
- HUD behavior baseline: `v0.7.0 + Unreleased`
- Kimi Code baseline: `0.36.0` (`b6144f94ea6b22455a4e750d1750d220987e7bc2`)

This file tracks open footer parity problems and information boundaries. Close
or move an entry when its acceptance criteria are met. Current coverage and
readable-but-unrendered data are documented separately in
[CAPABILITIES.md](CAPABILITIES.md).

## KI-1: Background task badges are absent

Status: closed (fixed in HUD `v0.6.4`)

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

Resolution:

- `src/metrics-tasks.mjs` keeps a bounded `taskId -> { kind, status,
  updatedAt }` reducer over the main-wire `task.started` / `task.terminated`
  Ops and reconciles `agents/main/tasks/<taskId>.json` sidecars once per
  frame (64 files / 16 KiB caps, deadline-aware); hosts that predate the
  journaled Ops (e.g. 0.31.x binaries) are covered entirely by the sidecar
  projection. The fresher record wins per task id, so a lagging incremental
  reader cannot resurrect a finished task.
- `summarizeMetrics` reports `tasks: { bash, agents }` — running counts only,
  `agent` kind split from every other kind, handled for completed, failed,
  timed-out, killed, and lost terminal states, and fully separate from
  `activeAgents` / `tpsAgents`.
- `src/render.mjs` renders `[N task(s) running]` / `[N agent(s) running]`
  between the model and project segments (the upstream `model → tasks → cwd`
  slot order), counts only — never command text, descriptions, or output
  tails — and the wire read keeps the shared 220ms frame deadline.

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

## KI-5: In-session effort switches are invisible to the status line

Status: open upstream API gap

Affected upstream slot: `model` / status-line payload

The built-in footer follows an in-session effort switch instantly because it
renders the host's in-memory session state (`state.thinkingEffort`, updated by
the model picker via `session.setThinking` → `getStatus` → `setAppState`). The
custom status line cannot: `StatusLinePayload` (10 fields) carries no
thinking-effort field, and the wire journal records effort only in
`profile.bind` (session start) and `llm.request` (per request) — the switch
itself emits no local event (only an ACP `config_option_update` session
notification, which never reaches the wire file).

Consequence: the HUD shows the effort the last request actually ran with and
updates on the next request after a switch (typically within a second of
sending a message). The built-in footer shows the session's current runtime
effort immediately. Both are truthful; they differ only in the switch →
next-request window. Verified against host source `footer.ts` /
`status-line-command.ts` and real 0.34.0 session wires.

Acceptance criteria:

- the host exposes the current thinking effort in the status-line payload
  (e.g. `thinkingEffort` alongside `model`), or emits a local event on an
  in-session switch;
- the HUD prefers the payload field when present, keeping the wire-derived
  effort as the fallback;
- the fallback (next-request update) keeps working unchanged on hosts without
  the field.

## KI-6: Mixed-provider sessions could show a partial cost

Status: closed (fixed in `Unreleased`)

Affected area: provider Session Cost

Kimi Code 0.36.0 can assign subagents from an experimental model pool. If a
session used OpenAI and Anthropic models together, the previous estimator
silently skipped the non-active provider and still labeled the remainder as
the whole `Session Cost`.

Resolution:

- every valid nonzero model-usage row must resolve to the active provider;
- a cross-provider or unresolved row returns no cost fact, so the whole
  Session Cost segment hides instead of understating spend;
- zero-token rows remain ignorable because they cannot change the total;
- regression coverage includes both a known second provider and an
  unconfigured subagent model.

## KI-7: The Git dirty probe used a bare executable name before trust

Status: closed (fixed in `Unreleased`)

Affected area: Git probe / Windows command resolution

On Windows, `cmd.exe` / `CreateProcess` can search the current directory before
PATH. Calling bare `git` while the HUD runs inside an untrusted workspace could
therefore execute a planted `git.exe`.

Resolution:

- resolve `git` from PATH to an absolute executable before running it;
- honor PATHEXT on Windows, canonicalize the candidate, and refuse any first
  hit inside the workspace (including a symlink that resolves there);
- preserve the existing silent `false` fallback when no trusted executable is
  available or the bounded status command fails.

## KI-8: Experimental fullscreen mode lacks a live HUD verification

Status: open verification gap

Affected area: Kimi Code 0.36.0 experimental fullscreen TUI

Static release review confirms that fullscreen mode does not change the
10-field status-line payload, the first-stdout-line contract, the 300ms host
ceiling, or the host ownership of footer line 2. The HUD test suite covers that
contract but has not driven a real interactive fullscreen terminal frame. An
isolated launch against the installed 0.36.0 binary on 2026-08-14 exited before
the first frame with the host error `EMFILE: too many open files, watch`, even
with isolated `HOME` and `KIMI_CODE_HOME`; this is recorded as unavailable
evidence, not a HUD pass or failure.

Acceptance criteria:

- launch Kimi Code 0.36.0 with the experimental fullscreen mode in a real PTY;
- verify line 1 refresh, line 2 context ownership, resize, reload, and fallback;
- record the terminal/OS matrix without weakening the 220ms HUD budget.
