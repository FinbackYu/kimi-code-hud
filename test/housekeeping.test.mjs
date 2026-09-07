import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HOUSEKEEPING_MAX_UNLINKS,
  SCRUB_CURSOR_NAME,
  SCRUB_MAX_FILES,
  SESSION_FILE_TTL_MS,
  TMP_FILE_MAX_AGE_MS,
  runHousekeeping,
  scrubLegacySessionCaches,
} from '../src/housekeeping.mjs';
import { emptyState } from '../src/metrics-state.mjs';

// Daily housekeeping: orphaned atomic-write and lock temporaries are swept,
// session state past the retention window is pruned, and the whole sweep is
// throttled to once per interval by a stamp file. The explicit cleanup entry
// rewrites recognized legacy session caches to the content-free shape on
// demand, without waiting for a session to reopen or the retention window.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kimi-hud.mjs');

function legacyCache(offset) {
  return JSON.stringify({
    v: 8,
    agents: { main: { offset, pendingBase64: Buffer.from('body copy').toString('base64') } },
  });
}

function makeHudHome() {
  const hudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-hk-'));
  const sessionStateDir = path.join(hudDir, 'sessions');
  fs.mkdirSync(sessionStateDir, { recursive: true });
  return { hudDir, sessionStateDir };
}

function backdate(filePath, ageMs, now) {
  const stale = new Date(now - ageMs);
  fs.utimesSync(filePath, stale, stale);
}

