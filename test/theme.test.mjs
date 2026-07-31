import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveTheme, themeFromColorFgBg, themeFromTuiToml } from '../src/theme.mjs';

function tmpToml(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-theme-'));
  const file = path.join(dir, 'tui.toml');
  fs.writeFileSync(file, content);
  return file;
}

test('themeFromColorFgBg reads the last token as background index', () => {
  assert.equal(themeFromColorFgBg('15;0'), 'dark');   // white on black
  assert.equal(themeFromColorFgBg('0;15'), 'light');  // black on bright white
  assert.equal(themeFromColorFgBg('0;7'), 'light');
  assert.equal(themeFromColorFgBg('15;8'), 'dark');   // bright black bg
  assert.equal(themeFromColorFgBg('7;default;0'), 'dark');
  assert.equal(themeFromColorFgBg(undefined), null);
  assert.equal(themeFromColorFgBg(''), null);
  assert.equal(themeFromColorFgBg('garbage'), null);
  assert.equal(themeFromColorFgBg('0;-1'), null);
});

test('themeFromTuiToml reads only the top-level theme key', () => {
  assert.equal(themeFromTuiToml('theme = "light"\n[editor]\n'), 'light');
  assert.equal(themeFromTuiToml('theme = "dark" # comment\n'), 'dark');
  assert.equal(themeFromTuiToml("theme = 'auto'\n"), 'auto');
  assert.equal(themeFromTuiToml('  theme   =   "light"\n'), 'light');
  // A theme key inside a section is not the setting.
  assert.equal(themeFromTuiToml('[editor]\ntheme = "light"\n'), null);
  assert.equal(themeFromTuiToml(''), null);
  assert.equal(themeFromTuiToml(null), null);
});

test('KIMI_HUD_THEME override beats tui.toml', () => {
  const tuiTomlPath = tmpToml('theme = "dark"\n');
  assert.equal(resolveTheme({ env: { KIMI_HUD_THEME: 'light' }, tuiTomlPath }), 'light');
  assert.equal(resolveTheme({ env: { KIMI_HUD_THEME: 'dark' }, tuiTomlPath }), 'dark');
  // An invalid override value is ignored, not treated as light/dark.
  assert.equal(resolveTheme({ env: { KIMI_HUD_THEME: 'blue' }, tuiTomlPath }), 'dark');
});

test('tui.toml explicit dark/light wins over COLORFGBG', () => {
  const tuiTomlPath = tmpToml('theme = "light"\n');
  assert.equal(resolveTheme({ env: { COLORFGBG: '15;0' }, tuiTomlPath }), 'light');
});

test('auto resolves via COLORFGBG and falls back to dark', () => {
  const autoToml = tmpToml('theme = "auto"\n');
  assert.equal(resolveTheme({ env: { COLORFGBG: '0;15' }, tuiTomlPath: autoToml }), 'light');
  assert.equal(resolveTheme({ env: { COLORFGBG: '15;0' }, tuiTomlPath: autoToml }), 'dark');
  assert.equal(resolveTheme({ env: {}, tuiTomlPath: autoToml }), 'dark');
});

test('missing file, missing key and custom theme names fall back to dark', () => {
  assert.equal(resolveTheme({ env: {}, tuiTomlPath: '/nonexistent/tui.toml' }), 'dark');
  assert.equal(resolveTheme({ env: {}, tuiTomlPath: tmpToml('[editor]\n') }), 'dark');
  assert.equal(resolveTheme({ env: {}, tuiTomlPath: tmpToml('theme = "gruvbox"\n') }), 'dark');
  // Missing key still honors COLORFGBG as the auto path.
  assert.equal(
    resolveTheme({ env: { COLORFGBG: '0;15' }, tuiTomlPath: tmpToml('[editor]\n') }),
    'light',
  );
});
