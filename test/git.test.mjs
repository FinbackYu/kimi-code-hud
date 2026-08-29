import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGitStatusReader,
  isGitDirty,
  resolveCommandPath,
} from '../src/git.mjs';

function commandName() {
  return process.platform === 'win32' ? 'git.EXE' : 'git';
}

function makeExecutable(dir, name = commandName()) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, 'test executable');
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o755);
  return filePath;
}

function statusFixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-status-'));
  const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-bin-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-state-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(trusted, { recursive: true, force: true }));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  makeExecutable(trusted);
  return {
    cwd,
    env: { PATH: trusted },
    cachePath: path.join(state, 'git-status-cache.json'),
    ...options,
  };
}

function waitForFiles(filePaths, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (filePaths.every((filePath) => fs.existsSync(filePath))) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${filePaths.join(', ')}`));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

function childResult(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
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

test('independent readers share branch and dirty results through the disk cache', (t) => {
  let now = 1_000;
  let calls = 0;
  let childOptions;
  let secondWrites = 0;
  const { cwd, env, cachePath } = statusFixture(t);
  env.git_optional_locks = '1';
  const firstReader = createGitStatusReader({
    now: () => now,
    execFileSyncImpl: (git, args, options) => {
      calls += 1;
      childOptions = options;
      assert.equal(path.isAbsolute(git), true);
      assert.deepEqual(args, ['status', '--porcelain=v1', '--branch']);
      return Buffer.from('## main...origin/main [ahead 1]\n M tracked.txt\n');
    },
  });

  assert.deepEqual(
    firstReader(cwd, { env, cachePath, timeoutMs: 1_000 }),
    { branch: 'main', dirty: true },
  );
  const rawCache = fs.readFileSync(cachePath, 'utf8');
  const parsedCache = JSON.parse(rawCache);
  const [key] = Object.keys(parsedCache.entries);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(rawCache, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(Object.keys(parsedCache.entries[key]).sort(), ['branch', 'checkedAt', 'dirty']);
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);

  now += 14_999;
  const secondReader = createGitStatusReader({
    now: () => now,
    execFileSyncImpl: () => {
      calls += 1;
      return Buffer.from('## wrong\n');
    },
    atomicWriteFileImpl: () => { secondWrites += 1; },
  });
  assert.deepEqual(
    secondReader(cwd, { env, cachePath }),
    { branch: 'main', dirty: true },
  );
  assert.equal(calls, 1);
  assert.equal(secondWrites, 0);
  assert.equal(childOptions.timeout, 150);
  assert.equal(childOptions.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal('git_optional_locks' in childOptions.env, false);
  assert.equal(env.git_optional_locks, '1');
});

test('two real processes merge barrier-synchronized cold misses', async (t) => {
  const fixture = statusFixture(t);
  const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-status-second-'));
  const readyFirst = path.join(path.dirname(fixture.cachePath), 'ready-first');
  const readySecond = path.join(path.dirname(fixture.cachePath), 'ready-second');
  const release = path.join(path.dirname(fixture.cachePath), 'release');
  t.after(() => fs.rmSync(secondCwd, { recursive: true, force: true }));

  const moduleUrl = new URL('../src/git.mjs', import.meta.url).href;
  const worker = `
import fs from 'node:fs';
import { createGitStatusReader } from ${JSON.stringify(moduleUrl)};
const [cwd, cachePath, trusted, readyPath, releasePath, branch, logPath] = process.argv.slice(1);
const reader = createGitStatusReader({
  now: () => 1_000,
  execFileSyncImpl: () => {
    fs.writeFileSync(readyPath, 'ready');
    const view = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(releasePath) && Date.now() < deadline) {
      Atomics.wait(view, 0, 0, 5);
    }
    if (!fs.existsSync(releasePath)) throw new Error('barrier timed out');
    return Buffer.from('## ' + branch + '\\n');
  },
});
const result = reader(cwd, {
  cachePath,
  env: { PATH: trusted },
});
// The loser of the post-barrier lock race may skip its cache write by
// design: lockWaitMs is capped at 20ms so the hot path never blocks, and a
// timeout fails open. On a slow runner that designed skip flakes the merge
// assertion below, so retry until this worker's branch lands in the cache
// (a successful first write makes the loop a no-op). The log file keeps
// enough evidence to diagnose any residual CI flake.
const pause = new Int32Array(new SharedArrayBuffer(4));
const hasOwnBranch = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return Object.values(parsed.entries || {}).some(
      (entry) => entry && entry.branch === branch,
    );
  } catch {
    return false; // Cache file briefly absent or renamed mid-write by the peer.
  }
};
let retries = 0;
while (!hasOwnBranch() && retries < 40) {
  Atomics.wait(pause, 0, 0, 50);
  reader(cwd, { cachePath, env: { PATH: trusted } });
  retries += 1;
}
try {
  fs.writeFileSync(logPath, JSON.stringify({ retries, landed: hasOwnBranch() }));
} catch { /* diagnostics are best effort */ }
process.stdout.write(JSON.stringify(result));
`;
  const spawnWorker = (cwd, readyPath, branch, logPath) => spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    worker,
    cwd,
    fixture.cachePath,
    fixture.env.PATH,
    readyPath,
    release,
    branch,
    logPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cacheDir = path.dirname(fixture.cachePath);
  const logFirst = path.join(cacheDir, 'merge-first.log');
  const logSecond = path.join(cacheDir, 'merge-second.log');
  const firstChild = spawnWorker(fixture.cwd, readyFirst, 'first', logFirst);
  const secondChild = spawnWorker(secondCwd, readySecond, 'second', logSecond);
  t.after(() => {
    if (!firstChild.killed) firstChild.kill();
    if (!secondChild.killed) secondChild.kill();
  });
  const firstResult = childResult(firstChild);
  const secondResult = childResult(secondChild);

  await waitForFiles([readyFirst, readySecond]);
  fs.writeFileSync(release, 'go');
  assert.deepEqual(await firstResult, { branch: 'first', dirty: false });
  assert.deepEqual(await secondResult, { branch: 'second', dirty: false });

  const rawCache = fs.readFileSync(fixture.cachePath, 'utf8');
  const cache = JSON.parse(rawCache);
  const readLog = (logPath) => {
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '<missing>';
    }
  };
  assert.equal(
    Object.keys(cache.entries).length,
    2,
    `cache=${rawCache} first=${readLog(logFirst)} second=${readLog(logSecond)}`,
  );
  assert.doesNotMatch(rawCache, new RegExp(fixture.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(rawCache, new RegExp(secondCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a new reader refreshes the disk cache at TTL expiry without waiting', (t) => {
  let now = 10_000;
  let calls = 0;
  const { cwd, env, cachePath } = statusFixture(t);
  const firstReader = createGitStatusReader({
    now: () => now,
    ttlMs: 15_000,
    execFileSyncImpl: () => {
      calls += 1;
      return Buffer.from('## main\n?? first.txt\n');
    },
  });

  assert.deepEqual(
    firstReader(cwd, { env, cachePath }),
    { branch: 'main', dirty: true },
  );
  now += 15_000;
  const secondReader = createGitStatusReader({
    now: () => now,
    ttlMs: 15_000,
    execFileSyncImpl: () => {
      calls += 1;
      return Buffer.from('## release\n');
    },
  });
  assert.deepEqual(
    secondReader(cwd, { env, cachePath }),
    { branch: 'release', dirty: false },
  );
  assert.equal(calls, 2);
});

test('disk cache isolates working directories across reader instances', (t) => {
  const first = statusFixture(t);
  const second = statusFixture(t);
  let calls = 0;
  const firstReader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: (_git, _args, options) => {
      calls += 1;
      return Buffer.from(options.cwd === first.cwd ? '## first\n' : '## second\n?? file\n');
    },
  });

  assert.deepEqual(
    firstReader(first.cwd, { env: first.env, cachePath: first.cachePath }),
    { branch: 'first', dirty: false },
  );
  assert.deepEqual(
    firstReader(second.cwd, { env: second.env, cachePath: first.cachePath }),
    { branch: 'second', dirty: true },
  );
  const secondReader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => {
      calls += 1;
      throw new Error('disk cache miss');
    },
  });
  assert.deepEqual(
    secondReader(first.cwd, { env: first.env, cachePath: first.cachePath }),
    { branch: 'first', dirty: false },
  );
  assert.deepEqual(
    secondReader(second.cwd, { env: second.env, cachePath: first.cachePath }),
    { branch: 'second', dirty: true },
  );
  assert.equal(calls, 2);
});

test('disk cache evicts the oldest cwd at the hard 64-entry limit', (t) => {
  const fixture = statusFixture(t);
  const workspaces = Array.from(
    { length: 65 },
    (_, index) => path.join(fixture.cwd, `repo-${index}`),
  );
  let now = 0;
  const writer = createGitStatusReader({
    now: () => ++now,
    execFileSyncImpl: (_git, _args, options) => Buffer.from(
      `## ${path.basename(options.cwd)}\n`,
    ),
  });
  for (const cwd of workspaces) {
    writer(cwd, { env: fixture.env, cachePath: fixture.cachePath });
  }

  const cache = JSON.parse(fs.readFileSync(fixture.cachePath, 'utf8'));
  assert.equal(Object.keys(cache.entries).length, 64);

  let misses = 0;
  const verifier = createGitStatusReader({
    now: () => now,
    execFileSyncImpl: () => {
      misses += 1;
      return Buffer.from('## refreshed\n');
    },
  });
  assert.deepEqual(
    verifier(workspaces[0], { env: fixture.env, cachePath: fixture.cachePath }),
    { branch: 'refreshed', dirty: false },
  );
  assert.deepEqual(
    verifier(workspaces.at(-1), { env: fixture.env, cachePath: fixture.cachePath }),
    { branch: 'repo-64', dirty: false },
  );
  assert.equal(misses, 1);
});

