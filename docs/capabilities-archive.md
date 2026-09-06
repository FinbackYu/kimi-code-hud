# HUD capabilities archive — per-release baseline history

- Archived: 2026-09-06
- Coverage: per-release Kimi Code baseline audits from 0.32.0 → 0.33.0
  through 0.40.1 → 0.41.0

The current contract and boundaries live in
[CAPABILITIES.md](../CAPABILITIES.md); this file is frozen reference
material, and newer release audits are appended here rather than growing
CAPABILITIES.md.

Blocks are kept verbatim as written at audit time. Where a block says
"below" or "this table", it refers to a section that has since moved to
CAPABILITIES.md. Verification annotations are preserved as written:
"covered" means covered by tests at the time of that audit, live-session
notes name the host version they ran against, and anything not dynamically
tested is labeled as such.

---

Baseline delta (0.32.0 → 0.33.0):

- The `status_line.command` payload/runner contract, footer slot order, and the
  Git status model are unchanged.
- The persisted wire manifest only adds optional fields
  (`environmentDisclosure`, `renderGeneration` on `config.update` /
  `profile.bind`); HUD reducers read known fields and ignore extras.
- The built-in registry adds `/bug` as a `/feedback` alias and rewords
  `/fork`; neither affects the HUD line.
- The v2 engine is the default and still fires `SessionStart` external hooks
  and persists the main-agent `wire.jsonl` journal.

Baseline delta (0.33.0 → 0.34.0):

- The `status_line.command` payload/runner contract, footer slot order, and the
  Git status model are unchanged (`footer.ts` and `status-line-command.ts` are
  untouched in the release range).
- Wire additions are all optional: `subagent.spawned` and agent task info carry
  optional `model` / `thinkingEffort`, `mcp.server.status` gains a `removed`
  state, and `image_source` gains an optional `id`. The records HUD reduces
  (`turn.*`, `step.end`, `llm.request`, `config.update`, `goal.*`,
  `swarm_mode.*`, `full_compaction.*`, `task.started` / `task.terminated`) are
  unchanged, so HUD parsers stay wire-compatible.
- Session metadata gains an optional `lastTurnReason`, and REST session status
  makes `max_context_tokens` optional; neither is consumed by the HUD.
- The v2 engine stays the default; `SessionStart` external hooks and
  main-agent `wire.jsonl` journal persistence are unchanged.

Baseline delta (0.34.0 → 0.35.0):

- The status-line payload, first-stdout-line contract, 300ms timeout, footer
  line ownership, and HUD-reduced wire records are unchanged.
- The host hardens its pre-trust Git and GitHub CLI probes by resolving bare
  commands through PATH to absolute paths and refusing workspace-local hits.
  HUD now applies the same boundary to its synchronous `git status` probe.

Baseline delta (0.35.0 → 0.36.0):

- The status-line payload and runner contract remain the same 10 fields, first
  stdout line, and 300ms ceiling; footer line 2 remains host-owned.
- The persisted manifest adds `plugin.session_start { content: string | null }`.
  HUD treats it as an unknown row, does not retain `content`, and locks that
  boundary with an adversarial-content regression test.
- Experimental subagent model pools can put nonzero usage from different
  providers in one all-agent ledger. A provider Session Cost now fails closed
  for mixed or unresolved ledgers instead of silently pricing only the active
  provider's subset.
- The experimental fullscreen TUI does not alter the static status-line
  contract. Interactive fullscreen rendering remains a manual verification
  gap tracked as KI-8; it is not claimed as dynamically tested here.

Baseline delta (0.36.0 → 0.36.1):

- The status-line payload, first-line stdout contract, 300ms host ceiling,
  footer ownership, persisted wire manifest, provider/usage/goal structures,
  and plugin manifest remain unchanged.
- Nested subagent task metadata is additive: task information gains optional
  `agentId`, `subagentType`, and `parentToolCallId`, while KAP `/tasks` exposes
  `agent_id`, `subagent_type`, and `parent_tool_call_id`. HUD task badges still
  consume only `taskId`, `kind`, and `status`, so the counts remain compatible.
