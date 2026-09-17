# Upstream review: Kimi Code 0.41.0 → 0.43.1

Reviewed 2026-09-17. This document pins the release facts, the
contract-relevant upstream changes, the HUD consumer decisions, and the gates
that are still open, for the 0.43.1 baseline recorded in
[CAPABILITIES.md](../CAPABILITIES.md) and
[KNOWN_ISSUES.md](../KNOWN_ISSUES.md). It is the audit trail behind the
`0.41.0 → 0.43.1` entry in [the archive](capabilities-archive.md).

## Release identity

| Fact | Value |
|---|---|
| Previous (HUD baseline) | `@moonshot-ai/kimi-code@0.41.0`, peeled commit `95478e8c7ba248fd2470d5bb151555ec7fedd19d`, published 2026-09-04 |
| Intermediate stable releases | `0.42.0` (`6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb`, 2026-09-09), `0.43.0` (2026-09-14) |
| Target | `@moonshot-ai/kimi-code@0.43.1`, annotated tag object `a3c66ba1b019c37e4069c5611266669d0438eb62`, peeled commit `75ac010bcb2050338444455de8328492d152c919`, published 2026-09-15T06:51:26Z |
| Range | `95478e8c…75ac010b`: 107 commits, of which 52 land after the `0.42.0` tag; the previous baseline commit is an ancestor of the target |
| Method | `git show <commit>:<path>` / `git grep <pattern> <commit>` at the peeled commit only; no checkout, no upstream ref or object writes by this review; sanitized synthetic fixtures only, no credentials or user content |

The target tag objects were fetched into the local checkout once, under an
explicit user authorization for exactly that tag ref, on 2026-09-17. The
checkout itself stays unmodified: no local patch, clean worktree, and HEAD
remains where the user parked it (0.42.0).

## Contract-relevant upstream changes

### 1. Managed quota payload switched to ratios (#3787, shipped in 0.43.1) — P0, fixed here

- Definition: `packages/oauth/src/managed-usage.ts` (verified at the target
  commit) serves `usages.limit_5h` / `limit_7d` / `limit_month_total` /
  `limit_month_code` entries with `used_ratio` and `reset_time`.
