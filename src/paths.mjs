import os from 'node:os';
import path from 'node:path';

const DEFAULT_HOME = os.homedir();

export const KIMI_HOME = path.join(DEFAULT_HOME, '.kimi-code');
export const HUD_DIR = path.join(DEFAULT_HOME, '.kimi-code-hud');
export const SESSIONS_ROOT = path.join(KIMI_HOME, 'sessions');
export const TUI_TOML_PATH = path.join(KIMI_HOME, 'tui.toml');
export const CONFIG_TOML_PATH = path.join(KIMI_HOME, 'config.toml');
export const CREDENTIALS_PATH = path.join(KIMI_HOME, 'credentials', 'kimi-code.json');
export const QUOTA_CACHE_PATH = path.join(HUD_DIR, 'quota.json');
export const REFRESH_LOCK_PATH = path.join(HUD_DIR, 'refresh.lock');

/** Resolve command-level path overrides once, then pass the snapshot down. */
export function resolveRuntimePaths({ env = process.env, home = DEFAULT_HOME } = {}) {
  const kimiHome = env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
  const hudDir = env.KIMI_HUD_HOME || path.join(home, '.kimi-code-hud');
  return {
    kimiHome,
    hudDir,
    sessionsRoot: path.join(kimiHome, 'sessions'),
    configPath: path.join(hudDir, 'config.json'),
    quotaCachePath: path.join(hudDir, 'quota.json'),
    quotaLockPath: path.join(hudDir, 'refresh.lock'),
    tuiTomlPath: env.KIMI_HUD_TUI_TOML || path.join(kimiHome, 'tui.toml'),
    configTomlPath: env.KIMI_HUD_CONFIG_TOML || path.join(kimiHome, 'config.toml'),
    credentialsPath: path.join(kimiHome, 'credentials', 'kimi-code.json'),
  };
}
