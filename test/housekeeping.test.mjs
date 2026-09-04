import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HOUSEKEEPING_MAX_UNLINKS,
  SESSION_FILE_TTL_MS,
  TMP_FILE_MAX_AGE_MS,
  runHousekeeping,
} from '../src/housekeeping.mjs';

// Daily housekeeping: orphaned atomic-write and lock temporaries are swept,
// session state past the retention window is pruned, and the whole sweep is
// throttled to once per interval by a stamp file.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
