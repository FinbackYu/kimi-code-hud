# Upstream review: Kimi Code 0.43.1 → 2.0.0

Reviewed 2026-09-17. This document pins the release facts, the
contract-relevant upstream changes, the HUD consumer decisions, and the gates
that are still open, for the 2.0.0 baseline recorded in
[CAPABILITIES.md](../CAPABILITIES.md) and
[KNOWN_ISSUES.md](../KNOWN_ISSUES.md). It is the audit trail behind the
`0.43.1 → 2.0.0` entry in [the archive](capabilities-archive.md).

## Release identity

| Fact | Value |
|---|---|
| Previous (HUD baseline) | `@moonshot-ai/kimi-code@0.43.1`, peeled commit `75ac010bcb2050338444455de8328492d152c919`, published 2026-09-15T06:51:26Z |
| Target | `@moonshot-ai/kimi-code@2.0.0`, annotated tag object `834bdd50b10b53b90d2ce5d72f5864a8a2309492`, peeled commit `1b89e4b039f052d10f258464413b2047acca12ba`, tagger 2026-09-17 05:22:39 +0000, published 2026-09-17T05:22:40Z |
| Range | `75ac010b…1b89e4b0`: 29 commits, previous is an ancestor of the target; 370 files, +12928/−4380 |
| Method | `git show <commit>:<path>` / `git grep <pattern> <commit>` at the peeled commit only; no checkout, no upstream ref or object writes by this review; sanitized synthetic fixtures only, no credentials or user content |

Upstream jumped the marketing major straight from 0.43.1 (no 1.x release ever
existed) with the `/desktop` command and terminal Mermaid rendering as the
headlines; the release notes flag no breaking change, and this review found
none on any HUD-consumed surface. The target tag objects were fetched into
the local checkout once, under an explicit user authorization for exactly
that tag ref, over the SSH channel after the HTTPS transport failed (curl 52)
— same pattern as the 0.42.0 round. The checkout itself stays unmodified: no
local patch, clean worktree, and HEAD remains where the user parked it
(0.42.0).

## Contract-relevant upstream changes

### 1. `subagent.cancelled` wire record (#3778) — additive, locked as a neutral row class

The subagent scope LRU adds the observable Event2 mirror
`SubagentCancelled` (`subagent.cancelled`, payload `{ subagentId }`) in
`packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts`: evicted,
interrupted or timed-out subagents now report cancelled instead of
failed/aborted. Like `subagent.spawned` / `subagent.failed`, it lives outside
the generated wire manifest, so rows of this class may now appear in
`wire.jsonl`. Every HUD reducer gates on exact known types, so they fold as
no-ops; locked by the `subagent lifecycle records` scenario in
`test/wire-row-classes.test.mjs` (`test/fixtures/wire-events-subagent-cancelled.jsonl`;
renamed and extended when PR #3970 made these records durable in the v2.0.3
candidate). The "outside the generated wire manifest" statement is
range-scoped: true for 0.43.1 → 2.0.0, superseded by PR #3970 (59 → 64
manifest entries).

### 2. Surfaces verified unchanged across the range

