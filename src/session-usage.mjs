import {
  readBoundedWire,
  wireTailMatches,
} from './wire-reader.mjs';

export const SESSION_USAGE_STATE_V = 1;

const USAGE_FIELDS = [
  'inputOther',
  'inputCacheRead',
  'inputCacheCreation',
  'output',
];

function emptyTokens() {
  return {
    inputOther: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    output: 0,
  };
}

function validTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeTokens(value) {
  if (!value || typeof value !== 'object') return null;
  if (!USAGE_FIELDS.every((field) => validTokenCount(value[field]))) return null;
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, value[field]]));
}

function emptyReader(fileId = null) {
  return {
    offset: 0,
    fileId,
    pendingBase64: '',
    discardingLine: false,
    tailMarker: null,
  };
}

function normalizeReader(value) {
  const reader = value && typeof value === 'object' ? value : emptyReader();
  if (!Number.isSafeInteger(reader.offset) || reader.offset < 0) reader.offset = 0;
  if (typeof reader.fileId !== 'string') reader.fileId = null;
  if (typeof reader.pendingBase64 !== 'string') reader.pendingBase64 = '';
  if (typeof reader.discardingLine !== 'boolean') reader.discardingLine = false;
  if (typeof reader.tailMarker !== 'string') reader.tailMarker = null;
  return reader;
}

function emptyAgentUsage(fileId = null) {
  return {
    reader: emptyReader(fileId),
    byModel: {},
  };
}

function normalizeAgentUsage(value) {
  const usage = value && typeof value === 'object' ? value : emptyAgentUsage();
  usage.reader = normalizeReader(usage.reader);
  const byModel = {};
  if (usage.byModel && typeof usage.byModel === 'object') {
    for (const [model, tokens] of Object.entries(usage.byModel)) {
      if (typeof model !== 'string' || !model || model.length > 256) continue;
      const normalized = normalizeTokens(tokens);
      if (normalized) byModel[model] = normalized;
    }
  }
  usage.byModel = byModel;
  return usage;
}

export function emptySessionUsageState() {
  return {
    v: SESSION_USAGE_STATE_V,
    complete: false,
    agents: {},
  };
}

/** Normalize the persisted, content-free all-agent usage ledger in place. */
export function normalizeSessionUsageState(value) {
  const usage = value && typeof value === 'object' && value.v === SESSION_USAGE_STATE_V
    ? value
    : emptySessionUsageState();
  if (typeof usage.complete !== 'boolean') usage.complete = false;
  const agents = {};
  if (usage.agents && typeof usage.agents === 'object') {
    for (const [agent, agentUsage] of Object.entries(usage.agents)) {
      if (typeof agent !== 'string' || !agent || agent.length > 256) continue;
      agents[agent] = normalizeAgentUsage(agentUsage);
    }
  }
  usage.agents = agents;
  return usage;
}

function addTokens(target, usage) {
  for (const field of USAGE_FIELDS) target[field] += usage[field];
}

/** Fold exactly one persisted usage.record delta; step.end is ignored. */
export function applySessionUsageRow(agentUsage, row) {
  const normalized = normalizeAgentUsage(agentUsage);
  if (row?.type !== 'usage.record' || typeof row.model !== 'string' || !row.model) return false;
  if (row.model.length > 256) return false;
  const tokens = normalizeTokens(row.usage);
  if (!tokens) return false;
  const current = normalized.byModel[row.model] || emptyTokens();
  if (USAGE_FIELDS.some((field) => current[field] > Number.MAX_SAFE_INTEGER - tokens[field])) {
    return false;
  }
  addTokens(current, tokens);
  normalized.byModel[row.model] = current;
  return true;
}

function processUsageChunk(agentUsage, text) {
  for (const line of text.split('\n')) {
    if (!line || !line.includes('"type":"usage.record"')) continue;
    try {
      applySessionUsageRow(agentUsage, JSON.parse(line));
    } catch {
      // One malformed journal row must not poison the remaining ledger.
    }
  }
}

/**
 * Advance a dedicated usage reader. It intentionally does not share the live
 * metrics cursor: migrated HUD state can reconstruct the whole session without
 * replaying or disturbing TPS, Cache, goal, or task projections.
 */
export function advanceSessionUsageAgent({
  state,
  agent,
  wirePath,
  fileId,
  fileSize,
  maxBytes,
} = {}) {
  const sessionUsage = normalizeSessionUsageState(state?.sessionUsage);
  if (state && typeof state === 'object') state.sessionUsage = sessionUsage;
  const existing = sessionUsage.agents[agent];
  let agentUsage = normalizeAgentUsage(existing);
  const reader = agentUsage.reader;
  const replaced =
    reader.offset > fileSize
    || (reader.fileId !== null && reader.fileId !== fileId)
    || (reader.fileId === fileId && !wireTailMatches(wirePath, reader));
  if (replaced) agentUsage = emptyAgentUsage(fileId);
  const adoptedFileId = agentUsage.reader.fileId !== fileId;
  if (adoptedFileId) agentUsage.reader.fileId = fileId;
  sessionUsage.agents[agent] = agentUsage;

  const result = readBoundedWire(
    wirePath,
    agentUsage.reader,
    fileSize,
    Math.max(0, Math.floor(maxBytes || 0)),
  );
  if (result.text) processUsageChunk(agentUsage, result.text);
  return {
    bytesRead: result.bytesRead,
    changed: existing === undefined || replaced || adoptedFileId || result.bytesRead > 0,
    complete:
      agentUsage.reader.offset >= fileSize
      && agentUsage.reader.pendingBase64 === ''
      && agentUsage.reader.discardingLine === false,
  };
}

/** Return all-agent, model-scoped totals only after every visible wire is caught up. */
export function sessionUsageMetricFromState(state, agentNames = null) {
  const sessionUsage = normalizeSessionUsageState(state?.sessionUsage);
  if (sessionUsage.complete !== true) return null;
  const names = agentNames && agentNames.size
    ? [...agentNames]
    : Object.keys(sessionUsage.agents);
  const byModel = {};
  for (const agent of names) {
    const agentUsage = sessionUsage.agents[agent];
    if (!agentUsage) continue;
    for (const [model, tokens] of Object.entries(agentUsage.byModel)) {
      const target = byModel[model] || emptyTokens();
      if (USAGE_FIELDS.some((field) => target[field] > Number.MAX_SAFE_INTEGER - tokens[field])) {
        return null;
      }
      addTokens(target, tokens);
      byModel[model] = target;
    }
  }
  return Object.keys(byModel).length > 0
    ? { scope: 'session', agents: 'all', byModel }
    : null;
}
