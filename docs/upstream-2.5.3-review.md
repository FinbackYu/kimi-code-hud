# Kimi Code 2.5.3 upstream review

Reviewed: 2026-11-11. This document audits the HUD against released source and
synthetic fixtures. It does not establish a live 2.5.3 TUI/remote-environment
acceptance, close either monitored issue, or constitute a HUD release.

## Release identity and range

| | Previous | Target |
|---|---|---|
| Release | `@moonshot-ai/kimi-code@2.4.0` | `@moonshot-ai/kimi-code@2.5.3` |
| Annotated tag object | `b8f43387e0b4af152fbdcb3c6f78c432f15fb649` | `cf71981af39152921167175b46124c6c7e82b132` |
| Peeled commit | `f26e4d91ef8d5d233f6c20b42a150f96924d4f5e` | `5af9942e9fb789b6a1530830575b3768499932e9` |

The target is a non-draft, non-prerelease published at 2026-11-10 13:06:23
UTC. The range is **not linear**: the previous peeled commit is not an ancestor
of the target, and the merge base is `78b72fe456ac730a1970ded9bb0d28f8b584ab95`.
The counted `2.4.0^{}..2.5.3^{}` range contains 82 commits, with the target as
its first topo-order entry. The endpoint diff has 1,513 changed files
(+77,274/−92,878); the no-renames path list has 1,629 old/new path entries.
The range covers 2.4.1 and 2.5.0–2.5.3.

Complete path lists, topo commits and diff stats were materialized before
making absence claims. The principal commands were:

```sh
git rev-list --topo-order "$previous..$target"
git diff --name-only --no-renames "$previous" "$target"
git diff --stat "$previous" "$target"
```

Source links below pin the target peeled commit, not a moving branch.

## Contract and presentation decisions

