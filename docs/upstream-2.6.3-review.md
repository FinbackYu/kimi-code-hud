# Kimi Code 2.6.3 upstream review

Reviewed: 2026-11-18. This document audits the HUD against released source and
synthetic fixtures. It covers 2.6.2 and 2.6.3, but does not establish live
2.6.3 TUI/remote-environment acceptance or constitute a HUD release.

## Release identity and range

| | Previous | Target |
|---|---|---|
| Release | `@moonshot-ai/kimi-code@2.6.1` | `@moonshot-ai/kimi-code@2.6.3` |
| Annotated tag object | `be40a45d36d3a856bfcb5b4366073a88f52f9033` | `a9df46689649824abfdfff1528d7708a23fd3cf3` |
| Peeled commit | `30e3ce442ae850a7461b80f2ce209cd73a301d02` | `b0de2fbd2de04d87689225aafd3912e5d193b62d` |

The target is a non-draft, non-prerelease published at 2026-11-17 15:15:21 UTC.
The previous peeled commit is an ancestor of the target. The counted range has
25 commits; the endpoint diff has 232 changed files (+5,047/−2,232), with 304
old/new path entries under `--no-renames`. Complete commit/path lists and diff
stats were materialized before absence claims. The workspace gate separately
covers its full 2.5.3 → 2.6.3 range: 127 commits, 1,258 changed files and 22
previous-only commits around merge-base `244819a526`.

## Contract and presentation decisions

| Upstream evidence | HUD entry point | Result |
|---|---|---|
| [`status-line-command.ts`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/apps/kimi-code/src/tui/utils/status-line-command.ts) remains blob `6482a4ac7c`; [`footer.ts`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/apps/kimi-code/src/tui/components/chrome/footer.ts) remains `79856f3326`; `git-status.ts` remains `f69e08bc7a` | payload, runtime, project and Git rendering | **covered**. Ten fields, first stdout line, 65,536-byte capture, 300ms host timeout, 1s rerun and cached-last-good behavior carry over. The HUD retains its 220ms internal deadline and silent fallback. |
| [`wire-manifest.d.ts`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/agent-core-v2/docs/wire-manifest.d.ts) is byte-identical to 2.6.1 (blob `45b493d7493e`, 67 types) | exact-type reducers; `test/wire-row-classes.test.mjs` | **covered**. `wire-events-2.6.1.jsonl` remains the current fixture by evidence, not by renaming. No new persisted record or field reaches the HUD in this range. |
| #4949 records restored task notifications without model requests and uses prompt-only completion; #4952 keeps non-user Tower prompts from cancelling wakeups | `src/metrics-turn.mjs`, throughput generation summary | **covered**. The explicit `normal / notify / continue` handling added at 2.6.1 continues to protect the user-generation anchor; no new timer inference is needed. |
| #4953 waits for subagent loop idle, detached-task quiescence and wire flush before termination | `src/metrics-tasks.mjs` | **covered**. The badge counts durable `running` state until `task.terminated`, so later, more accurate termination naturally keeps the badge visible longer. Lost/resumed legacy reconciliation is unchanged. |
| #4956 moves external Stop hooks after completed turns; #4951 adds invalid-user-config fallback | SessionStart hook, TOML and model config readers | **covered / host-owned**. The HUD registers no Stop hook. Hook and provider table shapes are unchanged; its independent malformed-config handling still fails closed or silently omits derived facts. |
| #4875 adds optional custom-registry `search_url` / `feedback_url`; #4876 changes `/feedback` attachments and fills failure request ids | `src/model-config.mjs`; turn reducers | **covered / unread**. Flat additive provider keys do not truncate known settings. HUD neither invokes feedback nor reads `turn.ended.requestId`; official-host provider attribution remains unchanged. |
| #5017 accepts choice-level OpenAI usage when top-level usage is absent | `step.end` and `usage.record` consumers | **covered / upstream value fix**. The four usage counters and record names are unchanged. The HUD consumes the host's normalized values and keeps Session Cost distinct from balance/quota. |
| Slash registry (`41d4c03898`), `tui/config.ts` (`242a6f9d68`), managed usage (`7bfcd86e2e`) and managed credential mapping (`8848966299`) are byte-identical | lifecycle, model/thinking, quota and provider credential boundary | **covered**. No permission, slash-command, fullscreen-default, quota-endpoint or token-storage rewrite is needed. SessionStart remains the only managed hook. |

