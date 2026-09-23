# Kimi Code 2.0.2 upstream review

Reviewed: 2026-09-23

HUD behavior baseline: `v0.8.4` (`711d54e`)

Upstream range: `@moonshot-ai/kimi-code@2.0.0` → `@moonshot-ai/kimi-code@2.0.2`

## Release identity

| | Previous | Target |
|---|---|---|
| Tag | `@moonshot-ai/kimi-code@2.0.0` | `@moonshot-ai/kimi-code@2.0.2` |
| Annotated tag object | `834bdd50b10b53b90d2ce5d72f5864a8a2309492` | `c98339a1867e0843d192b8f7454d7ae3dcd5d8d8` |
| Peeled commit | `1b89e4b039f052d10f258464413b2047acca12ba` | `9d07f634be94ebeb1deba2f55d247807cf729315` |
| Range | — | 33 commits; previous is an ancestor |

The official 2.0.2 release was published on 2026-09-19. The range changes 436
paths, but its HUD-facing status-line surfaces are stable. The official release
notes are in the [Kimi Code releases](https://github.com/MoonshotAI/kimi-code/releases)
and [upstream changelog](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/release-notes/changelog.md).

## Contract review

- `StatusLinePayload` remains 10 fields. The status-line runner, footer and Git
  status model are unchanged across the range. The HUD's 2.0.2 source/fixture
  baseline is therefore an additive baseline advance.
- The Event2 `WirePayloadMap` has 59 record types at both endpoints, with no
  additions or removals. Optional additions are `prompt.steered.messageId`,
  `turn.ended.traceId`, and `turn.steer.messageId`, `promptIds` and `turnId`.
  State snapshots add optional `reasoningKey` and optional `origin.inTurn`.
  KAP adds optional `turn.ended.traceId`. The HUD does not currently consume
  these fields, so no display change follows from them.
- 2.0.1 adds provider `api_key_env`; the HUD's current `main` and
  `upstream/2.0.3-prep` branches still resolve only literal `api_key` for
  provider balance. See P2 finding below.
- 2.0.1 renames the CLI installer command to `install-desktop` while retaining
  hidden `install-app` as an alias. The HUD does not own these CLI commands;
  searches of its README, capability/issue documents, changelog, source and
  tests found no stale `install-app` or `/install-app` user-facing string.

## Findings

### P1 — `git status` can execute a repository-configured clean filter

The `upstream/2.0.3-prep` branch's commit `2014a69` adds
`-c core.fsmonitor=false -c core.hooksPath=/dev/null` and sets
`GIT_OPTIONAL_LOCKS=0`. Those controls suppress fsmonitor and hooks, but leave
`filter.<driver>.clean` / `filter.<driver>.process` available when a tracked
`.gitattributes` selects that filter.

I reproduced the behavior in an isolated temporary Git repository with a
modified tracked `.txt` file, `.gitattributes` selecting `filter=probe`, and a
repo-local clean command that wrote only a temporary marker. Both the exact
HUD `git status --porcelain=v1 --branch` invocation and the HUD's
`readGitStatus` path executed the command; the HUD returned the dirty status
within its 150ms child timeout. No real user repository or settings were used.

This matches the risk raised in an automated review comment on upstream
[PR #3964](https://github.com/MoonshotAI/kimi-code/pull/3964), merged on
2026-09-22 after the 2.0.2 release. The current prep mitigation is incomplete;
tracked as [KI-20](../KNOWN_ISSUES.md#ki-20-git-status-probe-still-runs-repository-configured-clean-filters).
No probe behavior change was made in this review.

### P2 — provider balance does not resolve `api_key_env`

The 2.0.1 release notes include upstream #3762's `api_key_env` support. The
reviewed HUD `main` and prep branches parse `api_key` only, so an env-only
provider credential fails closed and the DeepSeek balance stays hidden. The
fix is present at `a22b6f3` on `fix/35-provider-api-key-env`, outside the prep
branch. The task report identifies PR #46 as awaiting merge approval. A real
2.0.2 DeepSeek smoke remains unverified; tracked as [KI-21](../KNOWN_ISSUES.md#ki-21-provider-balance-does-not-resolve-api_key_env).

### 2.0.3 candidate — subagent durable records

Upstream [PR #3970](https://github.com/MoonshotAI/kimi-code/pull/3970) remains
unmerged as of this review. It promotes five `subagent.*` records to durable
wire records and includes usage/context fields on completion. It is not part
of the 2.0.2 stable range. The HUD prep branch has fixtures for all five
record classes and keeps `subagent.completed.usage` / `contextTokens` out of
its session usage ledger; `kimi-code-usage` likewise recognizes `usage.record`
for Kimi token facts. This is candidate prep, not 2.0.2 coverage.

## Verification and limits

- Root contract gate passed for 2.0.2: `StatusLinePayload` fixture keys match;
  the 33-commit range, tag objects and peeled commits match; all current
  two-consumer contract assertions pass.
- The clean-filter behavior was reproduced only in an isolated temporary
  repository on this host. Windows-specific execution was not tested.
- Live TUI acceptance and a real managed-account / DeepSeek 2.0.2 smoke were
  not run in this review. Consumer test totals in the preceding task report
  were not rerun here; this review's HUD edits are documentation and comments.
- The official upstream checkout's source tree remains clean. The exact 2.0.2
  tag ref/object was fetched under the workspace baseline policy; `HEAD`
  remained at `6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb`.
