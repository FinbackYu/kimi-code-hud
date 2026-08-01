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
