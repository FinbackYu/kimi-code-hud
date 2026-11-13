# Kimi Code 2.6.1 upstream review

Reviewed: 2026-11-13. This document audits the HUD against released source and
synthetic fixtures. It covers the released 2.6.0 changes carried by 2.6.1, but
does not establish live 2.6.1 TUI/remote-environment acceptance or constitute a
HUD release.

## Release identity and range

| | Previous | Target |
|---|---|---|
| Release | `@moonshot-ai/kimi-code@2.5.3` | `@moonshot-ai/kimi-code@2.6.1` |
| Annotated tag object | `cf71981af39152921167175b46124c6c7e82b132` | `be40a45d36d3a856bfcb5b4366073a88f52f9033` |
| Peeled commit | `5af9942e9fb789b6a1530830575b3768499932e9` | `30e3ce442ae850a7461b80f2ce209cd73a301d02` |

The target is a non-draft, non-prerelease published at 2026-11-13 07:11:15 UTC.
The previous peeled commit is not an ancestor of the target; the merge base is
`244819a526026f8b26177b9780a64889c18fa18c`. The counted range contains 102
commits. The endpoint diff has 1,205 changed files (+74,207/−75,893), with 1,268
old/new path entries under `--no-renames`, and covers 2.6.0 plus 2.6.1.

Complete path lists, topo commits and diff stats were materialized before making
absence claims. The principal commands were:

```sh
git rev-list --topo-order "$previous..$target"
git diff --name-only --no-renames "$previous" "$target"
git diff --stat "$previous" "$target"
```

Source links below pin the target peeled commit, not a moving branch.

## Contract and presentation decisions

