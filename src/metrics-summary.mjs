import { cacheMetricFromState } from './cache-hit.mjs';
import { taskCountsFromState } from './metrics-tasks.mjs';
import { sessionUsageMetricFromState } from './session-usage.mjs';
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
  let mainActive = false;
  let mainSpeed = false;
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
    // A subagent whose turn has ended (closing end_turn step.end, turn.ended
    // or an active turn.cancel) leaves the fleet immediately; the recency
    // window only keeps genuinely mid-turn agents counted. Main is exempt so
    // its just-finished speed survives until the stale TTL as before — except
    // in swarm mode, where a parked main (blocked inside the AgentSwarm tool)
    // must drop out too: otherwise its pre-swarm samples keep it counted —
    // and summed into the fleet total — for the whole recency window while
    // it is not generating at all. "Blocked" cannot be read off `generating`
    // alone: a tool_use step's step.end is journaled only when the tool
    // returns, so the step's llm.request looks in-flight for the entire
    // block. The step's tool.call row is the point where the LLM actually
    // stopped generating, so a request superseded by an unanswered tool.call
    // is waiting, not streaming. Hosts that predate the tool.call journal
    // keep the old request-based reading.
    const settled =
      name !== 'main' &&
      agent.lastTurnEndAt !== null &&
      (fresh.length === 0 || agent.lastTurnEndAt >= fresh[fresh.length - 1].t) &&
      (agent.lastRequestAt === null || agent.lastTurnEndAt >= agent.lastRequestAt);
    const waitingOnTool =
      agent.lastToolCallAt !== null && agent.lastToolCallAt > agent.lastRequestAt;
    const parkedMain =
      name === 'main' && state.swarmMode === true && (!generating || waitingOnTool);
    if (parkedMain || (!generating && (!recent || settled))) continue;
    activeAgents += 1;
    soleActive = { bucket: agent, fresh };
    if (name === 'main') mainActive = true;
    if (speed !== null) {
      activeSpeeds.push(speed);
      if (name === 'main') mainSpeed = true;
    }
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
  let tpsAgents = 0;
  let ttftMs = null;
  if (activeAgents >= 2) {
    if (activeSpeeds.length > 0) {
      tpsTotal = activeSpeeds.reduce((sum, value) => sum + value, 0);
      tpsAgents = activeSpeeds.length;
      tps = tpsTotal / tpsAgents;
    }
    ttftMs = median(activeTtfts);
  } else if (activeAgents === 1) {
    const values = soleActive.fresh.slice(-MAX_SAMPLES).map((sample) => sample.v);
    const windowMedian = soleActive.fresh.length >= MIN_SAMPLES ? median(values) : null;
    const newest = soleActive.fresh.length
      ? soleActive.fresh[soleActive.fresh.length - 1].t
      : null;
    const freshEnough = newest !== null && now - newest <= TPS_TTL_MS;
    if (windowMedian !== null && freshEnough) {
      tps = windowMedian;
    } else if (freshEnough) {
      // Provisional reading: fewer than MIN_SAMPLES fresh samples — typical
      // right after a model switch or the TTL reset at a new turn. Shown
      // dimmed (tpsStale) until the full median takes over.
      tps = median(values);
      tpsStale = true;
    } else if (soleActive.bucket.lastMedian !== null) {
      tps = soleActive.bucket.lastMedian;
      tpsStale = true;
    }
    // A lone live agent still reports its reading as a one-agent fleet
    // figure: a swarm that has run down to its last subagent must keep
    // feeding the renderer's fleet style.
    if (tps !== null) {
      tpsTotal = tps;
      tpsAgents = 1;
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
      hostVersion: state.hostVersion ?? null,
      swarmMode: state.swarmMode === true,
      cache: cacheMetricFromState(state),
      modelUsage: sessionUsageMetricFromState(state, agentNames),
      tpsTotal,
      tpsAgents,
      activeAgents,
      // Whether the main agent is part of the fleet figures — the renderer
      // labels such head counts "main+N" so they can't be misread as a pure
      // subagent count while a swarm is running.
      mainActive,
      mainSpeed,
      turnStartedAt,
      compactingSince,
      compactionMs,
      // Durable background-task running counts (bash processes vs background
      // subagents). Kept apart from the throughput head counts above: those
      // describe recent LLM generation and include the main agent, these
      // describe the task registry.
      tasks: taskCountsFromState(state),
    },
  };
}
