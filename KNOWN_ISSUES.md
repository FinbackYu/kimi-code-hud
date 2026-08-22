# Known issues

- Last verified: 2026-08-22
- HUD behavior baseline: `v0.7.6` (`f90ff15`)
- Kimi Code baseline: `0.38.0` (`0999454bdcb5ddd98f39bffee434dcf0a810f394`)

This file tracks open footer parity problems, information boundaries, and
resolved compatibility or security constraints worth keeping as regression
records. Current coverage and readable-but-unrendered data are documented separately in
[CAPABILITIES.md](CAPABILITIES.md).

## KI-1: Background task badges were absent

Status: closed (fixed in HUD `v0.6.4`)

Affected upstream slot: `tasks`

The built-in footer separately renders running Shell processes and background
agents, but the HUD previously rendered neither count. The main wire has durable
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

The dirty probe itself is now bounded by a cross-process 15-second, 64-cwd
cache and runs with `GIT_OPTIONAL_LOCKS=0`; this closes the per-frame scan/lock-contention
risk tracked separately in KI-11, but does not add the missing fidelity here.

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

Status: closed (fixed in HUD `v0.7.1`)

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

The 0.39.0 Tower candidate can also produce a session whose workers use a
different provider from main. The same all-agent rule applies: any nonzero
cross-provider row hides the whole Session Cost estimate. A missing cost in
that case is the intended fail-closed signal, not a partial-total regression.

## KI-7: The Git dirty probe used a bare executable name before trust

Status: closed (fixed in HUD `v0.7.1`)

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

Affected area: Kimi Code 0.36.0–0.38.0 experimental fullscreen TUI

Static release review through 0.38.0 confirms that fullscreen mode does not
change the 10-field status-line payload, the first-stdout-line contract, the 300ms host
ceiling, or the host ownership of footer line 2. The HUD test suite covers that
contract but has not driven a real interactive fullscreen terminal frame. An
isolated launch against the installed 0.36.0 binary on 2026-08-14 exited before
the first frame with the host error `EMFILE: too many open files, watch`, even
with isolated `HOME` and `KIMI_CODE_HOME`; this is recorded as unavailable
evidence, not a HUD pass or failure.

Acceptance criteria:

- launch Kimi Code 0.38.0 with the experimental fullscreen mode in a real PTY;
- verify line 1 refresh, line 2 context ownership, resize, reload, and fallback;
- record the terminal/OS matrix without weakening the 220ms HUD budget.

## KI-9: Unknown providers could be shown as managed Kimi quota

Status: closed (fixed in HUD `v0.7.1`)

Affected area: quota/provider attribution

When model configuration was absent, unreadable, or could not resolve the
active model, the provider resolver returned `null`. The runtime previously
treated that unknown state as `managed:kimi-code`, so it could render and
refresh Kimi subscription quota for a third-party or otherwise unresolved
model.

Resolution:

- only the exact `managed:kimi-code` provider enters the quota branch;
- a known non-managed provider may enter its own provider-usage branch;
- null, empty, and unresolved providers render and refresh neither source;
- regression coverage locks the no-quota/no-refresh unknown state.

## KI-10: Dynamic HUD text could inject terminal controls

Status: closed (fixed in HUD `v0.7.1`)

Affected area: terminal rendering

Model names, thinking effort, cwd basename, Git branch, and other dynamic
labels previously entered the rendered line without a terminal-control
boundary. An OSC, CSI, BEL, or related control in one of those sources could
alter terminal display behavior instead of remaining ordinary text.

Resolution:

- strip OSC/CSI and other ESC string controls before HUD styling;
- remove C0, DEL, and C1 control characters from all dynamic display fields;
- cover model, thinking, cwd, branch, goal, quota, provider label/currency,
  and the fallback model line;
- preserve only the ANSI SGR sequences generated by the HUD itself.

## KI-11: Git dirty detection ran on every footer frame

Status: closed (fixed in HUD `v0.7.1`)

Affected area: Git probe / render budget

