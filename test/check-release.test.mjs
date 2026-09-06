import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeReleaseMode } from '../scripts/check-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-release.mjs');

test('release mode message distinguishes tagged releases from candidates', () => {
  const tagged = describeReleaseMode('0.8.2', true);
  assert.match(tagged, /v0\.8\.2 exists/);
  assert.match(tagged, /tagged mode/);
  const candidate = describeReleaseMode('0.9.0', false);
  assert.match(candidate, /v0\.9\.0 not created yet/);
  assert.match(candidate, /candidate mode/);
  assert.match(candidate, /HEAD is validated as the release candidate/);
});

test('release gate enables strict metadata checks in candidate or tagged state', () => {
  // --metadata-only keeps this test out of the full-suite recursion path:
  // the spawned gate runs test/release-metadata.test.mjs only.
  const result = spawnSync(process.execPath, [SCRIPT, '--metadata-only'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /strict metadata \(KIMI_HUD_RELEASE_CHECK=1\)/);
  assert.match(result.stdout, /PASS strict metadata/);
  assert.doesNotMatch(result.stdout, /full test suite/);
  assert.equal(result.stderr.trim(), '');
});

test('release gate rejects unknown options without running any check', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /unknown option: --bogus/);
  assert.doesNotMatch(result.stderr, /FAIL/);
});
