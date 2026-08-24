import { normAgent } from './metrics-agent.mjs';
import {
  MAX_SAMPLES,
  MAX_STORED_SAMPLES,
  MAX_TPS,
  MIN_SAMPLES,
  MIN_STREAM_MS,
  TPS_TTL_MS,
} from './metrics-constants.mjs';
import { median } from './metrics-math.mjs';

export function resetFleetWindows(state) {
  for (const agent of Object.values(state.agents || {})) {
    agent.samples = [];
    agent.lastTtftMs = null;
    agent.lastSampleAt = null;
    agent.lastMedian = null;
  }
}

/** Fold request lifecycle, TTFT and TPS fields for one agent. */
export function applyThroughputRow(state, row, agent = 'main') {
  if (!state.agents || typeof state.agents !== 'object') state.agents = {};
  const bucket = normAgent(state.agents[agent]);
  state.agents[agent] = bucket;
  const rowTime = Number.isFinite(row?.time) && row.time >= 0 ? row.time : null;

  if (row?.type === 'llm.request') {
    if (
      row.kind !== 'compaction' &&
      rowTime !== null &&
      (bucket.lastRequestAt === null || rowTime > bucket.lastRequestAt)
    ) {
      bucket.lastRequestAt = rowTime;
    }
    return;
  }
  const activeCancel = row?.type === 'turn.cancel' && row.target !== 'queued';
  if (
    row?.type === 'turn.ended' ||
    row?.type === 'full_compaction.complete' ||
    activeCancel
  ) {
    if (
      rowTime !== null &&
      (bucket.lastStepEndAt === null || rowTime > bucket.lastStepEndAt)
    ) {
      bucket.lastStepEndAt = rowTime;
    }
    return;
  }
  const event = row?.event;
  // A tool_use step's step.end is journaled only when the tool returns, so
  // while a long-blocking tool runs (AgentSwarm being the extreme case) the
  // step's llm.request keeps looking "in flight". The tool.call row marks
  // the moment the LLM actually stopped generating; the swarm-mode parked
  // check in metrics-summary uses it to tell streaming from waiting.
  if (
    row?.type === 'context.append_loop_event' &&
    event?.type === 'tool.call' &&
    rowTime !== null &&
    (bucket.lastToolCallAt === null || rowTime > bucket.lastToolCallAt)
  ) {
    bucket.lastToolCallAt = rowTime;
  }
  if (row?.type !== 'context.append_loop_event' || event?.type !== 'step.end') return;
  if (
    rowTime !== null &&
    (bucket.lastStepEndAt === null || rowTime > bucket.lastStepEndAt)
  ) {
    bucket.lastStepEndAt = rowTime;
  }
  if (
    Number.isFinite(event.llmFirstTokenLatencyMs) &&
    event.llmFirstTokenLatencyMs >= 0
  ) {
    bucket.lastTtftMs = event.llmFirstTokenLatencyMs;
  }
  const output = event.usage && typeof event.usage.output === 'number'
    ? event.usage.output
    : 0;
  const streamMs = typeof event.llmStreamDurationMs === 'number'
    ? event.llmStreamDurationMs
    : 0;
  const tps = output / (streamMs / 1000);
  if (
    !Number.isFinite(output) ||
    output <= 0 ||
    !Number.isFinite(streamMs) ||
    streamMs < MIN_STREAM_MS ||
    !Number.isFinite(tps) ||
    tps > MAX_TPS ||
    rowTime === null
  ) {
    return;
  }
  if (
    Number.isFinite(bucket.lastSampleAt) &&
    rowTime - bucket.lastSampleAt > TPS_TTL_MS
  ) {
    bucket.samples = [];
  }
  bucket.samples.push({ v: tps, t: rowTime });
  if (bucket.samples.length > MAX_STORED_SAMPLES) {
    bucket.samples.splice(0, bucket.samples.length - MAX_STORED_SAMPLES);
  }
  bucket.lastSampleAt = rowTime;
  if (bucket.samples.length >= MIN_SAMPLES) {
    bucket.lastMedian = median(
      bucket.samples.slice(-MAX_SAMPLES).map((sample) => sample.v),
    );
  }
}