test('failed probes degrade silently and are cached across readers', (t) => {
  let firstCalls = 0;
  let secondCalls = 0;
  const { cwd, env, cachePath } = statusFixture(t);
  const firstReader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => {
      firstCalls += 1;
      throw new Error('timed out');
    },
  });

  assert.deepEqual(
    firstReader(cwd, { env, cachePath }),
    { branch: null, dirty: false },
  );
  const secondReader = createGitStatusReader({
    now: () => 2,
    execFileSyncImpl: () => {
      secondCalls += 1;
      return Buffer.from('## wrong\n?? dirty\n');
    },
  });
  assert.deepEqual(
    secondReader(cwd, { env, cachePath }),
    { branch: null, dirty: false },
  );
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
});

test('a corrupt disk cache triggers a fresh probe and atomic repair', (t) => {
  const { cwd, env, cachePath } = statusFixture(t);
  fs.writeFileSync(cachePath, '{broken');
  let calls = 0;
  const reader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => {
      calls += 1;
      return Buffer.from('## repaired\n?? file\n');
    },
  });

  assert.deepEqual(
    reader(cwd, { env, cachePath }),
    { branch: 'repaired', dirty: true },
  );
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).version, 1);
});

test('cache write failures never replace the current probe result', (t) => {
  const { cwd, env, cachePath } = statusFixture(t);
  let calls = 0;
  const reader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => {
      calls += 1;
      return Buffer.from('## live\n?? file\n');
    },
    atomicWriteFileImpl: () => { throw new Error('read-only state dir'); },
  });

  assert.deepEqual(
    reader(cwd, { env, cachePath }),
    { branch: 'live', dirty: true },
  );
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(cachePath), false);

  const nextReader = createGitStatusReader({
    now: () => 2,
    execFileSyncImpl: () => {
      calls += 1;
      return Buffer.from('## next\n');
    },
  });
  assert.deepEqual(
    nextReader(cwd, { env, cachePath }),
    { branch: 'next', dirty: false },
  );
  assert.equal(calls, 2);
});

