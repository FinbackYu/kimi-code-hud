# Current-turn cache hit rate design

Status: approved for implementation planning on 2026-07-31.

## Summary

Add a cache hit-rate segment to the Kimi Code HUD. The metric describes the
most recent user prompt's complete main-agent turn: all LLM requests triggered
by one `turn.prompt`, including requests made after tool calls. It is computed
from the existing local `wire.jsonl` stream, adds no network access or
dependency, and remains within the host's 300ms status-line deadline.

The HUD will show a token-weighted rate rather than the last request's rate or
an average of request-level percentages.

## Goals

- Show a stable, immediately useful prompt-cache hit rate for the current user
  turn.
- Use Kimi Code's official token-usage fields and formula.
- Reset at the start of each new user turn and update after every completed LLM
  step.
- Restore the latest complete turn after a HUD restart or plugin upgrade when
  that can be done safely within a bounded scan.
- Preserve the HUD's silent-fallback behavior and hot-path latency.

## Non-goals

- No session-, account-, or billing-period cache analytics.
- No aggregation across subagent wire files; the metric covers the main agent
  whose HUD is being rendered.
- No cache cost or money-saved estimate.
- No configurable time window, thresholds, progress bar, or quality coloring.
- No network request and no change to the status-line payload contract.

## Metric definition

For every valid `context.append_loop_event` whose event is `step.end`, read:

- `usage.inputOther`
- `usage.inputCacheRead`
- `usage.inputCacheCreation`

For one user turn:

```text
cacheReadTokens = Σ inputCacheRead
inputTokens = Σ (inputOther + inputCacheRead + inputCacheCreation)
cacheHitRate = cacheReadTokens / inputTokens
```

`inputCacheCreation` belongs in the denominator because it is input written to
the provider cache, not input served from that cache. This matches Kimi Code
0.31.0's own debug-timing calculation.

The calculation sums tokens before dividing. It must not average individual
request percentages, because that would give small and large requests equal
weight.

## Turn boundary

`turn.prompt` is the authoritative reset event. When it is observed, the
previous cache counters are cleared immediately and the renderer returns no
cache metric until the first valid `step.end` for the new turn completes.

All `step.end` rows with the same `event.turnId` are accumulated. A changed
`turnId` also resets the reducer as a defensive fallback if a future or older
host omits `turn.prompt`.

After a turn ends, its final rate remains visible while the session is idle.
The next `turn.prompt` clears it. Thus "current turn" means the in-progress
turn while work is happening and the most recently completed user turn while
idle.

The reducer consumes `step.end` only. It must not also consume
`usage.record`, because both rows describe the same request and would double
count tokens.

## Architecture and data flow

### Pure cache reducer

Add `src/cache-hit.mjs` to own the cache-specific state transition and derived
metric:

```text
wire row
  -> applyCacheWireRow(cacheTurnState, row)
  -> cacheTurnState
  -> cacheMetricFromState(cacheTurnState)
  -> null | { hitRate, readTokens, inputTokens }
```

The persisted state contains:

```text
cacheTurn: {
  turnId: string | number | null,
  readTokens: number,
  inputTokens: number,
  complete: boolean
}
cacheNeedsPrompt: boolean
cacheScanV: 1
```

The reducer only inspects event types and numeric usage fields. It never stores
prompt text, model output, tool arguments, or credentials.

### Metrics integration

`src/metrics.mjs` remains responsible for locating the session wire file,
incremental byte-offset reads, rotation handling, and atomic state persistence.
Every newly parsed row is also passed to the cache reducer.

`getMetrics()` adds one result field:

```text
cache: null | {
  hitRate: number,     // 0..1
  readTokens: number,
  inputTokens: number
}
```

Existing TPS, TTFT, thinking, goal, and swarm behavior is unchanged. Log
truncation or replacement resets the cache-turn state along with the other
stream-derived state.

### Bounded one-time restoration

Existing metrics state files may already have their byte offset at the end of
the log when this feature is installed. A separate `cacheScanV` migration
performs one cache-only restoration:

1. Read at most 1 MiB immediately before the saved metrics offset.
2. Discard an incomplete leading line.
3. Find the last complete `turn.prompt`.
4. Reduce only cache-relevant rows from that prompt through the saved offset.
5. Persist `cacheScanV: 1`.

This restoration does not call the general TPS reducer, so old speed samples
are not duplicated. Bytes after the saved offset are still handled by the
normal incremental scan.