- Consumer impact: `src/quota.mjs` `parseQuotaPayload` returned `null` on the
  new shape, so the display kept stale v2 cache values and the quota segment
  eventually disappeared (GitHub #31; reproduced locally before the fix).
- Decision: preserve ratios without fabricating absolute counts; cache schema
  v3 keeps the non-reversible credential-context `contextKey`; v1/v2 caches
  are ignored until a successful detached refresh; legacy `usage`/`limits`
  parsing stays available only when `usages` is absent; an empty valid map
  clears obsolete windows. Monthly renders the total and, when both monthly
  entries exist, derives `kimi = total − code` with the upstream breakdown
  clamp; weekly-only and code-only responses stay visible in compact layout.
  Full boundary and acceptance criteria:
  [KI-19](../KNOWN_ISSUES.md#ki-19-managed-quota-payload-switched-to-ratios).

### 2. Wire-layer records outside the Event2 manifest (#3737, shipped in 0.43.0) — covered, no-op folding

- New persisted `wire.jsonl` record classes that are not part of the
  generated `wire-manifest.d.ts`: `agent.switched` branch edges (payload
  `{ branch, reason, base: { branch, line }, turns, legacyUndoLine }`),
  `context.undo` (persisted since 0.41.0; never consumed by the HUD),
  `context.undone` (memory-only before 0.43.0, persisted since),
  `agent.turn.started` / `agent.turn.ended` / `agent.message.appended`
  projections, and `human.*` mirrors.
- The physical schema is unchanged — append-only `{type, …payload, time}`
  lines — so `src/wire-reader.mjs` byte-offset reads are unaffected, and
  every HUD reducer gates on exact known types, so all of these fold as
  no-ops. Locked by `test/wire-row-classes.test.mjs` with sanitized fixtures
  (`test/fixtures/wire-events-undo-switch.jsonl`,
  `test/fixtures/wire-events-turn-records.jsonl`).
- Rebuild semantics differ from the HUD's raw fold: upstream refolds
  `wire.readRestorable()` (branch-aware) for `undoable` participants and
  reads the raw journal for everyone else
  (`packages/agent-core-v2/src/state/eventDispatcherService.ts`). Verified at
  the target commit: the `profileKey`, `swarmKey`, `towerKey`, and `taskKey`
  participants are registered non-undoable, and `goal` is explicitly
  `undoable: false` — so the HUD's raw-history view is aligned with
  upstream's own non-undoable participants rather than being a deviation.
  This corrects the initial `upstream/0.43-prep` note, which overestimated a
  badge deviation; see
  [KI-18](../KNOWN_ISSUES.md#ki-18-undo-branch-records-stay-in-the-wire-journal-hud-folds-the-raw-stream)
  for the per-projection boundary and the conditions for reconsidering
  active-chain support.

### 3. Event2 persisted manifest: 59 record types (was 60)

`packages/agent-core-v2/docs/wire-manifest.d.ts` drops `prompt.accepted`; no
other record type is added, removed, or renamed. `turn.prompt` remains and
gains an optional `turnId` (`turnId?: number`; the field did not exist in
0.41.0). Every manifest entry the HUD consumes keeps its shape, and `human.*`
mirrors are not counted a second time.

### 4. Host-owned footer changes

- The status-line runner is unchanged:
  `apps/kimi-code/src/tui/utils/status-line-command.ts` is byte-identical
  across the range and `StatusLinePayload` keeps its 10 fields.
- A new fixed `ctrl+o expand` / `ctrl+o collapse` tool-output shortcut hint
  moves to host-owned footer line 2 when a custom command owns line 1;
  recorded as `host-owned, preserved` in the CAPABILITIES footer table.

### 5. Verified unchanged across the range

Byte-identical at previous and target (assertion commands below):
`status-line-command.ts`, `permission-mode.ts` (the "Always Ask" / "Ask When
Needed" / "Never Ask" display names),
`packages/agent-core-v2/src/app/plugin/manifest.ts`, and
`packages/agent-core-v2/src/agent/plugin/agentPluginOps.ts` (plugin manifest
and SessionStart hook contract). 0.43.0's goal time-budget removal and MCP
deferred-tool loading (`dynamically_loaded_tools`, per-server `deferred`) do
not touch any HUD-consumed surface.

## Impact summary

| Surface | Status |
|---|---|
| Managed subscription quota | fixed on this branch (KI-19, #31); live-account acceptance pending |
| Wire journal folding | covered, no-op folding; KI-18 information boundary documented |
| Status-line payload and runner | covered, unchanged |
| Permission labels, plugin manifest, SessionStart | covered, unchanged |
| Footer line-2 ownership | covered / host-owned (`ctrl+o` hint) |
| P0 / P1 / P2 | P0 (#31) fixed; no open P1; P2: live acceptance and root-gate move outstanding |

## Verification

- Full suite on this branch: 605 tests, 604 pass, 0 fail, 1 pre-existing skip
  (2026-09-17, after the last code and documentation edit).
- The #31 fix followed red → green: the new ratio parser, cache-migration,
  and render tests fail against the old implementation and pass after the
  fix; `--doctor` migration reporting is covered by `test/doctor.test.mjs`;
  the contract and release-metadata suites stay green.
- Upstream assertions re-run at the pinned commit on 2026-09-17, all passing:
  commit counts and ancestry, manifest record counts (comments excluded),
  `prompt.accepted` removal, the optional `turn.prompt.turnId`, the
  byte-identical file set, the `readRestorable()` / `readJournal()` fold in
  `eventDispatcherService`, the absence of `.undoable(` registrations in the
  profile / swarm / tower / task Ops, `undoable: false` for `goal`, and the
  ratio field names in `managed-usage.ts`.

## Remaining gates

- Live TUI acceptance on a real session: undo/steer replay through the HUD
  (the KI-18 boundary), per the "Compatibility candidate" line in
  CAPABILITIES.md and KNOWN_ISSUES.md.
- Live managed-account quota acceptance: v2 → v3 cache migration and 5h /
  weekly / Monthly rendering with real credentials (KI-19).
- The workspace root gate `scripts/check-contracts.mjs` is still pinned to
  0.42.0; moving it to 0.43.1 is a separate workspace-level baseline action,
  performed after this branch merges.
- Upstream published 2.0.0 on 2026-09-17. It is deliberately outside this
  review and is the next baseline cycle; its cancelled/failed reporting and
  image-upload changes matter chiefly to `kimi-code-usage`.

## Reproduction

```sh
C=75ac010bcb2050338444455de8328492d152c919; P=95478e8c7ba248fd2470d5bb151555ec7fedd19d

# range facts (expect 107 and 52; ancestry exits 0)
git -C kimi-code rev-list --count $P..$C
git -C kimi-code rev-list --count 6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb..$C
git -C kimi-code merge-base --is-ancestor $P $C

# persisted manifest record count, comments excluded (expect 59; 0.41.0: 60)
git -C kimi-code show $C:packages/agent-core-v2/docs/wire-manifest.d.ts \
  | grep -v '^[[:space:]]*//' | grep -cE '^[[:space:]]*"[A-Za-z0-9_.]+":'

# unchanged surfaces (expect empty output, exit 0)
git -C kimi-code diff --stat $P $C -- \
  apps/kimi-code/src/tui/utils/status-line-command.ts \
  apps/kimi-code/src/tui/utils/permission-mode.ts \
  packages/agent-core-v2/src/app/plugin/manifest.ts \
  packages/agent-core-v2/src/agent/plugin/agentPluginOps.ts

# quota ratio response shape (expect hits for all names)
git -C kimi-code grep -n -e limit_5h -e limit_7d -e limit_month_total \
  -e limit_month_code -e used_ratio -e reset_time \
  $C -- packages/oauth/src/managed-usage.ts
```