| Upstream evidence | HUD entry point | Result |
|---|---|---|
| [`status-line-command.ts`](https://github.com/MoonshotAI/kimi-code/blob/5af9942e9fb789b6a1530830575b3768499932e9/apps/kimi-code/src/tui/utils/status-line-command.ts) is byte-identical (blob `6482a4ac7c`): 10 fields, first stdout line, 65,536-byte capture cap, 300 ms timeout, 1 s rerun and cached-last-good-frame behavior are unchanged | `src/payload.mjs`, `src/render-runtime.mjs`, `src/hooks.mjs` | **covered** by existing parser/runtime/lifecycle tests. Failure, empty output, malformed input and timeout fallbacks do not change. No environment or remote marker was added to the payload. |
| [`footer.ts`](https://github.com/MoonshotAI/kimi-code/blob/5af9942e9fb789b6a1530830575b3768499932e9/apps/kimi-code/src/tui/components/chrome/footer.ts) and [`git-status.ts`](https://github.com/MoonshotAI/kimi-code/blob/5af9942e9fb789b6a1530830575b3768499932e9/apps/kimi-code/src/utils/git/git-status.ts) move Git reads to an injected core/SDK source. #4649 supplies remote cwd and branch; the footer gains an environment id/status slot | `src/render-runtime.mjs`, `src/render.mjs`, `src/git-safe-probe.mjs` | **P1 open in #69 / environment slot missing**. The HUD shows the payload branch but still probes cwd locally for dirty `*`. A nonexistent remote path yields branch-only; an identical local repository path can lend the wrong dirty state. The old null-branch HEAD fallback has the same collision ambiguity, so #69's claim that older behavior was always safely hidden is too broad. |
| [`wire-manifest.d.ts`](https://github.com/MoonshotAI/kimi-code/blob/5af9942e9fb789b6a1530830575b3768499932e9/packages/agent-core-v2/docs/wire-manifest.d.ts) grows 67 → 69: `runtime.set_binding` is removed and `environment.set_binding`, `tool_select.initialized`, `tool_select.tools_changed` are added | exact-type reducers in `src/metrics.mjs`; `test/wire-row-classes.test.mjs` | **covered / no-op**. `wire-events-2.5.3.jsonl` carries a remote cwd and tool descriptions/schemas; reducer, persisted-state and render comparisons match the stripped baseline and leak none of those values. |
| Other manifest deltas: `changeNotifier.snapshot` adds workspace mapping/directory fields; `goal.update` adds optional `objective`; `turn.ended` replaces optional `traceId` with `requestId`; `task.terminated` drops `outputTail` | goal, turn, task and session-usage reducers | **covered / unread fields**. None of those fields feeds a HUD projection. In particular, only `usage.record` enters the cost ledger and task output text is never rendered. |
| Session metadata adds optional `environmentId` / `environmentCwd`; running/historical fork support expands. The workdir-key algorithm and `wire.jsonl` path stay unchanged; wire-service changes convert message payloads without changing journal naming | `src/session-locator.mjs`, `src/wire-reader.mjs`, `src/session-files.mjs` | **covered at source/fixture level**. Existing bounded readers still apply. KI-18's raw-journal/active-chain boundary remains. Live remote, running-fork and historical-fork sessions were not exercised. |
| Plugin manifest parsing adds interface localization and overrides; the manager adds marketplace/package availability. The `hooks[]` manifest shape and enabled SessionStart hook enumeration remain | `kimi.plugin.json`, `hooks/sync-status-line.mjs` | **covered / additive**. The HUD manifest needs no locale or override fields, and install/uninstall/hook repair keep editing only the intended config entries. |
| `tui/config.ts` adds `environment` to the built-in item allowlist. The SDK config adds environment declarations, removes `[secondary_model] force` and the MCP stdio `executor` key, and can persist model `max_output_size`; model refresh comparison becomes key-order insensitive | `src/toml.mjs`, `src/management-service.mjs`, `src/model-config.mjs` | **covered / additive or unread**. Existing unrelated-TOML preservation applies to the new item. The HUD reads none of the removed/new keys. Current fullscreen instructions remain unchanged; see #70 below. |
| `managed-usage.ts` (`7bfcd86e2e`) and `managed-kimi-code.ts` (`8848966299`) are byte-identical. Permission display names, tips and thinking-config rules are also byte-identical | `src/quota.mjs`, provider credential boundary, permission badges | **covered**. No quota endpoint, credential layout, provider attribution or display-name change reaches the HUD. No token is newly read, logged or cached. |
| Upstream Git execution hardening moves into core; the HUD still runs its own pre-trust local probe | `src/git.mjs`, `src/git-safe-probe.mjs` | **HUD-held defenses unchanged**. Trusted absolute executable resolution, lock suppression, index-only inspection and the 220 ms internal frame budget stay in force. Upstream's core service is not a local HUD data source. |

## Display parity search

The replaced old words and moved/default tokens were searched in `README.md`,
`README.en.md`, `CAPABILITIES.md`, `KNOWN_ISSUES.md`, `CHANGELOG.md`, `src/`,
`test/` and `docs/`. Results and decisions:

| Old word / moved token | Hits and decision |
|---|---|
| `Start a fresh session in the current workspace`; `Runtime and TUI config reloaded; no active session.` | 0 hits. The HUD does not copy either host message; no change to `/new` or `/reload-tui` instructions is needed. |
| `Ready.` | 0 hits. Removing the startup transcript line does not affect HUD fixtures or showcase copy. |
| `runtime.set_binding`; `turn.ended.traceId` | Only historical changelog/review/archive records. They remain accurate history; the new baseline records the rename/removal instead of rewriting it. |
| `[secondary_model] force`; MCP stdio `executor` | 0 hits in HUD runtime and user documentation. Neither was a HUD input. |
| Permission display names and slash-command names | `manual → Always Ask`, `yolo → Ask When Needed`, `auto → Never Ask` is unchanged. The built-in registry remains at the same 44 names; only `/new`'s description changes. No HUD mapping change follows. |
| `2.4.0` as the current baseline | Advanced in both READMEs, `CAPABILITIES.md`, `KNOWN_ISSUES.md`, both showcase `CLI_VERSION` constants and the cold-Git payload fixture. Historical release sections intentionally remain. |

## Findings

**P0: none.** No unusable, unsafe or data-destroying change reaches the HUD.

**P1: #69 remains an implementation follow-up.** A fix should at least skip the
local dirty probe when cwd has no locally verifiable symbolic HEAD and preserve
the host branch as branch-only. It must also test a real local dirty worktree.
That guard does **not** solve an identical remote/local path collision: the
10-field payload has no authoritative environment signal, so the residual
boundary must remain documented rather than claimed fixed.

**P2:** the new footer environment id/status slot is not reproduced; its state
is readable from wire/session records but not from the status-line payload.
This is a parity gap, not a regression in existing HUD fields.

**#70 is prep, not a 2.5.3 fix.** PR #4771's merge commit
`c01a04a2557fa8bae5c467a9d7bf2c13a2b3881e` is not in the target release; the
official compare is diverged, while the inspected 2.6.0 canary contains it. At
2.5.3, `DEFAULT_TUI_CONFIG.tuiMode` is still explicit `regular`, and
`KIMI_CODE_TUI_FULL_SCREEN=1` still performs the old one-time migration. The
current KI-8 and README wording therefore stays valid. The proposed commented
`tui_mode` fixture, per-process boolean override docs, terminal fallback
acceptance and historical-review superseded note belong on the prep branch for
the release that actually includes #4771, not on this stable baseline.

**Unable to judge:** a live 2.5.3 classic/fullscreen TUI frame, a real remote
environment, resize/reload/failure-frame behavior, running/historical fork
behavior, real managed-account and DeepSeek responses, and real-host Git-filter
acceptance. These remain manual acceptance gaps.

## Watch carry-over

- [HUD #69](https://github.com/FinbackYu/kimi-code-hud/issues/69), upstream
  #4649: **fix required on the released line**. Source impact, corrected
  boundary and acceptance criteria are recorded; no runtime fix is claimed by
  this review.
- [HUD #70](https://github.com/FinbackYu/kimi-code-hud/issues/70), upstream
  #4771: **prep required, out of the 2.5.3 tag**. No current stable
  documentation was rewritten to the unreleased behavior.
- Repo-Overwatch's local report tree has no report after 2026-09-03, so there is
  no additional unconsumed WATCH input from that tree. The monitor-owned issue
  titles and bodies were left untouched.

## Verification and limits

- The focused HUD contract/management/release-metadata/row-class run reports
  55 tests: 54 pass, 0 fail and one existing release-condition skip. The new
  environment/tool-select fixture passes fixture, direct-fold and full-pipeline
  comparisons.
- The complete `npm test` run reports 845 tests: 843 pass, 0 fail and two
  existing platform/release-condition skips. `node --check
  test/wire-row-classes.test.mjs`, the empty-input CLI smoke and `git diff
  --check` pass; the root workspace contract gate independently validates the
  same release and fixture linkage.
- No real user configuration, credential or session data was read. No HUD
  runtime code was changed by this review; #69 and #70 remain implementation
  work rather than checked-off fixes.

The official upstream checkout's HEAD was not moved and its working tree stayed
clean. Only the exact official 2.5.3 annotated tag and its required objects were
fetched under the baseline-review exception; no upstream source, documentation,
branch, config or test was modified. No HUD commit, push, merge or release was
performed by this review.
