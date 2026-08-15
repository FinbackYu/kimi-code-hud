import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isGitDirty, resolveCommandPath } from '../src/git.mjs';

function commandName() {
  return process.platform === 'win32' ? 'git.EXE' : 'git';
}

function makeExecutable(dir, name = commandName()) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, 'test executable');
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o755);
  return filePath;
}

test('Windows resolution honors PATHEXT and refuses a planted git.exe', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-win-workspace-'));
  const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-win-bin-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(trusted, { recursive: true, force: true }));
  const trustedGit = makeExecutable(trusted, 'git.EXE');
  const trustedEnv = { PATH: trusted, PATHEXT: '.EXE' };
  assert.equal(
    resolveCommandPath('git', cwd, { env: trustedEnv, platform: 'win32' }),
    fs.realpathSync(trustedGit),
  );

  makeExecutable(cwd, 'git.EXE');
  const plantedEnv = {
    PATH: `${cwd};${trusted}`,
    PATHEXT: '.EXE',
  };
  assert.equal(
    resolveCommandPath('git', cwd, { env: plantedEnv, platform: 'win32' }),
    undefined,
  );
});

test('command resolution returns an absolute trusted PATH executable', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-workspace-'));
  const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-bin-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(trusted, { recursive: true, force: true }));
  const executable = makeExecutable(trusted);
  const env = {
    PATH: trusted,
    PATHEXT: '.EXE',
  };

  assert.equal(
    resolveCommandPath('git', cwd, { env, platform: process.platform }),
    fs.realpathSync(executable),
  );
});

test('command resolution refuses a workspace-local executable before trust', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-workspace-'));
  const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-bin-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(trusted, { recursive: true, force: true }));
  makeExecutable(cwd);
  makeExecutable(trusted);
  const env = {
    PATH: [cwd, trusted].join(path.delimiter),
    PATHEXT: '.EXE',
  };

  assert.equal(
    resolveCommandPath('git', cwd, { env, platform: process.platform }),
    undefined,
  );
  assert.equal(isGitDirty(cwd, { env, platform: process.platform }), false);
});

test('git dirty detection executes the resolved absolute binary', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-git-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = resolveCommandPath('git', cwd);
  if (!git) {
    t.skip('git is unavailable on trusted PATH');
    return;
  }
  execFileSync(git, ['init', '--quiet'], { cwd, stdio: 'ignore' });
  fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'dirty');

  assert.equal(isGitDirty(cwd), true);
});