If no complete `turn.prompt` is found inside the 1 MiB bound, set
`cacheNeedsPrompt: true` and return no cache metric. Subsequent `step.end` rows
are ignored until a new `turn.prompt` arrives. This intentionally prefers a
temporarily absent metric over a partial and incorrect rate.

Fresh sessions whose saved offset is zero need no separate restoration; the
normal incremental scan sees their turn boundary and usage rows in order.

## Validation and error behavior

All three input usage fields must be finite, non-negative numbers. If a
`step.end` has missing, non-numeric, infinite, or negative usage:

- do not add that row;
- mark the current turn incomplete;
- hide the cache metric for the rest of that turn.

The next turn resets the incomplete flag. This avoids presenting a precise
percentage calculated from partial data.

If total input is zero, return `null`. A valid turn with positive input and
zero cache reads returns a real `0%`.

All file, parsing, and persistence failures retain the existing silent
fallback: no diagnostic text is written to stdout or stderr during rendering.

## HUD presentation

The cache segment sits after TPS/TTFT and before quota:

```text
[manual] K3 │ kimi-code-hud git:(main*) │ ⚡ 47 t/s · TTFT 1.3s │ Cache 92% │ 5h ...
```

Layout-specific forms:

```text
compact: Cache 92%
normal:  Cache 92%
full:    Cache 92% (86K/94K)
```

The full-layout counts mean `cache read tokens / total input tokens`. Counts
reuse the HUD's existing base-1024 token formatter. Percentages are rounded to
the nearest integer, consistent with quota percentages.

The segment has no progress bar and no red/yellow/green thresholds. Cache hit
quality depends on provider and workload, so an arbitrary threshold would
encode an unsupported judgment. The text uses the normal foreground color.

If cache data is unavailable or incomplete, omit the entire segment. Do not
render `N/A`, a placeholder, or a stale previous-turn value. The existing
visible-width defense continues to downgrade full to normal to compact; all
three layouts retain the percentage, while only full drops the detailed
counts during downgrade.

## Testing

Add focused coverage at three levels:

### `test/cache-hit.test.mjs`

- Official formula, including `inputCacheCreation` in the denominator.
- Token-weighted aggregation across multiple steps in one turn.
- Reset on `turn.prompt`.
- Defensive reset on a changed `turnId`.
- Positive-input zero hit rate.
- Zero-input omission.
- Missing, negative, infinite, and non-numeric field handling.
- Incomplete turns remain hidden until the next prompt.
- `usage.record` is ignored.

### `test/metrics.test.mjs`

- Incremental reads persist and resume current-turn counters.
- Log truncation and inode replacement reset cache state.
- The one-time restoration reads only the bounded tail and does not duplicate
  TPS samples or newly appended cache usage.
- Restoration without a complete prompt boundary hides the metric until the
  next prompt.
- Unknown sessions return `cache: null`.

### `test/render.test.mjs`

- Compact and normal show `Cache N%`.
- Full adds the read/input token counts.
- `cache: null` omits the segment cleanly.
- `0%` is rendered rather than omitted.
- Segment ordering is speed, cache, quota.
- Width downgrade keeps the percentage and drops only full details.
- ANSI mode does not introduce threshold coloring.

Verification commands:

```bash
npm test
node --check src/cache-hit.mjs
node --check src/metrics.mjs
node --check src/render.mjs
node bin/kimi-hud.mjs --help
printf '' | node bin/kimi-hud.mjs
git diff --check
```

## Documentation and release

Update both `README.md` and `README.en.md`:

- the top-level capability summary and HUD examples;
- layout descriptions;
- the `wire.jsonl` data-source row;
- the metric formula and current-turn boundary;
- the no-data behavior and a short FAQ entry.

Keep `package.json` and `kimi.plugin.json` synchronized at version `0.2.7`.
The release remains dependency-free.

## Acceptance criteria

- A multi-step user turn displays the token-weighted cache hit rate after the
  first valid step and updates after later steps.
- A new user prompt removes the old value before the new turn has valid usage.
- Restarting the HUD restores only a complete, bounded latest turn; otherwise
  it waits for the next prompt.
- No usage row is double counted.
- Existing HUD metrics and layout downgrade behavior continue to pass their
  tests.
- The hot path performs no network I/O, no recurring full-log scan, and no
  unbounded restoration scan.
