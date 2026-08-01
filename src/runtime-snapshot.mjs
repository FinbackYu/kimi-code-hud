import fs from 'node:fs';

import { readQuotaCache } from './quota.mjs';

function canRead(deadline, clock) {
  return !Number.isFinite(deadline) || clock() < deadline;
}

function readText(filePath, deadline, clock) {
  if (!canRead(deadline, clock)) return null;
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function parseHudConfig(text) {
  if (typeof text !== 'string') return {};
  try {
    const config = JSON.parse(text);
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

/** Read each render-time config/cache source at most once for this frame. */
export function captureRuntimeSnapshot({
  paths,
  deadline = Infinity,
  clock = Date.now,
} = {}) {
  const hudConfigText = readText(paths.configPath, deadline, clock);
  const configTomlText = readText(paths.configTomlPath, deadline, clock);
  const tuiTomlText = readText(paths.tuiTomlPath, deadline, clock);
  const quota = canRead(deadline, clock) ? readQuotaCache(paths.quotaCachePath) : null;
  return {
    hudConfig: parseHudConfig(hudConfigText),
    configTomlText: configTomlText ?? '',
    tuiTomlText: tuiTomlText ?? '',
    quota,
  };
}

export function layoutFromSnapshot(snapshot, env = process.env) {
  const override = env.KIMI_HUD_LAYOUT;
  if (override === 'compact' || override === 'normal') return override;
  const layout = snapshot?.hudConfig?.layout;
  return layout === 'compact' || layout === 'normal'
    ? layout
    : 'normal';
}

export function colorFromEnv(env = process.env) {
  return !env.KIMI_HUD_NO_COLOR && !env.NO_COLOR;
}
