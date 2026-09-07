export const MAX_SAMPLES = 5;
export const MIN_SAMPLES = 3;
export const MIN_STREAM_MS = 250;
export const MAX_TPS = 1000;
export const TPS_TTL_MS = 2 * 60 * 1000;
export const SAMPLE_WINDOW_MS = 10 * 60 * 1000;
export const ACTIVE_WINDOW_MS = TPS_TTL_MS;
export const MAX_STORED_SAMPLES = 20;
export const SAMPLE_STATE_V = 1;
export const CACHE_SCAN_V = 2;
export const CACHE_BACKFILL_MAX_BYTES = 1024 * 1024;
export const BACKFILL_SCAN_V = 10;
export const METRICS_STATE_V = 9;
/**
 * Grace window after a cascade settles (last turn end) or a compaction
 * closes, during which the frozen figures still render in the normal color:
 * the TPS last-median fallback and the settled `gen X` / `compacted X`
 * durations are the fresh answer to "how fast / how long" right after a task
 * ends, and dimming them the instant activity stops reads as breakage.
 * Past the window they fade to the muted post-settle dim until the next live
 * timer takes over. Matches the quota TTL scale — long enough to cover the
 * moment the user looks back at the footer, short enough not to masquerade
 * as a live reading.
 */
export const SETTLE_LINGER_MS = 60_000;
