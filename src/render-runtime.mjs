import { performance } from 'node:perf_hooks';

import { isGitDirty } from './git.mjs';
import { removeManagedStatusLine } from './management-service.mjs';
import { getMetrics } from './metrics.mjs';
import { resolveModelProvider, MANAGED_KIMI_PROVIDER } from './model-config.mjs';
import { readPayload } from './payload.mjs';
import { managedPluginDisabled } from './plugin-state.mjs';
import {
  estimateProviderSessionCost,
  resolveProviderCostTarget,
} from './provider-cost.mjs';
import {
  ensureFreshProviderUsage,
  isProviderUsageStale,
  readProviderUsageCache,
  resolveProviderUsageTarget,
} from './provider-usage.mjs';
import { ensureFreshQuota } from './quota.mjs';
import { renderHud } from './render.mjs';
import { resolveRuntimePaths } from './paths.mjs';
import {
  captureRuntimeSnapshot,
  colorFromEnv,
  layoutFromSnapshot,
  permissionNamesFromSnapshot,
} from './runtime-snapshot.mjs';
import { resolveTheme } from './theme.mjs';
import { resolveThinkingLevel } from './thinking.mjs';

export const RUNTIME_BUDGET_MS = 220;
const GIT_MIN_REMAINING_MS = 12;
const REFRESH_MIN_REMAINING_MS = 8;

function remainingMs(deadline, clock) {
  return Math.max(0, deadline - clock());
}

/**
 * Data-plane entry point. It owns one render frame and returns one line;
 * command routing and process exit semantics stay in the executable.
 */
export async function renderStatusLine({
  scriptPath,
  paths = resolveRuntimePaths(),
  env = process.env,
  stdin = process.stdin,
  now = Date.now(),
  clock = () => performance.now(),
  dependencies = {},
} = {}) {
  const start = clock();
  const deadline = start + RUNTIME_BUDGET_MS;
  const pluginDisabled = dependencies.managedPluginDisabled || managedPluginDisabled;
  if (pluginDisabled(scriptPath, paths.kimiHome)) {
    removeManagedStatusLine({ scriptPath, tuiTomlPath: paths.tuiTomlPath });
    return { exitCode: 1, line: null };
  }

  const readPayloadImpl = dependencies.readPayload || readPayload;
  const payload = await readPayloadImpl({
    stdin,
    timeoutMs: Math.min(150, Math.floor(remainingMs(deadline, clock))),
  });
  if (!payload) return { exitCode: 0, line: 'kimi-code-hud' };

  const captureSnapshot = dependencies.captureRuntimeSnapshot || captureRuntimeSnapshot;
  const snapshot = captureSnapshot({ paths, deadline, clock });
  const getMetricsImpl = dependencies.getMetrics || getMetrics;
  const metrics = getMetricsImpl(payload.sessionId, {
    sessionsRoot: paths.sessionsRoot,
    stateDir: paths.hudDir,
    deadline,
    hostVersion: payload.version || null,
  });
  const provider = resolveModelProvider({
    modelAlias: metrics.modelAlias,
    modelDisplay: payload.model,
    configText: snapshot.configTomlText,
  });

  let quota = null;
  let providerUsage = null;
  if (provider === MANAGED_KIMI_PROVIDER) {
    quota = snapshot.quota;
    if (remainingMs(deadline, clock) >= REFRESH_MIN_REMAINING_MS) {
      const ensureQuota = dependencies.ensureFreshQuota || ensureFreshQuota;
      ensureQuota({
        scriptPath,
        cachePath: paths.quotaCachePath,
        lockPath: paths.quotaLockPath,
        cachedQuota: snapshot.quota,
        now,
      });
    }
  } else if (typeof provider === 'string' && provider.length > 0) {
    const providerUsageFacts = [];
    let providerCurrency = null;
    const resolveUsageTarget = dependencies.resolveProviderUsageTarget || resolveProviderUsageTarget;
    const target = resolveUsageTarget({
      provider,
      configText: snapshot.configTomlText,
      providerUsageDir: paths.providerUsageDir,
    });
    if (target) {
      const readUsageCache = dependencies.readProviderUsageCache || readProviderUsageCache;
      const cachedUsage = readUsageCache(target);
      if (cachedUsage) {
        const displayedBalance = cachedUsage.balances.find((item) => item.currency === 'CNY')
          || cachedUsage.balances.find((item) => item.currency === 'USD')
          || cachedUsage.balances[0];
        providerCurrency = displayedBalance?.currency || null;
        providerUsageFacts.push({
          ...cachedUsage,
          stale: isProviderUsageStale(cachedUsage, now),
        });
      }
      if (remainingMs(deadline, clock) >= REFRESH_MIN_REMAINING_MS) {
        const ensureUsage = dependencies.ensureFreshProviderUsage || ensureFreshProviderUsage;
        ensureUsage({ scriptPath, target, cachedUsage, now });
      }
    }
    const resolveCostTarget = dependencies.resolveProviderCostTarget || resolveProviderCostTarget;
    const costTarget = resolveCostTarget({
      provider,
      configText: snapshot.configTomlText,
      env,
    });
    if (costTarget) {
      const estimateCost = dependencies.estimateProviderSessionCost
        || estimateProviderSessionCost;
      const cost = estimateCost({
        target: costTarget,
        modelUsage: metrics.modelUsage,
        configText: snapshot.configTomlText,
        env,
        currency: providerCurrency,
        now,
      });
      if (cost) providerUsageFacts.push(cost);
    }
    if (providerUsageFacts.length === 1) [providerUsage] = providerUsageFacts;
    else if (providerUsageFacts.length > 1) providerUsage = providerUsageFacts;
  }

  const thinking = resolveThinkingLevel({
    sessionLevel: metrics.thinkingLevel,
    model: payload.model,
    sessionId: payload.sessionId,
    configPath: paths.configTomlPath,
    configText: snapshot.configTomlText,
    snapshotDir: paths.hudDir,
    deadline,
    clock,
  });
  metrics.thinkingLevel = thinking.level;
  // kimi-code lazy-starts: until the first turn's wire rows confirm the
  // effort, the level is only inferred from config.toml and renders muted.
  metrics.thinkingProvisional = thinking.confirmed === false;

  let gitDirty = false;
  const gitBudget = remainingMs(deadline, clock);
  if (payload.gitBranch && gitBudget >= GIT_MIN_REMAINING_MS) {
    const gitDirtyImpl = dependencies.isGitDirty || isGitDirty;
    gitDirty = gitDirtyImpl(payload.cwd, {
      timeoutMs: gitBudget - 2,
      cachePath: paths.gitStatusCachePath,
    });
  }
  const lines = renderHud({
    payload,
    quota,
    providerUsage,
    metrics,
    gitDirty,
    layout: layoutFromSnapshot(snapshot, env),
    permissionNames: permissionNamesFromSnapshot(snapshot, env),
    color: colorFromEnv(env),
    theme: resolveTheme({ env, tuiTomlText: snapshot.tuiTomlText }),
    now,
  });
  return { exitCode: 0, line: lines[0] };
}
