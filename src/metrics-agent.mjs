/** Complete initializer for one wire reader and its derived agent metrics. */
export function emptyAgent() {
  return {
    offset: 0,
    fileId: null,
    pendingBase64: '',
    discardingLine: false,
    tailMarker: null,
    samples: [],
    lastMedian: null,
    lastTtftMs: null,
    lastSampleAt: null,
    lastRequestAt: null,
    lastStepEndAt: null,
    lastToolCallAt: null,
    lastTurnPromptAt: null,
    lastTurnEndAt: null,
    lastUserPromptAt: null,
    lastCompactionBeginAt: null,
    lastCompactionEndAt: null,
    lastCompactionMs: null,
  };
}

/** Normalize a persisted per-agent bucket in place. */
export function normAgent(agent) {
  if (!agent || typeof agent !== 'object') return emptyAgent();
  if (typeof agent.offset !== 'number') agent.offset = 0;
  if (typeof agent.fileId !== 'string') agent.fileId = null;
  if (typeof agent.pendingBase64 !== 'string') agent.pendingBase64 = '';
  if (typeof agent.discardingLine !== 'boolean') agent.discardingLine = false;
  if (typeof agent.tailMarker !== 'string') agent.tailMarker = null;
  if (!Array.isArray(agent.samples)) agent.samples = [];
  if (typeof agent.lastMedian !== 'number') agent.lastMedian = null;
  if (typeof agent.lastTtftMs !== 'number') agent.lastTtftMs = null;
  if (typeof agent.lastSampleAt !== 'number') agent.lastSampleAt = null;
  if (typeof agent.lastRequestAt !== 'number') agent.lastRequestAt = null;
  if (typeof agent.lastStepEndAt !== 'number') agent.lastStepEndAt = null;
  if (typeof agent.lastToolCallAt !== 'number') agent.lastToolCallAt = null;
  if (typeof agent.lastTurnPromptAt !== 'number') agent.lastTurnPromptAt = null;
  if (typeof agent.lastTurnEndAt !== 'number') agent.lastTurnEndAt = null;
  if (typeof agent.lastUserPromptAt !== 'number') agent.lastUserPromptAt = null;
  if (typeof agent.lastCompactionBeginAt !== 'number') agent.lastCompactionBeginAt = null;
  if (typeof agent.lastCompactionEndAt !== 'number') agent.lastCompactionEndAt = null;
  if (typeof agent.lastCompactionMs !== 'number') agent.lastCompactionMs = null;
  return agent;
}