test('cache lock waiting stops at the injected monotonic deadline', (t) => {
  const { cwd, env, cachePath } = statusFixture(t);
  const lockPath = `${cachePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 1,
    at: Date.now(),
    token: 'live-owner',
  }));
  let monotonicNow = 0;
  const sleeps = [];
  const reader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => Buffer.from('## live\n?? file\n'),
    monotonicClock: () => monotonicNow,
    sleep: (ms) => {
      sleeps.push(ms);
      monotonicNow += ms;
    },
  });

  assert.deepEqual(
    reader(cwd, { env, cachePath }),
    { branch: 'live', dirty: true },
  );
  assert.equal(monotonicNow, 20);
  assert.equal(sleeps.reduce((total, ms) => total + ms, 0), 20);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 2));
  assert.equal(fs.existsSync(cachePath), false);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'live-owner');
});

test('real cache lock contention remains within a reasonable wall-clock bound', (t) => {
  const { cwd, env, cachePath } = statusFixture(t);
  const lockPath = `${cachePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 1,
    at: Date.now(),
    token: 'live-owner',
  }));
  const reader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => Buffer.from('## live\n'),
  });
  const started = performance.now();

  assert.deepEqual(
    reader(cwd, { env, cachePath }),
    { branch: 'live', dirty: false },
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 100, `lock contention took ${elapsed.toFixed(1)}ms`);
});

