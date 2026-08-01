import { cacheMetricFromState } from './cache-hit.mjs';
import {
  ACTIVE_WINDOW_MS,
  MAX_SAMPLES,
  MIN_SAMPLES,
  SAMPLE_WINDOW_MS,
  TPS_TTL_MS,
} from './metrics-constants.mjs';
import { median } from './metrics-math.mjs';

/** Convert persisted reducer state into the stable public getMetrics shape. */
export function summarizeMetrics(state, { now = Date.now(), agentNames = null } = {}) {
  const activeSpeeds = [];
  const activeTtfts = [];
  let activeAgents = 0;
  let soleActive = null;
  let changed = false;
  const names = agentNames && agentNames.size ? [...agentNames] : Object.keys(state.agents);
  for (const name of names) {
    const agent = state.agents[name];
    if (!agent) continue;
    const fresh = agent.samples.filter(
      (sample) => (
        sample &&
        typeof sample.v === 'number' &&
        typeof sample.t === 'number' &&
        sample.t >= now - SAMPLE_WINDOW_MS
      ),
    );
    if (fresh.length !== agent.samples.length) {
      agent.samples = fresh;
      changed = true;
    }
    const speed = median(fresh.slice(-MAX_SAMPLES).map((sample) => sample.v));
    const generating =
      agent.lastRequestAt !== null &&
      now - agent.lastRequestAt < SAMPLE_WINDOW_MS &&
      (agent.lastStepEndAt === null || agent.lastRequestAt > agent.lastStepEndAt);
    const recent =
      fresh.length > 0 &&
      fresh[fresh.length - 1].t >= now - ACTIVE_WINDOW_MS;
    if (!generating && !recent) continue;
    activeAgents += 1;
    soleActive = { bucket: agent, fresh };
    if (speed !== null) activeSpeeds.push(speed);
    if (
      agent.lastTtftMs !== null &&
      agent.lastSampleAt !== null &&
      agent.lastSampleAt >= now - SAMPLE_WINDOW_MS
    ) {
      activeTtfts.push(agent.lastTtftMs);
    }
  }

  let tps = null;
  let tpsStale = false;
  let tpsTotal = null;
  let ttftMs = null;
  if (activeAgents >= 2) {
    if (activeSpeeds.length > 0) {
      tpsTotal = activeSpeeds.reduce((sum, value) => sum + value, 0);
      tps = tpsTotal / activeSpeeds.length;
    }
    ttftMs = median(activeTtfts);
  } else if (activeAgents === 1) {
    const values = soleActive.fresh.slice(-MAX_SAMPLES).map((sample) => sample.v);
    const windowMedian = soleActive.fresh.length >= MIN_SAMPLES ? median(values) : null;
    const newest = soleActive.fresh.length
      ? soleActive.fresh[soleActive.fresh.length - 1].t
      : null;
    if (windowMedian !== null && newest !== null && now - newest <= TPS_TTL_MS) {
      tps = windowMedian;
    } else if (soleActive.bucket.lastMedian !== null) {
      tps = soleActive.bucket.lastMedian;
      tpsStale = true;
    }
    ttftMs = soleActive.bucket.lastTtftMs ?? null;
  } else {
    const mainMedian = state.agents.main?.lastMedian ?? null;
    if (mainMedian !== null) {
      tps = mainMedian;
      tpsStale = true;
    }
    ttftMs = state.agents.main?.lastTtftMs ?? null;
  }

  const main = state.agents.main;
  const turnStartedAt = main
    && main.lastTurnPromptAt !== null
    && (main.lastTurnEndAt === null || main.lastTurnPromptAt > main.lastTurnEndAt)
    ? main.lastTurnPromptAt
    : null;
  let compactingSince = null;
  let compactionMs = null;
  if (main) {
    const beginAt = main.lastCompactionBeginAt;
    const endAt = main.lastCompactionEndAt;
    if (
      beginAt !== null &&
      (endAt === null || beginAt > endAt) &&
      now - beginAt < SAMPLE_WINDOW_MS
    ) {
      compactingSince = beginAt;
    } else if (
      typeof main.lastCompactionMs === 'number' &&
      endAt !== null &&
      (main.lastTurnPromptAt === null || endAt > main.lastTurnPromptAt)
    ) {
      compactionMs = main.lastCompactionMs;
    }
  }
  return {
    changed,
    metrics: {
      tps,
      tpsStale,
      ttftMs,
      thinkingLevel: state.thinkingLevel ?? null,
      goal: state.goal ?? null,
      modelAlias: state.modelAlias ?? null,
      swarmMode: state.swarmMode === true,
      cache: cacheMetricFromState(state),
      tpsTotal,
      activeAgents,
      turnStartedAt,
      compactingSince,
      compactionMs,
    },
  };
}
