# Kimi Code 2.7.0 upstream review

Reviewed: 2026-11-20. This document audits the HUD against released source,
synthetic fixtures and a real 2.7.0 synthetic TUI session. It does not establish
fullscreen, remote-environment or managed-provider acceptance.

## Release identity and range

| | Previous | Target |
|---|---|---|
| Release | `@moonshot-ai/kimi-code@2.6.3` | `@moonshot-ai/kimi-code@2.7.0` |
| Annotated tag object | `a9df46689649824abfdfff1528d7708a23fd3cf3` | `dc94b1adec6d5aa10b0fc5cd7872d450eb16eeff` |
| Peeled commit | `b0de2fbd2de04d87689225aafd3912e5d193b62d` | `a5e355e2718a2ebf70d8229fa5a05fe35d5f98a1` |

The target is a non-draft, non-prerelease published at 2026-11-19 11:16:28 UTC.
The release line is non-linear: merge-base
`aa839f05fbc639e6d2fbb02cc8b3b5884011b4b5`, 72 target-side commits and 44
previous-only commits. The endpoint diff has 4,582 changed files
(+433,863/−68,160); `--no-renames` materializes 4,640 old/new paths. Complete
commit and path lists were materialized before absence claims. Rename detection
reported its documented limit, so no claim depends on rename inference.

Official compare also proves that #4754, #4820 and #4840 are ancestors of the
target. The release notes name Bedrock, prompt prediction, follow-up behavior,
foreground agents in `/tasks`, KAP automation and multi-client/session changes.

## Contract and presentation decisions

| Upstream evidence | HUD entry point | Result |
|---|---|---|
| `status-line-command.ts` changes comments only; payload construction still exposes 10 fields and a 300ms runner | payload parser, render runtime | **covered**. First-line output, capture limit, cached-last-good and failure behavior are unchanged; the HUD keeps its 220ms internal deadline and silent fallback. |
| `footer.ts` and `git-status.ts` change comments only | footer slots, Git branch/dirty fallback | **covered**. No slot ownership or Git trust change follows. KI-2's missing environment marker and identical-local-path boundary remain. |
| `tui/config.ts` adds `follow_up_behavior: queue / steer`; compact transcript presentation changes `unfolded: card` to `row` | TOML editing, install/uninstall and SessionStart repair | **covered**. The new key and existing transcript/commented-mode settings are preserved verbatim. Transcript rendering is host-owned. |
| The persisted manifest stays at 67 types, adding only `llm.request.kind = prediction` and `usageScope = prediction` to existing unions | exact-type reducers, session metadata, throughput and usage ledger | **covered**. No new record type or neutral-row migration is needed. Declared prediction requests cannot advance activity or replace primary model/thinking; real prediction usage remains in Session Cost. |
| `UsageAgentModel` maps `operation + prompt_prediction` to `usageScope = prediction` | `usage.record` consumer | **covered**. Two real prediction records were captured. The all-agent estimate includes their model tokens and never treats them as balance, quota or a server bill. |
| `packages/core/src/llm/generate.ts` starts its attempt clock at `generate` entry and emits timing immediately after `decoder.end()`; `journal.ts` preserves the `step.end` field names | TTFT/TPS reducers | **covered**. The HUD reads the host fields without subtracting request-build or scaling duration. Three real normal samples keep the 250ms / 1000 t/s thresholds justified; no threshold or historical-fixture rewrite is needed. |
| `profile.bind` preserves explicit thinking effort across later binding refreshes | model/thinking metadata | **covered**. The existing repeated-`off` plus content-bearing tool-selection counterexample remains valid; no tool content enters the HUD state. |
| `/tasks` now describes background tasks **and running foreground agents** | durable `task.started` / `task.terminated` badges | **covered / host-owned**. The browser's new foreground view does not change the durable background badge schema. The HUD does not claim to reproduce the browser. |
| Bedrock adds AWS bearer-token and ambient-credential authentication | provider config reader and usage adapters | **covered by hiding**. No usage endpoint satisfying the inference-credential/host rules is established. KI-24 lists Bedrock explicitly instead of guessing a balance or quota. |
| KAP v1 session/API expansion and v2 removals, SSH projects and multi-client resume | status line and local bounded wire readers | **no consumer dependency**. The HUD does not call those APIs. Session directory selection and incremental reads are unchanged by the released source used here. |
| `state-manifest.d.ts` updates source-location comments after the core extraction | state and wire parsers | **no runtime delta**. Token usage and timing field shapes are preserved. |

### Released-host prediction evidence

The isolated npm package was `@moonshot-ai/kimi-code@2.7.0`; the global 2.6.3
installation was not upgraded. With `KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION=1`
and only synthetic prompts:

- the second and third completed turns produced ghost suggestions; Tab accepted
  one and an explicit Enter submitted it;
- two `usageScope = prediction` records persisted, with input/output/cache
  counters distinct from the three ordinary turn records;
- after the activity window expired, the HUD reported `activeAgents = 0` and
  `mainActive = false`, retaining primary model `kimi-code/k3.1-pro` and effort
  `high`;