| Upstream evidence | HUD entry point | Result |
|---|---|---|
| [`status-line-command.ts`](https://github.com/MoonshotAI/kimi-code/blob/30e3ce442ae850a7461b80f2ce209cd73a301d02/apps/kimi-code/src/tui/utils/status-line-command.ts) is byte-identical (blob `6482a4ac7c`): 10 fields, first stdout line, 65,536-byte capture cap, 300 ms timeout, 1 s rerun and cached-last-good-frame behavior are unchanged | `src/payload.mjs`, `src/render-runtime.mjs`, `src/hooks.mjs` | **covered**. Parser/runtime/lifecycle fallbacks remain valid; the HUD retains its 220 ms internal budget and silent failure behavior. No environment or remote marker was added. |
| [`footer.ts`](https://github.com/MoonshotAI/kimi-code/blob/30e3ce442ae850a7461b80f2ce209cd73a301d02/apps/kimi-code/src/tui/components/chrome/footer.ts) sources payload cwd through `sessionWorkDir`: remote binding cwd, otherwise the current local primary. Fullscreen grouping adds a rotating tip; `kimi-tui.ts` suppresses the `ctrl+o` hint while grouping is active | `src/render.mjs`, `src/render-runtime.mjs`, `src/git.mjs` | **covered / variant**. The HUD already uses payload cwd for project and Git-cache identity. This follows primary swaps without new inference; KI-2's identical-local-path collision remains. Tips and the conditional shortcut stay host-owned. |
| [`wire-manifest.d.ts`](https://github.com/MoonshotAI/kimi-code/blob/30e3ce442ae850a7461b80f2ce209cd73a301d02/packages/agent-core-v2/docs/wire-manifest.d.ts) drops 69 → 67: `task.waitDelivered`, `turn.step.interrupted` and `turn.step.retrying` are removed; `interruptionReminder.requested` arrives. Metadata adds `min_protocol_version: "1.5"` | exact-type reducers in `src/metrics.mjs`; `test/wire-row-classes.test.mjs` | **covered / no-op**. `wire-events-2.6.1.jsonl` carries all four record deltas and the metadata; reducer, persisted-state and render comparisons match the stripped baseline and leak no payload content. |
| `turn.prompt` adds optional `trigger: normal | notify | continue`; `turnProjection.ts` publishes it even when the replayed entry's origin defaults to user | `src/metrics-turn.mjs`, generation summary | **P1 fixed on this branch**. An explicit non-normal trigger now wins over `origin.kind`; missing trigger retains legacy origin behavior and normal is the positive control. Before the fix, the fixture moved `lastUserPromptAt` to continue and shortened settled gen from 11,000 ms to 1,000 ms. |
| `task.started` / `task.terminated` keep `info.taskId/kind/status`, but `AgentTaskPersistence` removes JSON lifecycle sidecar writes. Output logs remain under task-specific directories | `src/metrics-tasks.mjs` wire reducer and legacy sidecar reconcile | **covered**. Current hosts use the durable Ops; old sidecars remain a bounded fallback. No task description, command or output enters the HUD. The reference/full-pipeline fixtures already run without sidecars. |
| `tui/config.ts` leaves unset `tui_mode` undefined and renders `# tui_mode = "regular"`; #4771 adds per-process boolean env override, experimental-default fullscreen and tmux -CC / Termux / TERM=dumb fallback. `[transcript]` and `copy_on_select` are additive | `src/toml.mjs`, `src/management-service.mjs`, `hooks/sync-status-line.mjs`; KI-8 | **covered at source/fixture level**. New install/uninstall and hook cases preserve comments, transcript values and status-line items byte-for-byte. The README/KI-8 entry wording is updated; live 2.6.1 fullscreen/default/fallback acceptance remains open. |
| SessionStart hooks now receive `metadata.effectiveCwd`; plugin skill discovery adds variants. The hook runner and plugin manifest shape remain in place | `hooks/sync-status-line.mjs`, `kimi.plugin.json` | **covered / unread**. The HUD hook reads its environment and edits only `tui.toml`, not hook cwd or skill discovery. Existing lifecycle tests still apply. |
| `managed-usage.ts` (`7bfcd86e2e`) and `managed-kimi-code.ts` (`8848966299`) are byte-identical; the only `packages/oauth` source delta is custom-registry `google-genai` support. Internal credential-provider refactors do not change the credential-file mapping | `src/quota.mjs`, `src/model-config.mjs`, provider credential boundary | **covered**. `/usages`, region/credential slots and token wire names remain the HUD contract; no token is newly read, logged or cached. Custom-registry additions do not relax official-host provider attribution. |
| Slash registry (blob `41d4c03898`), permission display mapping (`2af45dc84c`), thinking config (`79dff43239`) and working-tip component (`23d0027389`) are byte-identical; `git-status.ts` is absent from the complete changed-path list | permission/model/Git rendering | **covered**. Stable ids and display values were checked separately. The three official permission labels and existing slash-command documentation need no rewrite. |

## Display parity search

The replaced old words and moved/default tokens were searched in `README.md`,
`README.en.md`, `CAPABILITIES.md`, `KNOWN_ISSUES.md`, `CHANGELOG.md`, `src/`,
`test/`, `docs/` and fixtures. Results and decisions:

| Old word / moved token | Hits and decision |
|---|---|
| explicit `tui_mode = "regular"` as the default; one-time `KIMI_CODE_TUI_FULL_SCREEN` migration | Current KI-8/README wording was updated. New management/hook fixtures use the commented guide. The 2.2.0 review carries a superseded note; 2.5.3's prep statement remains accurate history. |
| `ctrl+o` / `ctrl-o` tool-output hint | Current CAPABILITIES now records grouping suppression. Historical reviews and changelog retain their release-specific claims. The HUD does not draw this host-owned hint. |
| `task.waitDelivered`, `turn.step.interrupted`, `turn.step.retrying` | Existing hits are historical changelog/archive entries. The new fixture deliberately carries them as legacy no-op rows; current docs record their removal rather than rewriting history. |
| `click a group summary to reveal every tool call`, `tool_call_density`, `copy_on_select` | No old HUD display contract owned these strings. They are documented only as host config/presentation changes; the HUD does not render transcript groups. |
| Permission display names and slash-command names | Byte-identical mapping and registry; no old display token needed replacement. Stable ids were not used to infer display parity. |
| `2.5.3` as the current baseline | Advanced in both READMEs, CAPABILITIES, KNOWN_ISSUES, both showcase `CLI_VERSION` constants and the cold/remote payload fixtures. Historical release sections intentionally remain. |

## Findings

**P0: none.** No unusable, unsafe or data-destroying change reaches the HUD.

**P1 fixed:** released `turn.prompt.trigger` could let a notify/continue replay
with a user origin reset the HUD's generation anchor. The reducer now uses the
explicit trigger, with direct-fold, persisted-state, metrics and render parity
against legacy semantic equivalents.

**P2:** the built-in environment id/status slot remains unrendered; current-host
sidecar retirement is covered by wire records, not a badge regression. KI-8's
current-version live fullscreen matrix, KI-20 real-host acceptance and real
remote/managed-account/DeepSeek checks remain open. Documentation and synthetic
fixtures do not close those manual gaps.

**Unable to judge:** real 2.6.1 classic/fullscreen frames, resize/reload/failure
frames, experimental-default and terminal-fallback launches, a real remote
environment, and live managed-account/provider responses.

## Watch carry-over

- [HUD #70](https://github.com/FinbackYu/kimi-code-hud/issues/70), upstream
  #4771: **fix on the released line**. Official compare from its merge commit to
  2.6.1 is `ahead`, and the target source contains the new resolver. Current
  docs and config fixtures are updated; live acceptance stays explicitly open in
  KI-8 rather than being claimed by this review.
- [HUD #74](https://github.com/FinbackYu/kimi-code-hud/issues/74), stable 2.6.0:
  **covered by the 2.6.1 target**. Baseline, manifest, payload/wire fixtures,
  prompt-trigger behavior, cwd provenance and TOML preservation are all addressed
  here rather than stopping at the superseded 2.6.0 target.
- [HUD #73](https://github.com/FinbackYu/kimi-code-hud/issues/73), upstream
  #4754: **prep, not released in 2.6.1**. Official compare from merge
  `482936afceaec4d513aa28f7b7e6b461e35e105f` to the target is `diverged`; the
  target manifest still has only loop/compaction and session/turn. Work is assigned
  to `upstream/2.7.0-prep`; no prediction behavior is claimed on this branch.
- [HUD #75](https://github.com/FinbackYu/kimi-code-hud/issues/75), upstream
  #4820: **prep, not released in 2.6.1**. Official compare from merge
  `aced52f218f286f25cebd82479cef1bcba87cad7` to the target is `diverged`.
  Historical 2.5.3 timing fixtures were not relabeled as new-boundary evidence;
  the 250 ms / 1000 t/s thresholds stay unchanged pending released samples.
- Repo-Overwatch's local report tree has no report after 2026-09-03, so there is
  no additional unconsumed WATCH input. Monitor-owned issue titles and bodies were
  left untouched; triage was recorded in comments only.

## Verification and limits

- The new prompt-trigger scenario failed before the consumer fix in both direct
  fold and full pipeline: the user anchor advanced to continue and settled gen
  became 1,000 ms instead of 11,000 ms. After the one-condition reducer change,
  the focused timer/row-class run reports 60 pass / 0 fail.
- The management/SessionStart run reports 20 pass / 0 fail, including install
  idempotence, uninstall restoration and byte-exact preservation of the 2.6.1
  comment/transcript/status-line shapes.
- The complete `npm test` run reports 851 tests: 850 pass, 0 fail and one
  existing Windows-only skip. `node --check` passes for every changed `.mjs`
  (`src/metrics-turn.mjs`, the contract, row-class, management and SessionStart
  tests); `git diff --check` is clean. The real CLI `--help` succeeds and the
  empty-input fallback prints `kimi-code-hud`.
- No real user configuration, credential or session data is used by these tests.

The official upstream checkout's HEAD was not moved and its working tree stayed
clean. Only the exact official 2.6.1 annotated tag and its required objects were
fetched under the baseline-review exception; no upstream source, documentation,
branch, config or test was modified. No HUD commit, push, merge or release is
implied by this review.
