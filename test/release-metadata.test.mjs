import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package and plugin manifest versions stay aligned', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'kimi.plugin.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version);
});

test('changelog links start from the current package version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## \[Unreleased\]$/m);
  assert.ok(changelog.includes(`[Unreleased]: https://github.com/FinbackYu/kimi-code-hud/compare/v${pkg.version}...HEAD`));
  assert.ok(changelog.includes(`[${pkg.version}]: https://github.com/FinbackYu/kimi-code-hud/releases/tag/v${pkg.version}`));
});

test('showcase pages embed the current plugin and CLI baseline versions', (t) => {
  const pages = [
    path.join(ROOT, 'docs/showcase/states-gallery.html'),
    path.join(ROOT, 'docs/showcase/startup-page.html'),
  ];
  if (pages.some((page) => !fs.existsSync(page))) {
    t.skip('showcase pages are gitignored and absent on CI');
    return;
  }
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'kimi.plugin.json'), 'utf8'));
  const capabilities = fs.readFileSync(path.join(ROOT, 'CAPABILITIES.md'), 'utf8');
  const baseline = capabilities.match(/^- Kimi Code baseline: `([^`]+)`/m);
  assert.ok(baseline, 'CAPABILITIES.md is missing the Kimi Code baseline line');
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    const name = path.basename(page);
    const hud = html.match(/const HUD_VERSION = ['"]([^'"]+)['"]/);
    assert.ok(hud, `${name} is missing the HUD_VERSION constant`);
    assert.equal(hud[1], plugin.version, `${name} HUD_VERSION must match kimi.plugin.json`);
    const cli = html.match(/const CLI_VERSION = ['"]([^'"]+)['"]/);
    assert.ok(cli, `${name} is missing the CLI_VERSION constant`);
    assert.equal(cli[1], baseline[1], `${name} CLI_VERSION must match the CAPABILITIES.md Kimi Code baseline`);
  }
});