The host invokes the status-line command at most once per second, and the HUD
previously ran a synchronous `git status --porcelain` on every eligible frame.
Large or network-backed worktrees could repeatedly consume most of the 220ms
HUD budget and contend with other Git operations.

Resolution:

- persist branch/dirty status across command processes for 15 seconds in a
  64-entry, SHA-256-cwd-keyed cache;
- obtain both fields in one `git status --porcelain=v1 --branch` call;
- set `GIT_OPTIONAL_LOCKS=0` without mutating the caller environment;
- preserve trusted absolute executable resolution, the 150ms probe ceiling,
  and the silent clean fallback, including cached failures.

## KI-12: Global-region quota is unavailable

Status: closed (fixed in HUD `v0.7.3`)

Affected area: quota region resolution

Through Kimi Code 0.37.2 there is a single managed region, so the HUD
hardcoded the mainland usages URL (`https://api.kimi.com/coding/v1/usages`)
and read credentials from the default `credentials/kimi-code.json` slot.
Kimi Code 0.38.0 adds a global region: a login against `https://auth.kimi.ai`
persists its own base URL and an `oauth` ref whose `key` is
`oauth/kimi-code-env-<16 hex>` (see `packages/oauth/src/region.ts` and
`managed-kimi-code.ts`). Before the fix, a global-region user saw no quota at
all: the refresh called the mainland URL with the default-slot credential
file instead of the scoped one.

Resolution:

- `resolveQuotaEndpoints` (`src/quota.mjs`) resolves the region on the
  detached `--refresh-quota` path only, in upstream order: env
  `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`, then the
  `[providers."managed:kimi-code"]` `oauth` sub-table (`oauth_host`,
  `base_url`, `key`) from config.toml, then the mainland default;
- the credential file is derived from the persisted `oauth.key` via
  `credentialsPathForKey`, honoring only the two upstream key shapes
  (`oauth/kimi-code` and `oauth/kimi-code-env-<16 hex>`) and falling back to
  the default slot otherwise;
- the token leaves the process only toward the two official hosts
  (`api.kimi.com` / `api.kimi.ai`, https, no port, exact `/coding/v1/usages`
  path): any custom or mismatched host/base pair fails closed to the
  mainland default, and `requestQuota` re-checks the same whitelist before
  sending;
- the render hot path never parses config.toml and `quota.json` carries no
  account, credential-slot, or endpoint tag. After an account or region
  switch, the previous figures may continue to render; the 60s TTL marks the
  cache stale and schedules refresh but does not evict it. A successful
  refresh replaces the value, while repeated 401/403 responses with a
  remaining `refresh_token` may preserve the stale value beyond one TTL.

Acceptance criteria:

- a global-region config resolves to `https://api.kimi.ai/coding/v1/usages`
  and the scoped credential file `credentials/kimi-code-env-<16 hex>.json`;
- a non-official URL, or a host/base pair pinned to different regions, never
  receives the token (fail closed to the mainland default);
- a mainland config with no env override and no `oauth_host` keeps the
  unchanged `api.kimi.com` URL and the default `credentials/kimi-code.json`
  slot;
- after an account or region switch, refresh targets the newly resolved
  endpoint and a successful response replaces the cache; until then the
  previous value may remain and is marked stale after the 60s TTL;
- regression tests cover all of the above (`test/quota.test.mjs`).

## KI-13: Tracked showcase PNGs drift from current rendering behavior

Status: open release-asset drift

Affected area: documentation showcase assets

The tracked `docs/media/hud-states.png` and `docs/media/hud-demo.png` do not
match the current startup rendering behavior. An unconfirmed thinking effort is
dim, and provisional throughput dims the whole speed segment including TTFT;
the images still show the older brighter startup state. Runtime behavior and
tests are unaffected, but the README images remain visually stale.

Acceptance criteria:

- regenerate both images from the tracked showcase sources with
  `node docs/showcase/render-states.mjs && python3 docs/showcase/export-assets.py`;
- read both PNGs back and verify dim effort plus dim TPS/TTFT in the startup row;
- verify both PNGs carry the expected `Author` metadata;
- run strict release metadata and the full HUD test suite before staging the
  two generated assets.