- New `event.plugin.changed` / `event.capability.changed` event variants and
  independent approval/question IDs are ignored by the HUD's known-event
  reducers. Background task previews are sanitized upstream before display.
- Experimental automatic session titles are default-off and outside the HUD
  contract; the HUD does not consume or persist session titles.

Baseline delta (0.36.1 → 0.37.2):

- The status-line payload, first-line stdout contract, 300ms host ceiling,
  and footer line ownership are unchanged. Footer line 2 gains a longer-lived
  `warningHint` shown only when no transient hint is active; line 2 remains
  host-owned.
- The persisted wire manifest drops five transient record types (`cron.*`,
  `permission.rules.add`, `skill.activate`) and adds durable `prompt.accepted`,
  `runtime.set_binding`, and `tower_mode.enter` / `tower_mode.exit`. HUD
  reducers gate on known types; this 0.39.0 prep branch now folds the Tower
  pair and renders `[tower]`, while every other addition remains ignored.
- Durable wire records now always carry a `time` stamp; HUD reducers already
  read `time` defensively, so the change is additive.
- agent-core-v2 rewired its journal internals from op-based Models to
  Event2/defineState. The on-disk wire format, session layout, quota endpoint,
  plugin manifest, and hook payloads are unchanged.

Baseline delta (0.37.2 → 0.38.0):

- The `status_line.command` payload/runner contract, the first-stdout-line
  contract, the 300ms host ceiling, footer line ownership, and the Git status
  model are unchanged; `footer.ts`, `status-line-command.ts`, and
  `git-status.ts` are byte-identical across the release range.
- The persisted wire manifest grows from 48 to 55 record types: `cron.add`,
  `cron.cursor`, `cron.delete`, `staleGuard.recorded`, `staleGuard.cleared`,
  `task.waitDelivered`, and `token_counting.turn_recorded` are new, and every
  durable record now carries a required `agentId` (the host backfills it when
  replaying older journals; `WIRE_PROTOCOL_VERSION` stays 1.5). HUD reducers
  read known fields and ignore the additions, so wire parsing stays
  compatible.
- Failed or interrupted steps now also persist a `step.end` record, but
  without `usage`, `llmFirstTokenLatencyMs`, or `llmStreamDurationMs`. The
  HUD gates — TPS requires nonzero `output` and a valid stream duration,
  cache-hit requires all four usage fields, turn requires `finishReason ===
  'end_turn'` — filter these rows, so no statistic is polluted; only
  `lastStepEndAt` updates early for a failed step, which makes the last-step
  presentation more accurate and is recorded as a variant.
- Quota: the managed usages endpoint for mainland-cn is unchanged
  (`https://api.kimi.com/coding/v1/usages`), and 0.38.0 adds a global region
  (`https://api.kimi.ai/coding/v1/usages`, with credentials persisted in a
  scoped slot `credentials/kimi-code-env-<16 hex>.json` via
  `packages/oauth/src/region.ts` / `managed-kimi-code.ts`). Shipped in HUD
  v0.7.3, the detached `--refresh-quota` path now
  resolves the region (env `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`, then
  the `[providers."managed:kimi-code"]` `oauth` sub-table and `base_url` in
  config.toml, then the mainland default), derives the credential file from
  the persisted `oauth.key`, and sends the token only to the two official
  hosts, failing closed on any custom or mismatched configuration. The
  render hot path is unchanged, and `quota.json` carries no account,
  credential-slot, or endpoint tag. After an account or region switch, the
  previous cache may continue to render; the 60s TTL marks it stale and
  schedules refresh but does not evict it. A successful refresh replaces the
  value, while repeated 401/403 responses with a remaining `refresh_token`
  may preserve the stale value beyond one TTL.
- The `SessionStart` hook, plugin manifest, `KIMI_CODE_HOME` resolution, and
  credentials directory layout are unchanged; upstream only moved internal
  modules between packages.

Baseline delta (0.38.0 → 0.39.0):

- The `status_line.command` payload/runner contract is unchanged: the 300ms
  host ceiling, 1s rerun interval, and 64KB capture budget are the same, and
  the payload still carries no `towerMode` field. The wire event set stays at
  55 record types with no renames, so HUD reducers need no rework for the
  events.