- The Event2 persisted manifest `wire-manifest.d.ts` is unchanged across this
  range: no record type added, removed, or renamed. (Superseded for later
  ranges by PR #3970 in the v2.0.3 candidate.)
- `StatusLinePayload` keeps its 10 fields;
  `apps/kimi-code/src/tui/utils/status-line-command.ts` is byte-identical to
  0.43.1.
- The quota endpoint `packages/oauth/src/managed-usage.ts` is unchanged — the
  ratio model (#3787) that KI-19 fixed survives 2.0.0 as-is, endpoint marker
  included.
- `permission-mode.ts`, plugin `manifest.ts`, `agentPluginOps.ts`,
  `taskOps.ts`, `subagent-task.ts`, kap `protocol/task.ts` and
  `routes/tasks.ts` are untouched.
- `SubagentSpawnedPayload` keeps all 12 locked fields with identical types
  and optionality; `agentTool.ts` still supplies `parentToolCallId:
  toolCallId` exactly twice.

### 3. kap-server protocol additions (explicit interface, not consumed by the HUD)

`events-zod.ts` adds `subagentCancelledEventSchema` to the `agentEventSchema`
union. The locked schemas (subagent spawned/started/completed/failed,
agentTaskInfo, task started/terminated) are unchanged. HUD and
kimi-code-usage do not consume the kap WebSocket, so this is informational.

### 4. Additive host features and display changes

- `/desktop` (alias `/install-desktop`) and `kimi install-app`: open the
  Kimi Code desktop page; no HUD line-1 effect.
- Terminal Mermaid rendering (`[markdown] mermaid = "off"` in `tui.toml`)
  and diff code block highlighting: chat-area rendering, host-owned.
- Skill scopes and `custom-theme` marked tui-only; `media.budgetDropped`
  state key from #3784's media budget; `clientMetadata` retained on prompts
  and skill activations: additive config/state, no consumed surface.
- #3784 uploads images as file references for Kimi models and drops
  over-budget media with a warning instead of failing the request: request
  composition only.
- #3803 renames the WebBridge plugin display name to "Kimi Browser
  Extension" in host-owned panels; the HUD neither renders plugin display
  names nor references the old wording.

## Impact summary

| Surface | Status |
|---|---|
| Managed subscription quota | covered — endpoint unchanged; KI-19 fix and live-account acceptance carry over |
| Wire journal folding | covered — manifest unchanged; `subagent.cancelled` locked as neutral row class |
| Status-line payload and runner | covered, unchanged |
| Permission labels, plugin manifest, SessionStart | covered, unchanged |
| kap protocol surfaces | covered for consumers; new `subagent.cancelled` WS event is informational |
| P0 / P1 / P2 | none open from this range; P2: live acceptance (0.43.1 round) still outstanding |

## Verification

- Full suite on this branch: `npm test` green including the new
  `subagent.cancelled` scenarios (26 wire-row tests; totals in the branch
  commit message), `node --check` on touched modules, `git diff --check`.
- Upstream assertions re-run at the pinned commit on 2026-09-17, all
  passing: range count and ancestry, manifest record-set equality
  (comments excluded), byte-identical `status-line-command.ts`,
  `SubagentSpawnedPayload` field-by-field equality,
  `subagent.cancelled`'s absence from the manifest, the ratio field names
  and endpoint marker in `managed-usage.ts`, and the
  `parentToolCallId: toolCallId` count. These are pinned-commit facts for
  this range; the manifest ones no longer hold on later `main` — PR #3970
  in the v2.0.3 candidate registers the five `subagent.*` records.

## Remaining gates

- Live TUI acceptance (undo/steer replay, KI-18 boundary) and live
  managed-account quota acceptance (v2 → v3 migration, KI-19) carry over
  from the 0.43.1 round and remain outstanding; 2.0.0 adds host-side
  steering fixes but no new consumed surface.
- `kimi-code-usage` may later surface the cancelled state in its multi-agent
  dashboard; today it gates on exact known types, so nothing breaks.
- The workspace root gate moves to 2.0.0 in the same review cycle; upstream
  released no further stable version as of 2026-09-17.

## Reproduction

```sh
C=1b89e4b039f052d10f258464413b2047acca12ba; P=75ac010bcb2050338444455de8328492d152c919

# range facts (expect 29; ancestry exits 0)
git -C kimi-code rev-list --count $P..$C
git -C kimi-code merge-base --is-ancestor $P $C

# unchanged surfaces (expect empty output, exit 0)
git -C kimi-code diff --stat $P $C -- \
  packages/agent-core-v2/docs/wire-manifest.d.ts \
  apps/kimi-code/src/tui/utils/status-line-command.ts \
  packages/oauth/src/managed-usage.ts \
  apps/kimi-code/src/tui/utils/permission-mode.ts \
  packages/agent-core-v2/src/agent/task/taskOps.ts

# new record class (expect the SubagentCancelled declaration)
git -C kimi-code grep -n "type = 'subagent.cancelled'" $C -- packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts
```
