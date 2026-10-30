# Kimi Code 2.4.0 upstream review

Reviewed: 2026-10-30. This document audits the HUD against released source and
synthetic fixtures, plus an isolated real-CLI render. It does not establish a
live 2.4.0 TUI acceptance or a HUD release.

## Release identity and range

| | Previous | Target |
|---|---|---|
| Release | `@moonshot-ai/kimi-code@2.3.1` | `@moonshot-ai/kimi-code@2.4.0` |
| Annotated tag object | `71a07ca316d31cea0db4adbf6a032e8bda8143f9` | `b8f43387e0b4af152fbdcb3c6f78c432f15fb649` |
| Peeled commit | `684bae9ea6a437f3bae98bba1dcb797a917d500b` | `f26e4d91ef8d5d233f6c20b42a150f96924d4f5e` |

The target is a non-draft, non-prerelease published at 2026-10-28 11:45:13
UTC. The range is **not linear**: the previous peeled commit is not an ancestor
of the target, and the merge base is `ce0834a8f301b89cc4523499a3e074c36851de8f`.
The counted `2.3.1^{}..2.4.0^{}` range contains 49 commits; the endpoint diff
has 705 changed paths (+36,823/−11,475). Release-sync merges carry the 2.3.2
and 2.3.3 changes into this range.

The complete path list and diff stats were materialized and queried with:

```sh
git diff --name-only "$previous" "$target" > .tmp/upstream-2.4.0-review/changed-paths.txt
git diff --name-status "$previous" "$target" > .tmp/upstream-2.4.0-review/changed-name-status.txt
git diff --stat "$previous" "$target" > .tmp/upstream-2.4.0-review/diff-stat.txt
```

Claims of absence or byte identity below use that complete list or paired
`git rev-parse <tag>:<path>` blob ids, not a sample of the diff. Source links
pin the target peeled commit.

## Contract and presentation decisions

