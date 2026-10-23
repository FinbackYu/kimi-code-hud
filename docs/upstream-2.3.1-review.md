# Kimi Code 2.3.1 upstream review

Reviewed: 2026-10-23. This document audits the HUD code against the released
source and synthetic fixtures. It does not establish live 2.3.1 TUI acceptance
or a HUD release.

## Release identity and range

| | Previous | Target |
|---|---|---|
| Release | `@moonshot-ai/kimi-code@2.2.0` | `@moonshot-ai/kimi-code@2.3.1` |
| Annotated tag object | `f9c6b3cfa0c232e651136b801c616df7e710a66b` | `71a07ca316d31cea0db4adbf6a032e8bda8143f9` |
| Peeled commit | `472192c34c1efad89a369870eff0da0b708ce9bb` | `684bae9ea6a437f3bae98bba1dcb797a917d500b` |

The target release was published at 2026-10-23 07:31:21 UTC. Unlike the
previous audit range, this one is **not linear**: `472192c34c` is not an
ancestor of `684bae9ea6`, and the merge base is `c69bd6c5a0`. The counted range
`2.2.0^{}..2.3.1^{}` therefore contains 37 commits and 481 changed paths
(+27,446/−8,387), and it carries the 2.3.0 release plus the 2.3.1 patch
release. Release-tag lookups need the fully scoped tag name —
`git rev-parse '2.3.1^{}'` reports an unknown revision.

All source links below pin the target commit; the official checkout HEAD was
not moved and its working tree stayed clean.

## Contract and presentation decisions

