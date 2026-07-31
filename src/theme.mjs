// Theme resolution for the badge palette. Only the three truecolor slots
// (primary/accent/warning) follow the theme; the ANSI colors are remapped
// by the terminal itself and need no handling.
//
// Sources, in order:
// 1. KIMI_HUD_THEME=dark|light — explicit override (debugging, custom themes)
// 2. tui.toml top-level theme = "dark"|"light" — the host setting
// 3. "auto" / missing / unreadable: COLORFGBG, then dark.
//    The host's own auto resolution asks the terminal via OSC 11 first, but
//    a status-line command owns neither stdin (payload pipe) nor stdout
//    (status line) and is killed after 300ms — COLORFGBG is the only
//    synchronous signal, with the same dark fallback the host uses.
// A custom theme name can't be resolved here and falls back to dark.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Background ANSI 16-color indices that read as dark, same rule as the
// host's parseColorFgBg: 0-6 and 8 are dark, the rest light.
const DARK_BGS = new Set([0, 1, 2, 3, 4, 5, 6, 8]);

/**
 * COLORFGBG is "fg;bg" (sometimes "fg;default;bg"); the last token is the
 * background index. Returns 'dark' | 'light' | null (unknown/malformed).
 * @param {string|undefined} value
 * @returns {'dark'|'light'|null}
 */
export function themeFromColorFgBg(value) {
  if (!value) return null;
  const bg = Number.parseInt(value.split(';').at(-1), 10);
  if (!Number.isInteger(bg) || bg < 0) return null;
  return DARK_BGS.has(bg) ? 'dark' : 'light';
}

/**
 * Extract the top-level `theme = "..."` value from tui.toml content. Only
 * keys before the first [section] header count — the host keeps `theme` at
 * the top level, and a same-named key inside a section is not the setting.
 * @param {string} content
 * @returns {string|null}
 */
export function themeFromTuiToml(content) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*theme\s*=\s*["']([^"']*)["']/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Resolve the effective theme: 'dark' | 'light'.
 * @param {object} [opts]
 * @param {object} [opts.env] environment map (defaults to process.env)
 * @param {string} [opts.tuiTomlPath] defaults to ~/.kimi-code/tui.toml
 * @returns {'dark'|'light'}
 */
export function resolveTheme({
  env = process.env,
  tuiTomlPath = path.join(os.homedir(), '.kimi-code', 'tui.toml'),
} = {}) {
  const override = env.KIMI_HUD_THEME;
  if (override === 'dark' || override === 'light') return override;
  let setting = null;
  try {
    setting = themeFromTuiToml(fs.readFileSync(tuiTomlPath, 'utf8'));
  } catch {
    // missing/unreadable -> treat as auto
  }
  if (setting === 'dark' || setting === 'light') return setting;
  if (setting === null || setting === 'auto') {
    return themeFromColorFgBg(env.COLORFGBG) || 'dark';
  }
  return 'dark'; // custom theme name — palette unknown, keep historical look
}