function write(filePath, content = '') {
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('sweeps orphaned temporaries but leaves fresh ones and other files', () => {
  const now = Date.now();
  const { hudDir, sessionStateDir } = makeHudHome();
  const staleRootTmp = write(path.join(hudDir, 'refresh.lock.tmp-1-2-abc'));
  const staleStateTmp = write(path.join(sessionStateDir, 'metrics-s1.json.tmp-9-0'));
  const freshTmp = write(path.join(sessionStateDir, 'thinking-s2.json.tmp-9-0'));
  const config = write(path.join(hudDir, 'config.json'), '{}');
  backdate(staleRootTmp, TMP_FILE_MAX_AGE_MS + HOUR, now);
  backdate(staleStateTmp, TMP_FILE_MAX_AGE_MS + HOUR, now);
  backdate(freshTmp, 1000, now);

  assert.equal(runHousekeeping({ hudDir, sessionStateDir, now }), true);

  assert.ok(!fs.existsSync(staleRootTmp));
  assert.ok(!fs.existsSync(staleStateTmp));
  assert.ok(fs.existsSync(freshTmp), 'a just-written temporary may belong to a live writer');
  assert.ok(fs.existsSync(config));
});

test('prunes expired session state in both directories, keeping everything else', () => {
  const now = Date.now();
  const { hudDir, sessionStateDir } = makeHudHome();
  const expiredRootState = write(path.join(hudDir, 'metrics-session_old.json'), '{"v":8}');
  const expiredSnapshot = write(path.join(sessionStateDir, 'thinking-session_old.json'), '{}');
  const liveState = write(path.join(sessionStateDir, 'metrics-session_new.json'), '{"v":8}');
  const quota = write(path.join(hudDir, 'quota.json'), '{}');
  const stamp = write(path.join(sessionStateDir, '.housekeeping-stamp'), '{"at":1}');
  backdate(expiredRootState, SESSION_FILE_TTL_MS + DAY, now);
  backdate(expiredSnapshot, SESSION_FILE_TTL_MS + DAY, now);
  backdate(stamp, SESSION_FILE_TTL_MS + DAY, now);
  backdate(liveState, SESSION_FILE_TTL_MS - DAY, now);

  assert.equal(runHousekeeping({ hudDir, sessionStateDir, now }), true);

  assert.ok(!fs.existsSync(expiredRootState), 'legacy root copies age out too');
  assert.ok(!fs.existsSync(expiredSnapshot));
  assert.ok(fs.existsSync(liveState));
  assert.ok(fs.existsSync(quota));
  assert.ok(fs.existsSync(stamp), 'the stamp never matches the session-file globs');
});

test('throttles repeats to once per interval and still cleans on the next day', () => {
  const now = Date.now();
  const { hudDir, sessionStateDir } = makeHudHome();
  assert.equal(runHousekeeping({ hudDir, sessionStateDir, now }), true);

  const laterTmp = write(path.join(hudDir, 'git-status-cache.json.lock.tmp-2-3-abc-0'));
  assert.equal(
    runHousekeeping({ hudDir, sessionStateDir, now: now + HOUR }),
    false,
    'a fresh stamp must skip the sweep',
  );
  assert.ok(fs.existsSync(laterTmp));

  assert.equal(runHousekeeping({ hudDir, sessionStateDir, now: now + DAY + HOUR }), true);
  assert.ok(!fs.existsSync(laterTmp));
});

test('caps the number of deletions per run', () => {
  const now = Date.now();
  const { hudDir, sessionStateDir } = makeHudHome();
  const stale = [];
  for (let i = 0; i < HOUSEKEEPING_MAX_UNLINKS + 10; i++) {
    stale.push(write(path.join(hudDir, `metrics-session_${i}.json`), '{"v":8}'));
    backdate(stale[i], SESSION_FILE_TTL_MS + DAY, now);
  }

  assert.equal(runHousekeeping({ hudDir, sessionStateDir, now, maxUnlinks: 5 }), true);

  const removed = stale.filter((p) => !fs.existsSync(p)).length;
  assert.equal(removed, 5);
});

test('tolerates missing directories and creates the sessions dir for the stamp', () => {
  const hudDir = path.join(os.tmpdir(), `kimi-hud-hk-missing-${Date.now()}-${process.pid}`);
  const sessionStateDir = path.join(hudDir, 'sessions');
  assert.equal(runHousekeeping({ hudDir, sessionStateDir }), true);
  assert.ok(fs.existsSync(path.join(sessionStateDir, '.housekeeping-stamp')));
});

test('the cleanup entry migrates legacy caches and leaves every other shape alone', () => {
  const { hudDir, sessionStateDir } = makeHudHome();
  const legacy = write(path.join(sessionStateDir, 'metrics-legacy.json'), legacyCache(7));
  const current = write(
    path.join(sessionStateDir, 'metrics-current.json'),
    JSON.stringify(emptyState()),
  );
  const foreign = write(
    path.join(sessionStateDir, 'metrics-newer.json'),
    JSON.stringify({ v: 10, agents: {}, note: 'a future HUD version owns this' }),
  );
  const corruptContent = write(
    path.join(hudDir, 'metrics-corrupt.json'),
    '{"v":8,"agents":{"main":{"pendingBase64":"Ym9keSBjb3B5"',
  );
  const corruptPlain = write(path.join(hudDir, 'metrics-plain.json'), 'not json at all');
  const nonCache = write(path.join(hudDir, 'quota.json'), legacyCache(1));
  const before = {
    current: fs.readFileSync(current, 'utf8'),
    foreign: fs.readFileSync(foreign, 'utf8'),
    corruptPlain: fs.readFileSync(corruptPlain, 'utf8'),
    nonCache: fs.readFileSync(nonCache, 'utf8'),
  };

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 5, cleaned: 1, removed: 1 },
  );

  const migrated = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  assert.equal(migrated.v, 9);
  assert.equal(migrated.agents.main.offset, 7, 'the cursor survives the rewrite');
  assert.equal(fs.readFileSync(legacy, 'utf8').includes('pendingBase64'), false);
  assert.equal(fs.readFileSync(current, 'utf8'), before.current, 'a current cache is not rewritten');
  assert.equal(fs.readFileSync(foreign, 'utf8'), before.foreign, 'a newer version\'s cache is not destroyed');
  assert.ok(!fs.existsSync(corruptContent), 'an unparseable legacy content cache is removed');
  assert.equal(fs.readFileSync(corruptPlain, 'utf8'), before.corruptPlain, 'corrupt non-content files wait for the TTL');
  assert.equal(fs.readFileSync(nonCache, 'utf8'), before.nonCache, 'only session cache names are touched');
});

