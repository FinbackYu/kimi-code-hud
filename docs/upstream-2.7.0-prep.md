# Kimi Code 2.7.0 prep — HUD

Prepared 2026-11-18 on top of the audited 2.6.3 baseline. This branch does not
claim that #4754, #4820 or #4840 is released, must not merge to `main` before
its upstream stable acceptance, and remains inert on released 2.6.x records.

## Release-status evidence

- Latest stable reviewed: annotated `@moonshot-ai/kimi-code@2.6.3`, tag object
  `a9df46689649824abfdfff1528d7708a23fd3cf3`, peeled commit
  `b0de2fbd2de04d87689225aafd3912e5d193b62d` (2026-11-17 15:15 UTC).
- Its manifest is byte-identical to 2.6.1: request kinds remain loop/compaction
  and usage scopes remain session/turn. No `prediction` row belongs to stable.
- `journal.ts` and `llm-adapter/model/generate.ts` are also byte-identical to
  2.6.1. The 2.6.3 `settle.ts` delta handles repeated output and missing finish
  events; it does not implement #4820's timing move.
- Future behavior comes from merged upstream PRs
  [#4754](https://github.com/MoonshotAI/kimi-code/pull/4754) (prediction),
  [#4820](https://github.com/MoonshotAI/kimi-code/pull/4820) (timing) and
  [#4840](https://github.com/MoonshotAI/kimi-code/pull/4840) (explicit profile
  binding), not from a patched checkout or an assumed release changelog.

## #73 prediction decisions

- `src/metrics-throughput.mjs` ignores `kind: prediction` when advancing
  `lastRequestAt`, just as it already ignores compaction. A side request after
  `turn.ended` therefore cannot create a ten-minute false generating window.
- `src/metrics-session-meta.mjs` ignores prediction for main-agent model and
  thinking metadata. It cannot reset the previous model's speed samples.
- Session Cost deliberately **includes** `usageScope: prediction`: it represents
  a real billable model call, not a free UI preview. The estimate remains a
  local all-agent session estimate, never an API balance or server bill.

The synthetic `wire-events-prompt-prediction.jsonl` fixture appends a completed
turn, one prediction request with different model/thinking, and one prediction
usage record. Its semantic baseline deletes only the request and retains the
same tokens as turn scope. Reducer state, persisted state, metrics and rendered
lines must match that baseline.

## #75 timing decisions

- Follow the host's future TTFT definition: time from `generate` entry, which
  includes request-build. Do not subtract `llmRequestBuildMs` to recreate the
  old settle-entry boundary.
- Follow the future TPS denominator: stream time ending at `decoder.end()`.
  Continue consuming `llmStreamDurationMs`; no compensating multiplier or
  alternate client-side timer is introduced.
- Keep `MIN_STREAM_MS = 250` and `MAX_TPS = 1000` for now. A shorter upstream
  duration can move boundary samples, but no released real-sample distribution
  exists here to justify changing either threshold. Existing boundary tests
  remain the counterexamples against silently accepting <250ms or >1000 t/s.
- Keep the 2.5.3 timing fixture unchanged as history. No synthetic values are
  presented as a real 2.6.x/2.7.0 recording and no timing code change is needed
  for the field-preserving upstream refactor.

## #4840 monitor follow-up

A focused reducer counterexample binds `thinkingEffort: off`, interleaves a
content-bearing `tool_select.tools_changed`, then binds `off` again. The HUD
keeps `off` and never persists tool content. No runtime change was necessary.

## Old-implementation counterexamples and verification

Before the two-line reducer fix, the focused suite reported three failures:

1. prediction advanced `lastRequestAt` from the conversational request to the
   side request;
2. direct folding replaced model/thinking and reset the old model's samples;
3. the full fixture differed from its no-prediction-activity baseline.

After the fix, the same 75-test focused suite passes, including the explicit
`activeAgents = 0` / `mainActive = false` idle assertion and the positive
prediction-cost ledger case. The full-suite result is recorded in the issue
completion comment after the final run.

## Remaining release-day checklist

### #73

- [x] Exclude prediction from activity and main model/thinking.
- [x] Decide and test that real prediction usage stays in Session Cost.
- [x] Add the combined request/usage fixture to wire row-class coverage.
- [x] Document the caliber in both READMEs and CAPABILITIES.
- [ ] Verify against the first stable release that actually persists these two
  prediction values; then run release-day acceptance before merging/closing.

### #75

- [x] Decide to follow host TTFT including request-build and TPS ending at
  `decoder.end()` without local compensation.
- [x] Review the thresholds and decline speculation-based changes.
- [ ] Capture real released-host timing samples and add a clearly sourced new
  fixture; revisit the 250ms and 1000 t/s boundaries from that distribution.
- [ ] Verify the first stable release containing #4820 before merging/closing.

Monitor-owned issue titles and bodies are not edited. Progress and evidence go
in comments only; both issues remain open pending those unchecked items.