- the complete all-agent ledger included both prediction records: 32,638
  inputOther, 109,312 cache-read and 1,456 output tokens across the session.

The captured normal and prediction wires contained no `llm.request` rows. A 2.6.3
non-interactive control also omitted them, and the 2.7.0 source declares the
event without a direct-operation emission point. Therefore the declared
`kind = prediction` reducer counterexample stays synthetic and is not presented
as proof of a real emission. The actual `usageScope = prediction` path is covered
by the real records above. A first-turn suggestion was not observed; acceptance
here covers the later completed turns, not a guarantee for every first turn.

### Real timing samples and thresholds

The three ordinary `step.end` rows measured:

| Turn | TTFT (ms) | Stream (ms) | Output tokens |
|---|---:|---:|---:|
| 1 | 3238 | 8313 | 416 |
| 2 | 1905 | 6612 | 388 |
| 3 | 1986 | 6786 | 394 |

These values are preserved in `wire-events-2.7.0.jsonl` with normalized
 timestamps and model identifiers. They exercise the new timing fields without
copying prompts, responses, paths, credentials or session identifiers. All three
streams exceed 250ms and their rates are below 1000 t/s. Existing <250ms and
>1000 t/s counterexamples remain in force, so the thresholds stay unchanged.

## Display parity search

Searches covered both READMEs, CAPABILITIES, KNOWN_ISSUES, CHANGELOG, `src/`,
`hooks/`, tests, fixtures and current release docs.

| Old word / moved token | Hits and decision |
|---|---|
| `Browse background tasks` | **0 owned hits**. The official `/tasks` description adds foreground agents; the HUD's narrower durable background badges remain accurate. |
| `follow_up_behavior` | Added to management and SessionStart fixtures; `steer` and all pre-existing status-line/transcript keys survive install, uninstall and hook repair. |
| `bedrock`, `AWS_REGION` | No provider adapter is inferred from the new host support. Bedrock is now an explicit KI-24 no-supported-usage-source entry. |
| `include_archive`, `archived_only`, `exclude_empty`, `/api/v2` | **0 owned hits**. These are KAP/session API changes, not HUD status-line or local wire contracts. |
| `llmFirstTokenLatencyMs`, `llmStreamDurationMs`, `llmRequestBuildMs` | Field names stay unchanged. The first two receive the new source-backed timing semantics; the third is not subtracted or fabricated in the new fixture. |
| `250ms`, `1000 t/s` | Kept in both READMEs and boundary tests after the real-sample review. |
| `2.6.3` as the current baseline | Advanced in both READMEs, CAPABILITIES, KNOWN_ISSUES, both showcase `CLI_VERSION` constants and the cold/remote payload fixtures. Historical reviews and release-specific tests remain unchanged. |

## Findings

**P0: none. P1: none for this HUD release range.** The prediction reducer fix is
required for the declared side-request kind; the actual usage and timing paths
are covered by real release evidence.

**P2 / existing boundaries:** KI-2 retains its identical-local-path collision;
KI-8's current-version fullscreen matrix, KI-20 real-host acceptance, real remote
and managed-account/provider responses remain open. Bedrock has no supported
usage adapter by design.

**Pre-existing consumer follow-up, not a 2.7.0 regression:** kimi-code-usage
counts `totals.requests` from `llm.request`; both the 2.6.3 and 2.7.0 controls
omit that event, so its request-count caliber needs a separate follow-up. It is
not hidden inside this HUD prep branch or mislabeled as a new upstream change.

**Unable to judge:** universal first-turn prediction triggering, real 2.7.0
classic/fullscreen matrices, resize/reload/failure frames, remote environments,
live Bedrock/AWS authentication, and managed-account/DeepSeek responses.

## Watch carry-over

- [HUD #73](https://github.com/FinbackYu/kimi-code-hud/issues/73): **accepted**
  as described above. Declared request-kind coverage is synthetic; actual
  prediction usage, idle state, model metadata and cost inclusion are verified.
- [HUD #75](https://github.com/FinbackYu/kimi-code-hud/issues/75): **accepted**.
  #4820 is in the target, the source boundaries match the prep decision, real
  samples are now fixed in a new fixture, and thresholds remain unchanged.
- #4840: **covered** by the explicit-binding reducer counterexample. No runtime
  change is needed.
- No newer Repo-Overwatch report exists after the previous baseline. The open
  upstream-watch list contains only #73/#75 before their completion comments.

## Verification and limits

The rebased branch changes the two prediction reducers, fixtures, contract and
lifecycle tests, current documentation and the workspace contract gate. Required
checks are the focused wire/usage/management suites, `npm test`, `node --check`
on edited `.mjs` files, `git diff --check`, CLI `--help` and empty-input smoke.
Final counts are recorded in the PR and issue acceptance comments.

The official checkout received only the exact annotated 2.7.0 tag and required
objects under the baseline-review exception. The first fetch disconnected; the
user-authorized retry succeeded. Its HEAD and working tree were not changed; no
upstream source, documentation, branch, config or test was patched. No real user
configuration, credential, existing session content or prompt was read into the
public evidence.