test('a stale cache lock is collected before the merged write', (t) => {
  const { cwd, env, cachePath } = statusFixture(t);
  const lockPath = `${cachePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 1,
    at: Date.now() - 6_000,
    token: 'stale-owner',
  }));
  const reader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => Buffer.from('## recovered\n'),
  });

  assert.deepEqual(
    reader(cwd, { env, cachePath }),
    { branch: 'recovered', dirty: false },
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).version, 1);
});

test('every successful cache write tightens an existing 0644 file to 0600', (t) => {
  const { cwd, env, cachePath } = statusFixture(t);
  fs.writeFileSync(cachePath, JSON.stringify({ version: 1, entries: {} }), { mode: 0o644 });
  fs.chmodSync(cachePath, 0o644);
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o644);
  const reader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => Buffer.from('## secured\n'),
  });

  assert.deepEqual(
    reader(cwd, { env, cachePath }),
    { branch: 'secured', dirty: false },
  );
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
});

test('a directory at cachePath is not chmodded or replaced', (t) => {
  const { cwd, env, cachePath } = statusFixture(t);
  fs.mkdirSync(cachePath);
  fs.chmodSync(cachePath, 0o755);
  const reader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => Buffer.from('## live\n?? file\n'),
  });

  assert.deepEqual(
    reader(cwd, { env, cachePath }),
    { branch: 'live', dirty: true },
  );
  const stat = fs.lstatSync(cachePath);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.mode & 0o777, 0o755);
});

test('a symlink cachePath is atomically replaced without touching its target', (t) => {
  const { cwd, env, cachePath } = statusFixture(t);
  const targetPath = path.join(path.dirname(cachePath), 'symlink-target');
  fs.writeFileSync(targetPath, 'target-content');
  fs.chmodSync(targetPath, 0o644);
  try {
    fs.symlinkSync(targetPath, cachePath);
  } catch (err) {
    t.skip(`symlinks unavailable: ${err.message}`);
    return;
  }
  const reader = createGitStatusReader({
    now: () => 1,
    execFileSyncImpl: () => Buffer.from('## secured\n'),
  });

  assert.deepEqual(
    reader(cwd, { env, cachePath }),
    { branch: 'secured', dirty: false },
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'target-content');
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o644);
  const cacheStat = fs.lstatSync(cachePath);
  assert.equal(cacheStat.isSymbolicLink(), false);
  assert.equal(cacheStat.isFile(), true);
  assert.equal(cacheStat.mode & 0o777, 0o600);
});