test('the cleanup pass is bounded by maxFiles', () => {
  const { hudDir, sessionStateDir } = makeHudHome();
  const caches = [];
  for (let i = 0; i < 5; i++) {
    caches.push(write(path.join(sessionStateDir, `metrics-s${i}.json`), legacyCache(i)));
  }

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir, maxFiles: 2 }),
    { scanned: 2, cleaned: 2, removed: 0 },
  );
  const migrated = caches.filter(
    (filePath) => !fs.readFileSync(filePath, 'utf8').includes('pendingBase64'),
  );
  assert.equal(migrated.length, 2, 'the rest wait for the next pass');
});

test('the cleanup entry tolerates missing directories', () => {
  const hudDir = path.join(os.tmpdir(), `kimi-hud-hk-scrub-missing-${Date.now()}-${process.pid}`);
  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir: path.join(hudDir, 'sessions') }),
    { scanned: 0, cleaned: 0, removed: 0 },
  );
});

test('repeated bounded passes drive 201 legacy caches to zero instead of stalling at one', () => {
  const { hudDir, sessionStateDir } = makeHudHome();
  const caches = [];
  for (let i = 0; i < 201; i++) {
    caches.push(
      write(path.join(sessionStateDir, `metrics-old${String(i).padStart(3, '0')}.json`), legacyCache(i)),
    );
  }
  const legacyLeft = () =>
    caches.filter((p) => fs.readFileSync(p, 'utf8').includes('pendingBase64')).length;

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 200, cleaned: 200, removed: 0 },
    'the first pass spends the full budget on legacy caches',
  );
  assert.equal(legacyLeft(), 1, 'the per-run cap leaves exactly one behind');

  const second = scrubLegacySessionCaches({ hudDir, sessionStateDir });
  assert.equal(second.cleaned, 1, 'the next run reaches the file the first pass left');
  assert.equal(second.scanned, 1, 'migrated caches are not re-counted as workload');
  assert.equal(legacyLeft(), 0);

  const third = scrubLegacySessionCaches({ hudDir, sessionStateDir });
  assert.equal(third.cleaned + third.removed, 0, 'nothing is left to do');
  assert.ok(third.scanned <= SCRUB_MAX_FILES, 'the repeat stays bounded');
  assert.equal(legacyLeft(), 0);
});

test('a capped pass keeps a cursor and the next pass resumes after it, not from the start', () => {
  const { hudDir, sessionStateDir } = makeHudHome();
  const caches = [];
  for (let i = 0; i < 5; i++) {
    caches.push(write(path.join(sessionStateDir, `metrics-s${i}.json`), legacyCache(i)));
  }
  const cursorPath = path.join(hudDir, SCRUB_CURSOR_NAME);

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir, maxFiles: 2 }),
    { scanned: 2, cleaned: 2, removed: 0 },
  );
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  assert.match(cursor.anchors.sessions, /^metrics-s[01]\.json$/, 'the cursor stores a bare file name');
  assert.equal(cursor.anchors.sessions.includes('/'), false, 'the cursor never stores paths');
  assert.equal(fs.readFileSync(cursorPath, 'utf8').includes('pendingBase64'), false, 'the cursor never stores cache content');

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir, maxFiles: 2 }),
    { scanned: 2, cleaned: 2, removed: 0 },
    'the resumed pass continues after the cursor instead of re-inspecting migrated caches',
  );
  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir, maxFiles: 2 }),
    { scanned: 1, cleaned: 1, removed: 0 },
  );
  assert.equal(fs.existsSync(cursorPath), false, 'a completed pass clears the cursor');
  assert.equal(
    caches.filter((p) => fs.readFileSync(p, 'utf8').includes('pendingBase64')).length,
    0,
  );
});

