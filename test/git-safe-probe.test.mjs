import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readGitStatus } from '../src/git.mjs';

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-safe-git-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['init', '--quiet', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.org']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'first\n');
  git(['add', 'tracked.txt']);
  git(['commit', '--quiet', '-m', 'initial']);
  return { cwd, git };
}

test('safe probe detects clean, tracked, staged and untracked states', (t) => {
  const { cwd, git } = repository(t);
  assert.deepEqual(readGitStatus(cwd), { branch: 'main', dirty: false });

  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'second\n');
  assert.deepEqual(readGitStatus(cwd), { branch: 'main', dirty: true });
  git(['add', 'tracked.txt']);
  assert.deepEqual(readGitStatus(cwd), { branch: 'main', dirty: true });
  git(['commit', '--quiet', '-m', 'second']);
  assert.deepEqual(readGitStatus(cwd), { branch: 'main', dirty: false });

  fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'new\n');
  assert.deepEqual(readGitStatus(cwd), { branch: 'main', dirty: true });
});

for (const kind of ['clean', 'process']) {
  test(`safe probe never invokes repository ${kind} filter`, (t) => {
    if (process.platform === 'win32') {
      t.skip('the marker filter is a POSIX shell script');
      return;
    }
    const { cwd, git } = repository(t);
    const driver = path.join(cwd, 'driver.sh');
    const marker = `${driver}.marker`;
    fs.writeFileSync(driver, '#!/bin/sh\nprintf ran >> "$0.marker"\ncat\n');
    fs.chmodSync(driver, 0o755);
    fs.writeFileSync(path.join(cwd, '.gitattributes'), '*.txt filter=probe\n');
    git(['config', `filter.probe.${kind}`, driver]);
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'changed\n');

    assert.deepEqual(readGitStatus(cwd), { branch: 'main', dirty: true });
    assert.equal(fs.existsSync(marker), false);
  });
}