| Upstream evidence | HUD entry point | Result |
|---|---|---|
| [`status-line-command.ts`](https://github.com/MoonshotAI/kimi-code/blob/f26e4d91ef8d5d233f6c20b42a150f96924d4f5e/apps/kimi-code/src/tui/utils/status-line-command.ts) is byte-identical (blob `6482a4ac7c`): 10 fields, first stdout line, 65,536-byte capture cap, 300 ms timeout, 1 s rerun and cached-last-good-frame behavior are unchanged | `src/payload.mjs`, `src/render-runtime.mjs`, `src/hooks.mjs` | **covered** by existing parser/runtime/lifecycle tests. Failure, empty output, malformed input and timeout fallbacks do not change; live 2.4.0 TUI behavior remains unverified. |
| [`footer.ts`](https://github.com/MoonshotAI/kimi-code/blob/f26e4d91ef8d5d233f6c20b42a150f96924d4f5e/apps/kimi-code/src/tui/components/chrome/footer.ts) (`d9fd3868f3`) and [`git-status.ts`](https://github.com/MoonshotAI/kimi-code/blob/f26e4d91ef8d5d233f6c20b42a150f96924d4f5e/apps/kimi-code/src/utils/git/git-status.ts) (`380015fecb`) are byte-identical | `src/render.mjs`, `src/render-runtime.mjs`, `src/git-safe-probe.mjs` | **covered / degraded as previously documented**: line-1 slots and host-owned line 2 do not move; the 2.3.1 asynchronous Git-cache narrative remains current. KI-2 fidelity and KI-20 live acceptance stay open. |
| [`wire-manifest.d.ts`](https://github.com/MoonshotAI/kimi-code/blob/f26e4d91ef8d5d233f6c20b42a150f96924d4f5e/packages/agent-core-v2/docs/wire-manifest.d.ts) grows 65 → 67 with `mcp.server_failed` and `mcp.server_failure_resolved`; payloads carry `agentId`, `serverName`, `transport`, optional `error`, and `resolution` on recovery | exact-type reducers in `src/metrics.mjs`; `test/wire-row-classes.test.mjs` | **covered / no-op**: `wire-events-mcp-failures.jsonl` includes both classes, stdio/http and an absent optional error. Metrics, persisted state and render match the stripped baseline; no server error text reaches the HUD. |
| [`swarmOps.ts`](https://github.com/MoonshotAI/kimi-code/blob/f26e4d91ef8d5d233f6c20b42a150f96924d4f5e/packages/agent-core-v2/src/features/swarm/swarmOps.ts) returns the prior state for `trigger === "tool"`; transcript `foldFacts.ts` likewise only marks swarm active when the trigger is not `tool` | `src/metrics-session-meta.mjs`, swarm badge and fleet orchestration | **P1 fixed for issue #62**: the HUD now uses the same predicate. A tool-only row stays off; tool→manual is on; tool→exit is off; a legacy missing trigger retains the old enabled behavior. `wire-events-legacy-tool-swarm.jsonl` fails the old implementation in reducer, state and render comparisons. |
| Plan mode becomes user-entered and every plan waits for review. `permission-mode.ts` changes the Never Ask description, while all three display names and stable ids are unchanged; `planMode` remains a payload boolean | `src/payload.mjs`, permission labels in `src/render.mjs` | **covered / host-owned semantics**: no label or payload mapping changes. The HUD does not reproduce the longer permission descriptions. |
| The slash registry grows 43 → 44 with `/import-sessions`; `/provider refresh [providerId]` is added without a new registry entry | none; the HUD defines no slash commands | **host-owned**. Provider refresh can rewrite host model catalogs, but the SDK model-table schema used by the HUD is unchanged. |
| `constant/tips.ts` changes the `/auto` tip to disclose Plan-mode review; the old input-area todo panel and `Ctrl-T` shortcut are removed | rotating tips are intentionally omitted | **host-owned / no parity work**. The HUD does not copy those tips, panels or shortcuts. |
| `tui/config.ts` is byte-identical (`c4dd547a09`). The SDK config schema adds `[mcp].reconnect_initial_delay_ms` and `reconnect_max_delay_ms`; no status-line or model-table key changes | `src/toml.mjs`, `src/management-service.mjs`, `src/model-config.mjs` | **covered / additive**: install/uninstall still edits only `[status_line].command`; the HUD reads neither MCP retry key. Existing unrelated-TOML preservation tests remain valid. |
| `managed-usage.ts` (`7bfcd86e2e`) and `managed-kimi-code.ts` (`8848966299`) are byte-identical. PR #4311 adds logged-out region inference through `region.json`, marker/cache/local signals | `src/quota.mjs`, credential context and official-host whitelist | **covered without widening trust**: authenticated quota payload and credential layouts are unchanged. Logged-out inference supplies no credential and is not a HUD quota source; env → oauth-ref → official endpoint checks remain fail-closed. No token or region cache is newly read or stored. |
| Plugin manifest/manager files are byte-identical. Idle web/desktop sessions may unload after 30 minutes and resume as `reclaimed`; SessionStart/SessionEnd hooks are suppressed for that internal transition | `kimi.plugin.json`, `hooks/sync-status-line.mjs` | **covered / host-owned**: normal startup/resume hook semantics and plugin manifest shape are unchanged; avoiding duplicate hooks on reclaim needs no HUD mutation. |
| Session import writes through `migration-legacy` into the standard session layout. Idle reclaim changes in-memory ownership, not directory naming; append-log changes add failure diagnostics, not a rotation format | `src/session-locator.mjs`, `src/wire-reader.mjs`, `src/session-files.mjs` | **covered by existing bounded readers**: current and legacy session candidates, append-only wire reads and rewrite fingerprints remain applicable. A real imported-session continuation and idle-reclaim session were not exercised. |
| Subagent stopped-run partial output changes task output text; task lifecycle and sidecar schemas do not change. Tower concurrency and per-spawn model selection do not add HUD inputs | `src/metrics-tasks.mjs`, `src/session-usage.mjs` | **covered / no-op for badges**. KI-15's bounded resume heuristic stays. Mixed-provider per-worker models remain fail-closed for Session Cost rather than undercounted. |
| OSC 7501 terminal status reporting, fullscreen docks and compaction activity are host presentation changes; no new HUD stdout or dynamic-text source appears | 220 ms internal frame deadline, ANSI/control sanitizers | **covered / host-owned**. The 300 ms host / 220 ms internal budgets, silent failure and OSC/CSI/ESC/C0/DEL/C1 defenses are unchanged. |

## Display parity search

The replaced old words and moved/default tokens were searched in `README.md`,
`README.en.md`, `CAPABILITIES.md`, `KNOWN_ISSUES.md`, `CHANGELOG.md`, `src/`,
and all tests/fixtures. The runtime/user-documentation scopes below had zero
hits; intentional references in this review and the capabilities archive are
decision records, not stale UI copy.

| Old word / moved token | Hits and decision |
|---|---|
| `Never interrupts you`, `everything runs and is decided automatically`, `/auto ... keep going unattended` | 0 hits. The HUD keeps only the unchanged `Never Ask` badge, not the old description. |
| `Tools and plan changes`, `plan changes` | 0 hits. No HUD wording claims that Never Ask approves plans automatically. |
| `Ctrl-T`, `ctrl+t` | 0 hits. Host-owned shortcut; nothing to remove from the HUD. |
| `default_plan_mode`, `max_running_tasks` | 0 hits. The HUD does not read or document these host defaults. |
| `/import-sessions`, `/provider refresh` | 0 hits in runtime, tests and user docs. These are host capabilities, recorded here and in the archive rather than presented as HUD commands. |
| `2.3.1` as the current baseline | Advanced in both READMEs, `CAPABILITIES.md`, `KNOWN_ISSUES.md`, both showcase `CLI_VERSION` constants and the cold-Git payload fixture. Historical release reviews, changelog entries and “since 2.3.1” technical history intentionally remain. |

The official display-value table was also checked independently of stable ids:
`manual → Always Ask`, `yolo → Ask When Needed`, `auto → Never Ask` is unchanged,
so the HUD's existing official and short badge maps remain correct.

## Findings

**P0: none.** No unusable, unsafe or data-destroying change reaches the HUD.

**P1: issue #62, fixed on `fix/62-legacy-tool-swarm`.** Before the fix, an
unfinished legacy tool-triggered swarm row restored `swarmMode: true`, which
could leave a false `[swarm]` badge and alter fleet-speed composition. The new
counterexamples failed in three places on the old reducer and pass after it.

**P2: resolved on the same branch.** The two additive MCP record classes gained
positive no-op fixtures; the 2.4.0 baseline, pinned links, manifest count,
showcase versions, bilingual swarm behavior and historical archive were moved
forward together.

**Unable to judge:** a live 2.4.0 classic/fullscreen TUI frame, resize/reload/
failure-frame behavior, real managed-account and DeepSeek responses, real-host
Git-filter acceptance, and live imported-session / idle-reclaim behavior. Those
remain manual acceptance gaps, not passes inferred from source or fixtures.

## Watch carry-over

- [HUD #62](https://github.com/FinbackYu/kimi-code-hud/issues/62), upstream
  #4384: implementation and source/fixture checklist items are covered on the
  branch. A triage comment was posted without editing the monitor-owned title
  or body. The issue stays open until the branch lands and the next HUD release
  note records the user-visible fix.
- The open remote issue inventory contained no other issue and no other open
  `upstream-watch` item. Repo-Overwatch's local report tree has no report after
  2026-09-03, so there is no additional unconsumed WATCH input from that tree.

## Verification and limits

- The focused reducer/row-class run reports 60 pass, 0 fail after the fix.
- The complete `npm test` run reports 842 tests: 841 pass, 0 fail and one
  existing platform-specific skip.
- `KIMI_HUD_RELEASE_CHECK=1 node --test test/release-metadata.test.mjs` reports
  10 pass, including both showcase `CLI_VERSION` checks.
- `node --check` passes for `src/metrics-session-meta.mjs`,
  `test/metrics-wire-folding.test.mjs` and `test/wire-row-classes.test.mjs`;
  `git diff --check` is clean.
- An isolated real `bin/kimi-hud.mjs` render used temporary HOME /
  KIMI_CODE_HOME / KIMI_HUD_HOME roots. The legacy tool fixture rendered
  `[Always Ask] K3 high …` without `[swarm]`; the manual control rendered
  `[Always Ask] [swarm] …`. No real user configuration or credential was read.

The official upstream checkout's HEAD was not moved and its working tree stayed
clean. Only the exact official 2.4.0 annotated tag and its required objects were
fetched under the baseline-review exception; no upstream source, documentation,
branch, config or test was modified. No HUD commit, push, merge or release was
performed by this review.