test('a packed hudDir root cannot starve the sessions directory', () => {
  const { hudDir, sessionStateDir } = makeHudHome();
  const rootCaches = [];
  const sessionCaches = [];
  for (let i = 0; i < 300; i++) {
    rootCaches.push(
      write(path.join(hudDir, `metrics-root${String(i).padStart(3, '0')}.json`), legacyCache(i)),
    );
  }
  for (let i = 0; i < 50; i++) {
    sessionCaches.push(
      write(path.join(sessionStateDir, `metrics-sess${String(i).padStart(3, '0')}.json`), legacyCache(i)),
    );
  }
  const legacyLeftIn = (caches) =>
    caches.filter((p) => fs.readFileSync(p, 'utf8').includes('pendingBase64')).length;

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 150, cleaned: 150, removed: 0 },
    'each directory spends at most its fair share of the run budget',
  );
  assert.equal(legacyLeftIn(rootCaches), 200);
  assert.equal(legacyLeftIn(sessionCaches), 0, 'the smaller directory still finishes its work');

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 150, cleaned: 100, removed: 0 },
  );
  assert.equal(legacyLeftIn(rootCaches), 100);

  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 150, cleaned: 100, removed: 0 },
  );
  assert.equal(legacyLeftIn(rootCaches) + legacyLeftIn(sessionCaches), 0);

  const fourth = scrubLegacySessionCaches({ hudDir, sessionStateDir });
  assert.equal(fourth.cleaned + fourth.removed, 0);
});

test('a lost, corrupt, or stale cursor falls back to a safe full re-scan', () => {
  const { hudDir, sessionStateDir } = makeHudHome();
  const caches = [];
  for (let i = 0; i < 4; i++) {
    caches.push(write(path.join(sessionStateDir, `metrics-s${i}.json`), legacyCache(i)));
  }
  const cursorPath = path.join(hudDir, SCRUB_CURSOR_NAME);

  // A crash left a cursor whose anchor file has since been swept away.
  fs.writeFileSync(cursorPath, JSON.stringify({ v: 1, anchors: { sessions: 'metrics-gone.json' } }));
  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 4, cleaned: 4, removed: 0 },
    'a vanished anchor restarts the directory from the beginning',
  );
  assert.equal(fs.existsSync(cursorPath), false, 'the completed pass clears the stale cursor');

  // A cursor truncated by a crash is ignored the same way.
  for (const cache of caches) write(cache, legacyCache(1));
  fs.writeFileSync(cursorPath, '{"v":1,"anchors":{"sessio');
  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 4, cleaned: 4, removed: 0 },
  );

  // A cursor from a newer HUD version is not interpreted, and the pass
  // replaces it with its own once it has work left over.
  for (const cache of caches) write(cache, legacyCache(2));
  fs.writeFileSync(cursorPath, JSON.stringify({ v: 99, anchors: { sessions: 'metrics-s1.json' } }));
  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir, maxFiles: 2 }),
    { scanned: 2, cleaned: 2, removed: 0 },
    'an unknown cursor version restarts the directory from the beginning',
  );
  assert.match(fs.readFileSync(cursorPath, 'utf8'), /"v":1/, 'the pass writes its own cursor');
  assert.deepEqual(
    scrubLegacySessionCaches({ hudDir, sessionStateDir }),
    { scanned: 2, cleaned: 2, removed: 0 },
    'the replacement cursor resumes instead of re-inspecting migrated caches',
  );
  assert.equal(fs.existsSync(cursorPath), false, 'the completed pass clears the cursor');
  assert.equal(
    caches.filter((p) => fs.readFileSync(p, 'utf8').includes('pendingBase64')).length,
    0,
  );
});

test('bin --clean-legacy-caches migrates caches under the resolved HUD home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-hk-bin-'));
  const hudDir = path.join(root, 'hud');
  const sessionStateDir = path.join(hudDir, 'sessions');
  fs.mkdirSync(sessionStateDir, { recursive: true });
  const cache = write(path.join(sessionStateDir, 'metrics-legacy.json'), legacyCache(5));

  const result = spawnSync(process.execPath, [BIN, '--clean-legacy-caches'], {
    env: { ...process.env, KIMI_HUD_HOME: hudDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /1 scanned, 1 migrated, 0 corrupt removed/);
  const migrated = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(migrated.v, 9);
  assert.equal(migrated.agents.main.offset, 5);
  assert.equal(fs.readFileSync(cache, 'utf8').includes('pendingBase64'), false);
});
