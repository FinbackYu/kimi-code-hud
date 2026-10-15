# Kimi Code 2.2.0 upstream review

Reviewed: 2026-10-15. This document audits the HUD code against the released source and synthetic fixtures. It does not establish live 2.2.0 TUI acceptance or a HUD release.

## Release identity and range

| | Previous | Target |
|---|---|---|
| Release | `@moonshot-ai/kimi-code@2.1.0` | `@moonshot-ai/kimi-code@2.2.0` |
| Annotated tag object | `93a83aafacf91cc595a7b66f0ecb637f23859f77` | `f9c6b3cfa0c232e651136b801c616df7e710a66b` |
| Peeled commit | `52437299ff78de3d0aff7f38f054e5eb20c512e5` | `472192c34c1efad89a369870eff0da0b708ce9bb` |

The target release was published at 2026-10-14 15:31:16 UTC. The previous
commit is an ancestor of the target. The exact range has 40 commits, 522
changed paths and +27,728/−18,273 lines, and includes the 2.1.1 patch release
(published 2026-09-24). All source links below pin the target commit; the
official checkout HEAD was not moved and the working tree stayed clean.

## Contract and presentation decisions

| Upstream evidence | HUD entry point | Result |
|---|---|---|
| [`status-line-command.ts`](https://github.com/MoonshotAI/kimi-code/blob/472192c34c1efad89a369870eff0da0b708ce9bb/apps/kimi-code/src/tui/utils/status-line-command.ts) is byte-identical across the range and [`footer.ts`](https://github.com/MoonshotAI/kimi-code/blob/472192c34c1efad89a369870eff0da0b708ce9bb/apps/kimi-code/src/tui/components/chrome/footer.ts) is not in the 522-path list at all; the 10 fields (`gitBranch: string \| null` included), the first stdout line, the 300 ms timeout and the 1 s refresh contract are unchanged | `src/payload.mjs`, `src/render-runtime.mjs`, `src/hooks.mjs` | **covered** by the existing parser/render/lifecycle tests; real 2.2.0 TUI behaviour remains unverified. |
| [`wire-manifest.d.ts`](https://github.com/MoonshotAI/kimi-code/blob/472192c34c1efad89a369870eff0da0b708ce9bb/packages/agent-core-v2/docs/wire-manifest.d.ts): 64 record types at both endpoints, no additions, removals or renames. The only payload change is `TowerModeEnterPayload` dropping the optional `base` field (and the `tower.base` state on `tower_mode.enter` / `tower_mode.exit`) | `src/metrics-session-meta.mjs` folds those two records **by type** | **covered / no-op**: the HUD never read `base`, and its five-class `subagent.*` fixture still matches the release. `subagent.completed.usage`/`contextTokens` stay outside the session usage ledger. |
| `usage.record` and the managed `/usages` seams are absent from the changed-path list; among usage-named source files the only one touched is `agent-core-v2/src/agent/usage/usageEvents.ts`, which adds optional `towerExitReason`/`permission` to `AgentStatusUpdatedPayload` (elsewhere under `agent/usage/` only `cacheProbeService.ts` gained parent-request telemetry fields — no wire impact — plus one test file) | cost ledger (`src/session-usage.mjs`, `src/provider-cost.mjs`), quota (`src/quota.mjs`) | **no direct source delta**; the HUD does not fold `agent.status.updated` (it reads the permission mode from the payload). |
| `USER_MESSAGE_BULLET` changes from `✨ ` to `❯ ` in `apps/kimi-code/src/tui/constant/symbols.ts` (PR #4031, plus the fullscreen sticky summary pill) | HUD renders no transcript; the published showcase pages are a 1:1 replica of the host start page | **variant, updated**: both showcase pages and the two exported PNGs now carry `❯`. Host-owned otherwise. |
| `tui_mode` stays a host preference; `tui/config.ts` is byte-identical across the range, and `KIMI_CODE_TUI_FULL_SCREEN` survives only as a one-time migration into `tui_mode` | HUD owns a custom line; the host owns context/hints and the fullscreen layout | **host-owned / unverified live** (KI-8). The entry procedure in `KNOWN_ISSUES.md` now names `tui_mode = "fullscreen"`. |
| PR #4013 (2.1.1) reverts the 2.1.0 trust hardening: `git-args.ts` is deleted and `git-status.ts` returns to plain synchronous Git calls | `src/git.mjs`, `src/git-safe-probe.mjs` probe Git themselves | **covered / HUD-held**: the HUD keeps `core.fsmonitor=false`, a null `core.hooksPath` and the index-metadata probe as its own pre-trust defense; the #3964 attribution was rewritten (KI-7, KI-20). |
| PR #4201 (`perf(tui): stop blocking the footer on git status`, merged 2026-10-14T07:09Z) is **absent from the 2.2.0 tag**: its merge commit `83a39b49ed62627c7a604b39e26d8e9d17ade296` is not in the 40-commit range, `.changeset/footer-git-refresh.md` does not exist at the tag, and `git-status.ts` still calls `spawnSync` with 5 s/15 s caches | `src/render-runtime.mjs` branch resolution | **prep, off the normal path on 2.2.0**: when the payload carries no branch the HUD reads `.git/HEAD` itself and uses the cached probe, so a future `gitBranch: null` first frame cannot blink the segment. On 2.2.0 the host resolves the branch synchronously, so the fallback stays off normal rendering; it can still fire when the host's git read fails or times out (payload `null`), which only ever shows a branch that genuinely exists in the repository. |

Display parity search covered `README.md`, `README.en.md`, `CAPABILITIES.md`,
`KNOWN_ISSUES.md`, `CHANGELOG.md`, `docs/`, `src/`, `test/` and the fixtures
for the tokens the range replaced or removed:

| Old word / removed token | Hits in the HUD repo | Decision |
|---|---|---|
| `✨` (user-message bullet) | `docs/showcase/startup-page.html`, `docs/showcase/states-gallery.html` | followed the new `❯`; PNGs regenerated and read back |
| `KIMI_CODE_TUI_FULL_SCREEN` | `KNOWN_ISSUES.md`, `README.md`, `README.en.md` | kept only as a historical marker next to the current `tui_mode` path; no instruction depends on the old switch |
| `tower.base` / `tower_base` | `docs/capabilities-archive.md` (historical), `CAPABILITIES.md` (new note) | no HUD consumer; recorded as a range delta |
| `GIT_CONFIG_ARGS` / `GIT_DIFF_ARGS` | `KNOWN_ISSUES.md` (historical, named as removed) | the HUD has no reference; the revert is now documented instead of attributed |
| `895e9d9b` + "v2.0.3 candidate" (#3970 prep pin) | `test/wire-row-classes.test.mjs`, `docs/capabilities-archive.md` | test comment re-pinned to the released 2.1.0/2.2.0 tags; the archive keeps the prep block verbatim and the new delta supersedes it |
| `install-app` | only `docs/upstream-2.0.0-review.md`, `docs/upstream-2.0.2-review.md`, `docs/capabilities-archive.md` | historical records; no user-facing string |
| `KIMI_CODE_WATCH`, `[watch] enabled` default flip (2.1.1) | 0 hits | host-owned |
| `KIMI_CODE_TRUST_WORKSPACE`, `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` | 0 hits | host-owned; the HUD neither reads nor sets them |
| permission labels, thinking suffix, slash names | 0 hits in the changed-path list (registry byte-identical, 43 entries) | no parity work |

## Findings

**P0: none.** No unusable, unsafe or data-destroying change reaches the HUD.

**P1: none.** The two seams that had been misattributed (KI-7/KI-20's upstream
premise, and the #3970 "candidate" pin) were documentation drift rather than
behavioural error, and both are corrected on this branch.

**P2:**

1. `gitBranch` first-frame window (issue #54) is prep only. Upstream PR #4201
   is merged but not released, so nothing on 2.2.0 exercises the fallback; the
   branch-resolution code path and its regressions were added ahead of the
   release, and the docs label them as prep.
2. The KI-20 acceptance item still needs a real 2.2.0 host session; the probe
   change is verified only against isolated repositories.
3. KI-8's live fullscreen verification is now two releases behind the recorded
   Windows row (2.0.0). The sticky summary pill changes only the transcript
   area, but that is a source-level claim, not an observed frame.

**Unable to judge:** the visual behaviour of the host's fullscreen sticky pill
next to HUD line 1, and real managed-account/DeepSeek figures on 2.2.0. Both
need a live host session; no fixture or source claim can settle them.

Note on additive fields: `AgentStatusUpdatedPayload.towerExitReason` and
`.permission`, and the `state-manifest.d.ts` additions, are additive and not
consumed by the HUD. "No test failed" is not evidence about them; they were
checked against the changed-path list instead.

## Watch carry-over

- [HUD #45](https://github.com/FinbackYu/kimi-code-hud/issues/45), upstream
  #3970: **covered in the reviewed HUD code** (five-class fixture, manifest
  re-pin to the 2.2.0 commit, anti-double-counting regression). The optional
  item — replacing KI-15's wire-freshness heuristic with the durable
  `subagent.*` lifecycle — is **declined with evidence**: upstream emits those
  records only from the run-spawning paths and from session init's internal
  run, so a resumed lost agent still journals nothing. Real 2.2.0 host
  acceptance and closure remain separate decisions.
- [HUD #49](https://github.com/FinbackYu/kimi-code-hud/issues/49), upstream
  #4004: **closed by this review**. KI-8 names the `tui_mode` entry procedure,
  its acceptance criterion no longer says "Kimi Code 0.38.0 with the
  experimental fullscreen mode", the support rows in both READMEs describe the
  Windows row as a 2.0.0 record made with the pre-2.1.0 switch, and the archive
  gained the 2.1.0 `tui_mode` statement.
- [HUD #51](https://github.com/FinbackYu/kimi-code-hud/issues/51), upstream
  #4013: **closed by this review**. KI-7 and KI-20 record the revert and the
  HUD-held stance, `CAPABILITIES.md` re-pins `git-status.ts` to the 2.2.0
  commit, the `#3964` comment in `src/git.mjs` and `test/git.test.mjs` names
  the self-held boundary, and the 2.1.0 review carries a post-review note
  about #44 (closed by PR #50) instead of leaving the contradiction.
- [HUD #52](https://github.com/FinbackYu/kimi-code-hud/issues/52), upstream
  #4031: **closed by this review**. Both showcase pages use `❯`, `CLI_VERSION`
  is 2.2.0 (`HUD_VERSION` stays `0.8.4`), `hud-states.js` regenerated
  byte-identically, and both PNGs were re-exported and read back showing the
  new marker and `Version: 2.2.0`.
- [HUD #54](https://github.com/FinbackYu/kimi-code-hud/issues/54), upstream
  #4201: **prep landed, issue stays open**. The parity decision (fall back to
  the HUD's own HEAD read when the payload has no branch) and its fixture are
  in place and off the normal rendering path on 2.2.0; acceptance belongs to
  the release that actually ships #4201.
- No new Repo-Overwatch report files were present since the prior baseline
  review; the five open `upstream-watch` issues were the complete input list.

## Verification and limits

`npm test` reports 625 pass, 0 fail and one existing Windows-only skip (626
tests total; the run before this branch reported 621 pass from 622 tests);
`node --check` passes for every changed `.mjs`
(`src/git-safe-probe.mjs`, `src/git.mjs`, `src/render-runtime.mjs`,
`src/render.mjs`, `test/git.test.mjs`, `test/render-runtime.test.mjs`,
`test/render.test.mjs`, `test/wire-row-classes.test.mjs`) and
`git diff --check` is clean. The null-branch regression fails against the
pre-change implementation (checked by stashing `src/`), which is what makes it
a counterexample rather than a restatement.

The showcase pipeline was re-run as documented
(`node docs/showcase/render-states.mjs && python3 docs/showcase/export-assets.py`).
`hud-states.js` came out byte-identical. The PNG export needed
`KIMI_HUD_SHOWCASE_CHANNEL=msedge` because this host has no Google Chrome
distribution for Playwright; the two PNGs were read back and show the `❯`
marker, the title bar `Kimi Code Hud 0.8.4` and `Version: 2.2.0`. No
dependency was installed.

Source and fixture checks do not prove live rendering, real quota or DeepSeek
access, Windows 2.2.0 behaviour or a HUD release. No live 2.1.0/2.1.1/2.2.0 TUI
session was run for this review, and no real user configuration was read or
written. The official upstream checkout stayed untouched; tag and source claims above
come from `git show` / `git grep` / `git diff` against the fetched 2.1.0 and
2.2.0 tag objects, while the #4201 merge timestamp and the 2.2.0 release
publish time come from the GitHub PR/Release API.