- Tower became a first-class orchestration mode (`/tower`, PR #3099) behind
  the experimental `KIMI_CODE_EXPERIMENTAL_TOWER` flag (off by default). The
  durable `tower_mode.enter` / `tower_mode.exit` records carry a required
  `agentId`, and `enter` gains an optional `sessionId`, which the HUD ignores
  while keeping the boolean last-enter/exit-wins fold over both Tower records
  and the upstream `tower` / `tower.owner` state keys (`tower.owner` is not
  itself a wire record); it renders the `[tower]` accent badge (covered, verified
  end to end against a live 0.39.0 `/tower` session). The
  host `AppState` exposes `towerMode`, but the status-line payload does not
  carry it, so it stays host-owned and is not drawn by the command. A one-time
  bounded projection upgrade re-scans existing main-wire history so a resumed
  Tower session is not stuck off because an older HUD cursor passed the enter
  row; sessions with no Tower records keep the prior badge (`towerMode`
  defaults false).
- Concurrent `subagent_fork` (PR #3007, `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK`,
  off by default) forks subagents that keep the ordinary session layout
  (`agents/<id>/wire.jsonl`) and report task `kind` as `agent`; session
  discovery and usage enumeration are unaffected (covered).
- The shared protocol `taskSchema` adds optional `parent_tool_call_id` and
  `run_in_background`, and KAP REST adds `POST /tasks/{id}:detach`; both are
  host-owned and not consumed by the HUD.
- `--allow-remote-terminals` was removed; it is a host security surface with no
  HUD dependency.

Baseline delta (0.39.0 → 0.39.1):

- The `status_line.command` payload/runner contract, first-stdout-line
  contract, 300ms host ceiling, footer line ownership, Git status model, and
  persisted wire manifest are unchanged; `status-line-command.ts`, the footer,
  and `wire-manifest.d.ts` are untouched in the release range, so HUD reducers
  need no rework.
- Additive upstream changes are all outside HUD consumption: `turn.started`
  prompt attachments gain an optional `file` variant, a global
  `event.config.warning` push and kap-server `event.config.changed` fan-out
  were added on the WebSocket side, and the shared REST `GET /v1/auth` summary
  renames `ready` to `models_ready` and drops `default_model`. The HUD parses
  no `promptAttachments`, consumes no WebSocket events, and does not call
  kap-server REST, so these are ignored rather than consumed.

Baseline delta (0.39.1 → 0.40.0):

- The `status_line.command` payload/runner contract is unchanged:
  `status-line-command.ts` is untouched in the release range and the payload
  keeps the same fields, so HUD parsing needs no rework.
- The persisted wire manifest grows from 55 to 60 record types: new
  `prompt.aborted` / `prompt.completed` / `prompt.steered` and
  `turn.step.interrupted` / `turn.step.retrying` records. HUD reducers gate on
  known types and ignore the new records; `usage.record`, `task.started`, and
  `task.terminated` payloads are unchanged (covered).
- `config.update` / `profile.bind` drop the optional
  `environmentDisclosure.date` subfield, and `turn.prompt` gains an optional
  `promptId`; the HUD folds read fixed field sets — it never read
  `environmentDisclosure` — so removals cannot surface and additions are
  ignored (covered).
- `plan.revision` renames `path` to `key`; the HUD folds no `plan.revision`
  rows (host-owned).
- `tower_mode.enter` gains an optional `base` field, tower mode becomes
  mutually exclusive with plan/swarm mode, and upstream tower workers now
  start from the base checkout's uncommitted changes. The HUD's
  last-enter/exit-wins boolean fold ignores the new field and keeps working
  (covered; the worker-checkout change is an upstream workflow fix with no
  HUD surface).
- The footer line-1 permission badge wording is now sourced from a new
  `permission-mode.ts` display table (`manual` → "Always Ask", `yolo` →
  "Ask When Needed", `auto` → "Never Ask"). The payload `permissionMode`
  values are unchanged; the HUD mirrors the official labels by default
  (`[Always Ask]` / `[Ask When Needed]` / `[Never Ask]`), with the historical
  short badges available via `KIMI_HUD_PERMISSION_NAMES=short` (covered;
  `short` is a HUD presentation variant, and the always-present manual badge
  renders in a faded primary blue (`#54658A` dark / `#7D92B8` light) so muted
  gray keeps its reserved inferred/degraded meaning).
- The shared protocol `sessionAgentConfigSchema` gains optional `tower_base`,
  kap-server REST adds workspace/skill/prompt routes, `kimi acp` no longer
  honors `KIMI_CODE_LEGACY_FLAG`, and the `[secondary_model]` subagent pool
  is enabled by default; none of these touch the status-line payload or the
  wire records the HUD folds (host-owned / not consumed).
- Upstream now parses `git status --porcelain` with `-z` for non-ASCII paths
  (PR #3415). The HUD's own dirty probe reads non-`-z` porcelain output but
  only derives a boolean from any non-`##` line, so quoted non-ASCII paths
  cannot flip it (verified, no HUD impact).

Baseline delta (0.40.0 → 0.40.1):

- The `status_line.command` payload/runner contract, the footer, the shared
  protocol, KAP WebSocket event schemas, and the task/subagent record shapes
  are all untouched in the release range, so HUD parsing needs no rework.
- The persisted wire manifest grows from 60 to 62 record types: new
  `file_history.checkpoint` / `file_history.tracked` records behind the
  experimental turn-level file history flag. HUD reducers gate on known types
  and ignore both records; their payloads carry only path/hash/size metadata,
  not file contents (covered).
- The agent state manifest drops the internal `agentsMdReminder.pending` key
  and adds a `fileHistory` key; no consumer reads agent state directly
  (host-owned).
- kap-server REST registers experimental file-history routes; the HUD calls
  no kap-server REST (host-owned).
- Other upstream fixes (AGENTS.md re-reminder after context loss, kimi-cli
  migration re-prompt, vscode engine-backed @ suggestions) sit outside HUD
  consumption (not consumed).

Baseline delta (0.40.1 → 0.41.0):

- The `status_line.command` payload/runner contract is unchanged:
  `status-line-command.ts` does not appear in the release range, so HUD
  parsing needs no rework. `footer.ts` changes only a header comment
  (`[ask-when-needed]` → `[Ask When Needed]`), kap-server and the shared
  protocol are untouched, and `paths.ts` only adds the survey-state file
  (covered / host-owned).
- The persisted wire manifest shrinks from 62 to 60 record types:
  `staleGuard.recorded` / `staleGuard.cleared` are removed (upstream PR
  #3517, not listed in the changelog), and the agent state manifest drops
  the `staleGuard` key. The HUD never consumed these records at runtime;
  its fixture still locks correct folding for pre-0.41.0 sessions that
  contain them (covered).
- `turn.ended` gains an optional `stopReason`, and the state manifest adds
  `fullCompaction.wireRanges`, `toolDedupe.handoffPhase`, and an optional
  `stopCode` on task entries. HUD folds read fixed field sets, so the
  additions are ignored (covered; `stopReason` is readable-but-unrendered).
- #3515 shipped without a changeset entry: `/ask-when-needed` and
  `/never-ask` are removed, and `/yolo` (alias `/yes`) / `/auto` now open
  the permission selector with the corresponding mode preselected instead
  of switching immediately. `PERMISSION_MODE_DISPLAY_NAMES` is unchanged
  ("Always Ask" / "Ask When Needed" / "Never Ask") and the payload values
  are unchanged, so the badge mapping stays valid (covered; the trigger
  column below is updated).
- #3522 lets background question tasks stay running across turns, so a
  pending question can now appear in the HUD's task badge where questions
  previously vanished at turn end — this matches the built-in footer's
  every-non-agent-kind-is-a-task bucket rule and is locked by wire and
  sidecar fixture tests (covered, presentation-layer change).
- Other changes sit outside HUD consumption: turn-level file history
  becomes always-on (#3525), an occasional session rating prompt (#3516),
  tower-mode fixes under the experimental flag (#3461, plus the #3549 web
  tower UI), and print-mode session records no longer being lost on error
  exits (#3531) (host-owned / not consumed).
