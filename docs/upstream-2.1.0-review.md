# Kimi Code 2.1.0 upstream review

Reviewed: 2026-09-23. This document audits the HUD code against the released source and synthetic fixtures. It does not establish live 2.1.0 TUI acceptance or a HUD release.

## Release identity and range

| | Previous | Target |
|---|---|---|
| Release | `@moonshot-ai/kimi-code@2.0.2` | `@moonshot-ai/kimi-code@2.1.0` |
| Annotated tag object | `c98339a1867e0843d192b8f7454d7ae3dcd5d8d8` | `93a83aafacf91cc595a7b66f0ecb637f23859f77` |
| Peeled commit | `9d07f634be94ebeb1deba2f55d247807cf729315` | `52437299ff78de3d0aff7f38f054e5eb20c512e5` |

The target release was published at 2026-09-23 12:31:44 UTC. The previous commit is an ancestor of the target. The exact range has 24 commits and 319 changed paths (+9,167/−2,772 lines). All source links below pin the target commit; the official checkout HEAD was not moved.

## Contract and presentation decisions

| Upstream evidence | HUD entry point | Result |
|---|---|---|
| [`status_line.command` payload](https://github.com/MoonshotAI/kimi-code/blob/52437299ff78de3d0aff7f38f054e5eb20c512e5/apps/kimi-code/src/tui/utils/status-line-command.ts): the ten fields, first stdout line, 300 ms timeout and 1 s refresh contract are unchanged across the exact path list | `src/payload.mjs`, `src/render-runtime.mjs`, `src/hooks.mjs` | **covered** by existing parser, render and lifecycle tests; real 2.1.0 TUI behavior remains unverified. |
| [`footer.ts`](https://github.com/MoonshotAI/kimi-code/blob/52437299ff78de3d0aff7f38f054e5eb20c512e5/apps/kimi-code/src/tui/components/chrome/footer.ts) only reformats two `createGitStatusCache` calls; [`git-status.ts`](https://github.com/MoonshotAI/kimi-code/blob/52437299ff78de3d0aff7f38f054e5eb20c512e5/apps/kimi-code/src/utils/git/git-status.ts) delays probing until `getStatus()` and injects Git config/diff controls | `src/git.mjs` performs its own bounded dirty probe | **security fix included; live acceptance pending**: the prep status call allowed a repo-configured clean filter before trust (KI-20). The HUD now uses index metadata and a cached diff with `--no-ext-diff`/`--no-textconv`; isolated clean/process-filter tests pass. Real 2.1.0 host acceptance remains unverified. |
| [`wire-manifest.d.ts`](https://github.com/MoonshotAI/kimi-code/blob/52437299ff78de3d0aff7f38f054e5eb20c512e5/packages/agent-core-v2/docs/wire-manifest.d.ts) grows from 59 to 64 durable Event2 types: `subagent.spawned`, `started`, `completed`, `failed`, `cancelled` | `src/metrics-*.mjs`, `src/session-usage.mjs` | **covered as no-op / readable but unrendered**: issue #45's five-class fixture and `test/wire-row-classes.test.mjs` match the release. `subagent.completed.usage` and `contextTokens` must not enter the session cost ledger; only `usage.record` does. A durable lifecycle view is a future capability, not current HUD behavior. |
| [`state-manifest.d.ts`](https://github.com/MoonshotAI/kimi-code/blob/52437299ff78de3d0aff7f38f054e5eb20c512e5/packages/agent-core-v2/docs/state-manifest.d.ts) adds assistant-message usage, LLM timing and tool duration; transcript folding also gains subagent restoration | HUD reads wire, not the KAP transcript projection | **host-owned / no accounting migration**. These fields do not authorize summing `context.append_message` usage with `usage.record`. |
| `tui_mode` setting and fullscreen interaction changes in 2.1.0 | HUD owns a custom line; host owns context/hints line | **host-owned / unverified live**. Earlier Windows 2.0.0 fullscreen evidence does not establish 2.1.0 behavior (KI-8). The HUD README still describes installation into `[status_line]` accurately. |
| The managed `/usages` endpoint, `usage.record` schema, built-in slash registry and external hook source paths are absent from the complete 319-path range list | quota, cost ledger, commands and SessionStart installation | **no direct source delta at those seams**. The 2.0.1 `api_key_env` fix from HUD PR #46 is included with synthetic coverage (KI-21); a real 2.1.0 DeepSeek smoke is pending. |

The display parity search covered `README.md`, `README.en.md`, `CAPABILITIES.md`, `KNOWN_ISSUES.md`, `CHANGELOG.md`, `src/` and `test/` for `tui_mode`, fullscreen, permission labels, `Thinking`, `Jump to bottom`, and removed banner keys. The new fullscreen controls and Thinking spinner are host UI; the HUD's model/permission labels and status-line payload do not use those tokens. The banner configuration rewrite is outside HUD's rendered tip source. Stable ids and display labels were evaluated separately.

## Watch carry-over

- [HUD #44](https://github.com/FinbackYu/kimi-code-hud/issues/44), upstream #3964: **transferred to KI-20 acceptance**. Released in 2.1.0; the prep argv covered fsmonitor/hooks, and the new metadata-based probe closes the clean/process-filter execution path in isolated tests. The issue stays open for real 2.1.0 host acceptance.
- [HUD #45](https://github.com/FinbackYu/kimi-code-hud/issues/45), upstream #3970: **covered in the reviewed HUD code** by the five-class fixture, manifest re-pin and anti-double-counting regression. Synthetic tests pass; real 2.1.0 host acceptance and issue closure remain separate decisions.
- No new Repo-Overwatch report files were present since the prior 2.0.2 baseline review.

## Verification and limits

The workspace root gate is pinned to the annotated 2.1.0 tag and passes for selected consumer entry points. For the reviewed HUD code, `npm test` reports 621 pass, 0 fail and one existing Windows-only skip with the `api_key_env` fix included; `node --check src/git.mjs`, `node --check src/git-safe-probe.mjs`, and `git diff --check` pass. The first sandboxed run could not bind local test HTTP servers; the permitted rerun passed. Source and fixture checks do not prove live rendering, real quota/DeepSeek access, Windows 2.1.0 behavior or a HUD release. The combined branch includes the merged `api_key_env` fix on `main` and its synthetic regressions. The installed Kimi CLI reports 2.0.2. An isolated official npm tarball with only its two published runtime dependencies reports 2.1.0 via `--version`; this checks package identity but does not trigger a TUI or subagent. A real 2.1.0 host trigger and DeepSeek account smoke are still pending; release-day acceptance remains open.