## Display parity search

Searches covered both READMEs, CAPABILITIES, KNOWN_ISSUES, CHANGELOG, `src/`,
`hooks/`, tests, fixtures and current release docs.

| Old word / moved token | Hits and decision |
|---|---|
| `No attachment`, `Text feedback only`, `Logs only`, `attachmentLevel` | **0 hits** in owned display/config strings. `/bug` and `/feedback` occur only in historical capability archive text; no HUD command documentation needs renaming. |
| `search_url`, `feedback_url`, `stop_hook`, `shellCommand`, `follow_up_behavior`, `bedrock` | **0 owned-contract hits**. The first two are released additive registry fields; the others are either host-only or absent from this stable range. No provider adapter or hook is added by association. |
| `requestId` / `request_id` | Existing hits explicitly say the HUD does not consume `turn.ended.requestId`. More complete upstream fill is therefore not a schema migration. |
| `task.waitDelivered`, `turn.step.interrupted`, `turn.step.retrying`, `interruptionReminder` | Historical 2.6.1 fixture/docs remain accurate. There is no new 2.6.3 manifest delta to relabel. |
| Permission labels and slash names | Registry and display mapping are unchanged; stable ids were not used to infer display parity. |
| `2.6.1` as the current baseline | Advanced in both READMEs, CAPABILITIES, KNOWN_ISSUES, both showcase `CLI_VERSION` constants and the cold/remote payload fixtures. Historical reviews and release-specific tests remain unchanged. |

## Findings

**P0: none. P1: none.** No current-stable runtime fix is indicated by this range.

**P2 / existing boundaries:** the host environment badge remains
readable-but-unrendered; KI-2 keeps its identical-local-path collision; KI-8's
live current-version fullscreen matrix, KI-20 real-host acceptance, real remote
and managed-account/provider responses remain open. These are not closed by
source inspection or synthetic fixtures.

**Unable to judge:** real 2.6.3 classic/fullscreen frames, resize/reload/failure
frames, prompt-only restore, subagent quiescence with nested detached tasks,
and live choice-level OpenAI/provider responses.

## Watch carry-over

- [HUD #73](https://github.com/FinbackYu/kimi-code-hud/issues/73), upstream
  #4754: **still prep**. The 2.6.3 manifest contains only loop/compaction and
  session/turn; `prediction` is absent. Implementation belongs on
  `upstream/2.7.0-prep`, inert on 2.6.3.
- [HUD #75](https://github.com/FinbackYu/kimi-code-hud/issues/75), upstream
  #4820: **still prep**. `journal.ts` and `llm-adapter/model/generate.ts` are
  byte-identical to 2.6.1; the `settle.ts` delta only handles repeated output
  and missing finish events, not the future timing-boundary change. Historical
  timing fixtures and thresholds remain untouched on the stable branch.
- #4875/#4876 and #4951/#4953/#4956: **covered by this target** as described
  above. #4630 and stable 2.6.0 monitoring were covered by the 2.6.1 review.
  Other unconsumed monitor-only items are reconciled in the workspace report.

## Verification and limits

The stable branch changes documentation, current host-version fixtures and the
workspace contract gate only; it does not modify HUD runtime modules. Required
checks are `npm test`, `node --check test/contract.test.mjs`, `git diff --check`,
CLI `--help` and the empty-input fallback. Final counts and the cross-repository
gate result are recorded in the workspace review and completion summary.

No real user configuration, credential or session content is used. The official
checkout received only the exact annotated 2.6.3 tag and required objects under
the baseline-review exception. Its HEAD and working tree were not changed; no
upstream source, documentation, branch, config or test was patched.