| Upstream evidence | HUD entry point | Result |
|---|---|---|
| [`status-line-command.ts`](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/apps/kimi-code/src/tui/utils/status-line-command.ts) is byte-identical at both endpoints (blob `6482a4ac7c`): the 10 fields (`gitBranch: string \| null` included), the first stdout line, the 300 ms timeout and the 1 s refresh contract are unchanged | `src/payload.mjs`, `src/render-runtime.mjs`, `src/hooks.mjs` | **covered** by the existing parser/render/lifecycle tests; real 2.3.1 TUI behaviour remains unverified. |
| [`git-status.ts`](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/apps/kimi-code/src/utils/git/git-status.ts) is rewritten by PR #4201 (first released in 2.3.0): `getStatus()` only reads a cache, the first read / a 30 s status TTL expiry / a HEAD change / an explicit `refresh()` schedule a background `git status`, HEAD is polled every 2 s, and the spawn timeout grows 500 ms → 2 s. A first frame inside a repository legitimately carries `gitBranch: null` | `src/render-runtime.mjs` branch resolution, `src/render.mjs` `git:(branch*)` | **variant, now on the normal path**: the HUD's own `.git/HEAD` read runs whenever the payload has no branch, but only after a filesystem-only check proves a symbolic branch exists; a payload branch still wins, and a detached HEAD or non-repository still renders no branch. Covered by `test/render-runtime.test.mjs` ("fills a null payload branch", "keeps the payload branch authoritative", "skips the Git probe when there is no symbolic HEAD") and `test/render.test.mjs`. |
| [`footer.ts`](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/apps/kimi-code/src/tui/components/chrome/footer.ts) changes only in Git-cache lifecycle: `gitCache.dispose()` on a workDir change and in `dispose()`, plus a `refreshGitStatus()` entry point. No label, slot order or line-2 change | `src/render.mjs` line-1 slots | **covered / host-owned**: nothing to redraw differently; line 2 stays the host's. |
| [`wire-manifest.d.ts`](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/packages/agent-core-v2/docs/wire-manifest.d.ts) grows 64 → 65 with `changeNotifier.snapshot` (`agentId`, `agentsMdHash`, `agentsMdFiles`, `skillsHash`, `subagentNames`, optional `modelPool`); no record is removed or renamed, and the record also joins the change-notifier state of `context.*` rows | `src/metrics.mjs` reducers gate on exact types; `test/wire-row-classes.test.mjs` | **covered / no-op**: new positive fixture `wire-events-change-notifier-snapshot.jsonl` (populated and all-null forms) plus the suite's fold and baseline comparisons. |
| [`tui/config.ts`](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/apps/kimi-code/src/tui/config.ts): `auto_session_title` is a new optional top-level key whose default is `true` and which the TUI always writes; PR #4272 moves the session-rating opt-out to `config.toml`, so `disable_feedback_survey` is only rewritten when it already existed (`removeLegacySurveySetting` clears it) | `src/toml.mjs`, `hooks/sync-status-line.mjs`, `src/management-service.mjs` | **covered**: the HUD only adds or removes `[status_line]`'s `command`. `test/management-service.test.mjs` gained a 2.3.x-shaped `tui.toml` round-trip (install twice is idempotent, uninstall restores the file byte-for-byte, `auto_session_title` and the absent legacy key are preserved). |
| [`node-sdk/config/schema.ts`](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/packages/node-sdk/src/config/schema.ts) adds `upgrade` to `ModelAliasBaseSchema` (`model`, `migrationMarkdown`, optional `retirementAt`), persisted as the `[models."<alias>".upgrade]` subtable by `config/toml.ts`; the persisted model keys (`support_efforts`, `default_effort`, `capabilities`, `max_context_size`, `display_name`) and the `managed:kimi-code` provider constant are unchanged | `src/model-config.mjs`, `src/thinking.mjs`, `src/quota.mjs` | **covered / additive**: `findModelTable` / `resolveModelConfig` stop a table body at the next `[`, and smol-toml writes scalars before subtables, so the scalar keys stay visible. `test/render-runtime.test.mjs` gained an end-to-end case where `[models."x".upgrade]` subtables leave provider attribution and the quota gate unchanged and leak no migration text. |
| `config.toml` also gains a top-level `disable_feedback_survey` mirror and `[mcp].default_deferred` (PR #4210, on-demand MCP tools behind the experimental tool-select flag) | none | **host-owned**: the HUD reads neither key. |
| [`managed-kimi-code.ts`](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/packages/oauth/src/managed-kimi-code.ts) switches `/models` ingestion to the unified schema (`limit.context`, `modalities.input`, `reasoning.{type,effort}`) | `src/quota.mjs`, `src/model-config.mjs` | **variant at the ingestion layer only**: the aliases written into `config.toml` and the `capabilitiesForModel` value set are unchanged. |
| `managed-usage.ts` (`7bfcd86e2e`), `region.ts`, `permission-mode.ts` (`6df9eb1d09`), the slash-command registry (43 entries, `e4ad7ab480`), `thinking-config.ts`, `working-tips.ts`, `app/plugin/{manifest,manager}.ts` are absent from the 481-path list or byte-identical | payload parsing, permission names, quota, plugin lifecycle | **covered**: no HUD entry point changed. |
| A cross-process session-lock service is new (`persistence/backends/node-fs/sessionLockService.ts`, `<KIMI_CODE_HOME>/locks/sessions/`), and `wire/wireService.ts` gates journal rewrites on it (`pendingRewrite`) | `src/wire-reader.mjs`, `src/metrics.mjs` cursor | **covered**: the HUD never reads the lock directory, and its cursor already detects a rewritten journal through size / inode / tail-digest fingerprints, so a rewrite re-folds instead of reading stale offsets. |
| PR #4242 runs user hooks in the session project directory (`hook.cwd ?? trigger.cwd`); the plugin hook keeps `cwd: record.root` | `hooks/sync-status-line.mjs` | **host-owned**: the plugin hook's relative-path semantics are unchanged; the HUD uses no user hooks. |
| PR #4294 (model-switch confirmation, `/compact` queueing), #4188 (qualified plugin skill names, looser plugin-name regex), #4250 (`dangerous_command_guard` scope), #4272 (rating opt-out), #4348 (session lock takeover, `KIMI_CODE_SESSION_LOCK=0`) | — | **host-owned**, no HUD consumer; `kimi-code-hud` stays a legal plugin name under the loosened regex. |

Display parity search covered `README.md`, `README.en.md`, `CAPABILITIES.md`,
`KNOWN_ISSUES.md`, `CHANGELOG.md`, `docs/`, `src/`, `test/` and the fixtures
for the tokens this range replaced, removed or moved:

| Old word / moved token | Hits in the HUD repo | Decision |
|---|---|---|
| `disable_feedback_survey` | only `docs/capabilities-archive.md` (host-owned note added by this review) | no HUD consumer; recorded as a host-side `tui.toml` → `config.toml` move |
| `context_length`, `think_efforts`, `supports_thinking` | 0 hits | no parity work |
| `default_deferred`, `KIMI_CODE_SESSION_LOCK`, bare plugin skill names | 0 hits | host-owned |
| `Always Ask` / `Ask When Needed` / `Never Ask` | `src/render.mjs`, `README*.md`, `CAPABILITIES.md`, tests, showcase | `permission-mode.ts` is byte-identical at both endpoints, so the labels and their semantics are unchanged |
| `2.2.0` as the audited baseline | `CAPABILITIES.md`, `KNOWN_ISSUES.md`, `README*.md`, showcase pages, `status-line-payload-cold-git.json`, two test comments, `src/render-runtime.mjs` | advanced to `2.3.1` / peeled `684bae9ea6`; `HUD_VERSION` untouched (release skill) |

## Findings

**P0: none.** No unusable, unsafe or data-destroying change reaches the HUD.

**P1: none.** The status-line seam is byte-identical, footer slot ownership is
unchanged, and every additive config/wire key is either unread or already
tolerated by an existing parser shape.

**P2 — all resolved on this branch:**

1. The KI-2 / `CAPABILITIES.md` narrative that "PR #4201 has not shipped, so
   the HEAD fallback stays off the normal rendering path" was false for 2.3.x.
   Both files now describe the asynchronous host cache and treat the HUD's own
   HEAD read as a regular display path; the archive records the same in the new
   delta.
2. Stale "prep / not shipped" comments in `src/render-runtime.mjs` and
   `test/render-runtime.test.mjs` were rewritten to the shipped fact.
3. The manifest count (`64` → `65`), the `changeNotifier.snapshot` no-op entry,
   the `models.*.upgrade` readable-but-unrendered row, and the row-class fixture
   comment were all updated, with a new fixture and scenario.
4. The baseline move would have failed the repo's own gate: the two showcase
   pages now carry `CLI_VERSION = '2.3.1'`, and
   `docs/upstream-2.3.1-review.md` was added to the `.gitignore` allow-list so
   the file is actually tracked.

**Unable to judge:** the real duration of a 2.3.1 first-frame
`gitBranch: null` and how the HUD fallback feels in a live TUI; the 2.3.x
fullscreen frame (KI-8); the real 2.3.1 trust-store and session-lock behaviour
(the HUD reads neither); and real managed-account / DeepSeek figures. All of
these need a live host session.

Note on additive fields: `changeNotifier.snapshot`, `[mcp].default_deferred`,
`auto_session_title`, the config-level `disable_feedback_survey` mirror and
`models.*.upgrade` are additive and not consumed by the HUD. "No test failed"
is not evidence about them; they were checked against the changed-path list and,
for the two that touch a HUD parser (`models.*.upgrade`, `tui.toml` keys), with
dedicated regressions.

## Watch carry-over

- [HUD #54](https://github.com/FinbackYu/kimi-code-hud/issues/54), upstream
  #4201: **closure evidence recorded by this review**. PR #4201 is part of the
  2.3.0 release, the HUD's null-branch HEAD fallback has shipped since v0.8.5
  with regressions for the payload-branch, detached-HEAD and non-repository
  cases, and this branch rewrites the docs, comments and the cold-Git fixture
  so they describe a released host instead of prep. Nothing on the HUD side is
  left open; closing the issue (comment + close, body untouched) is a
  coordination step, not a code change.
- [HUD #58](https://github.com/FinbackYu/kimi-code-hud/issues/58), upstream
  #4200: **follow-up landed**. 2.3.0 flips automatic session titles to
  `auto_session_title = true` and shows the title as the terminal window title;
  the title is fetched directly from the gateway and never enters the wire, so
  it cannot pollute TPS, usage or cost. `docs/capabilities-archive.md` marks the
  0.36.1 "default-off" statement as superseded, `CAPABILITIES.md` records the
  key as host-owned and unread, and this document registers the terminal window
  title as host-owned. Closure is the same coordination step.
- Input list: the audit report's carry-over section (HUD #54, #58). No new
  Repo-Overwatch report file exists after 2026-09-03, so there was no further
  WATCH input to consume.

## Verification and limits

`npm test` reports 825 pass, 0 fail and one existing Windows-only skip (826
tests total; the pre-change baseline was 820 pass from 821 tests). The five new
tests are the three `changeNotifier.snapshot` scenario checks, the 2.3.x
`tui.toml` round-trip and the `[models."x".upgrade]` quota-gate case.
`KIMI_HUD_RELEASE_CHECK=1 node --test test/release-metadata.test.mjs` reports
10 pass, including the showcase `CLI_VERSION` / `HUD_VERSION` assertions.
`node --check` passes for every changed `.mjs` (`src/render-runtime.mjs`,
`test/render-runtime.test.mjs`, `test/wire-row-classes.test.mjs`,
`test/management-service.test.mjs`) and `git diff --check` is clean.

No runtime behaviour changed: no render, metrics, quota or provider-usage
assertion had to be edited, which is the expected outcome for an additive
manifest entry and two host-owned config keys.

Source and fixture checks do not prove live rendering, real quota or DeepSeek
access, Windows 2.3.x behaviour or a HUD release. No live 2.3.x TUI session was
run for this review, and no real user configuration was read or written. The
official upstream checkout stayed untouched; tag, range and source claims above
come from `git cat-file`, `git rev-parse`, `git show`, `git diff` and
`git grep` against locally present official tag objects, and the publish time
comes from the annotated tag's tagger date.
