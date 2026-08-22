import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPORARY_RELEASE_STATE = /working(?:[ -]|\r?\n)+tree|pending(?:[ -]|\r?\n)+release/i;

function compatibilityMetadata(text, name) {
  const verified = text.match(/^- Last verified: (\d{4}-\d{2}-\d{2})$/m);
  const hud = text.match(/^- HUD behavior baseline: `v([^`]+)` \(`([0-9a-f]{7,40})`\)$/m);
  const kimi = text.match(/^- Kimi Code baseline: `([^`]+)` \(`([0-9a-f]{40})`\)$/m);
  assert.ok(verified, `${name} is missing the Last verified line`);
  assert.ok(hud, `${name} is missing the released HUD behavior baseline line`);
  assert.ok(kimi, `${name} is missing the pinned Kimi Code baseline line`);
  return {
    verified: verified[1],
    hudVersion: hud[1],
    hudCommit: hud[2],
    kimiVersion: kimi[1],
    kimiCommit: kimi[2],
  };
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertReleasedHudCommit(version, commit) {
  const tag = `v${version}`;
  let targetCommit;
  try {
    targetCommit = git(['rev-parse', '--verify', `${tag}^{commit}`]);
  } catch {
    // During the version-bump commit the new tag does not exist yet. HEAD is the
    // release candidate; the post-tag rerun below resolves the exact tag.
    targetCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  }
  try {
    const behaviorCommit = git(['rev-parse', '--verify', `${commit}^{commit}`]);
    execFileSync('git', ['merge-base', '--is-ancestor', behaviorCommit, targetCommit], {
      cwd: ROOT,
      stdio: 'ignore',
    });
  } catch {
    assert.fail(`HUD behavior commit ${commit} must belong to release ${tag} or its pre-tag HEAD`);
  }
}

function assertNoTemporaryReleaseState(capabilities, knownIssues) {
  const metadataHeader = `${capabilities.split('\n').slice(0, 12).join('\n')}\n${knownIssues.split('\n').slice(0, 12).join('\n')}`;
  assert.doesNotMatch(metadataHeader, TEMPORARY_RELEASE_STATE);
  const issueBlocks = knownIssues
    .split(/(?=^## KI-\d+:)/m)
    .filter((section) => /^## KI-\d+:/m.test(section));
  for (const block of issueBlocks.filter((section) => /^Status: closed\b/im.test(section))) {
    assert.doesNotMatch(block, TEMPORARY_RELEASE_STATE);
  }
}

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

test('compatibility inventories stay aligned with the current HUD release', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const capabilities = fs.readFileSync(path.join(ROOT, 'CAPABILITIES.md'), 'utf8');
  const knownIssues = fs.readFileSync(path.join(ROOT, 'KNOWN_ISSUES.md'), 'utf8');
  const cap = compatibilityMetadata(capabilities, 'CAPABILITIES.md');
  const known = compatibilityMetadata(knownIssues, 'KNOWN_ISSUES.md');
  assert.deepEqual(known, cap, 'CAPABILITIES.md and KNOWN_ISSUES.md metadata must match');
  assert.equal(cap.hudVersion, pkg.version, 'HUD behavior baseline must match package.json');
  assertReleasedHudCommit(cap.hudVersion, cap.hudCommit);

  if (process.env.KIMI_HUD_RELEASE_CHECK === '1') {
    assertNoTemporaryReleaseState(capabilities, knownIssues);
  }
});

test('strict metadata rejects hyphenated and multiline temporary release states', () => {
  const cleanHeader = '# HUD capabilities\n\n- Last verified: 2026-08-22\n';
  assert.throws(
    () => assertNoTemporaryReleaseState(`${cleanHeader}- HUD behavior baseline: working-tree\n`, ''),
    /working-tree/i,
  );
  assert.throws(
    () => assertNoTemporaryReleaseState(cleanHeader, [
      '## KI-99: example',
      '',
      'Status: closed (implemented in the working',
      'tree, pending-',
      'release)',
      '',
      'Resolution:',
      '',
      'Example only.',
    ].join('\n')),
    /working[\s\S]*tree|pending[\s\S]*release/i,
  );
});

test('released metadata rejects a HUD behavior commit after its tag', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const tag = `v${pkg.version}`;
  let descendant;
  try {
    descendant = git(['rev-list', '--max-count=1', `${tag}..HEAD`]);
  } catch {
    t.skip(`${tag} does not exist yet`);
    return;
  }
  if (!descendant) {
    t.skip(`HEAD has no commits after ${tag}`);
    return;
  }
  assert.throws(
    () => assertReleasedHudCommit(pkg.version, descendant),
    /must belong to release/,
  );
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
