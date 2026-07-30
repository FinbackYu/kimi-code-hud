import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveThinkingLevel } from '../src/thinking.mjs';

const CONFIG = `
[thinking]
enabled = true
effort = "high"

[models."kimi-code/k3"]
model = "k3"
display_name = "K3"
support_efforts = [ "low", "high", "max" ]
default_effort = "high"

[models."kimi-code/kimi-for-coding"]
model = "kimi-for-coding"
`;

function withConfig(text, fn) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-cfg-')), 'config.toml');
  fs.writeFileSync(p, text);
  return fn(p);
}

test('session level wins over everything', () => {
  withConfig(CONFIG, (configPath) => {
    assert.equal(
      resolveThinkingLevel({ sessionLevel: 'max', model: 'K3', configPath }),
      'max',
    );
    assert.equal(
      resolveThinkingLevel({ sessionLevel: 'off', model: 'K3', configPath }),
      'off',
    );
  });
});

test('missing config file defaults to boolean on', () => {
  assert.equal(
    resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath: '/nonexistent/config.toml' }),
    'on',
  );
});

test('[thinking] enabled = false yields off', () => {
  withConfig('[thinking]\nenabled = false\n', (configPath) => {
    assert.equal(resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }), 'off');
  });
});

test('boolean model without support_efforts yields on', () => {
  withConfig(CONFIG, (configPath) => {
    assert.equal(
      resolveThinkingLevel({ sessionLevel: null, model: 'kimi-for-coding', configPath }),
      'on',
    );
  });
});

test('effort model uses global effort, matched via display_name', () => {
  withConfig(CONFIG, (configPath) => {
    assert.equal(resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }), 'high');
  });
});

test('effort model falls back to model default_effort', () => {
  const noGlobal = CONFIG.replace('effort = "high"\n', '');
  withConfig(noGlobal, (configPath) => {
    assert.equal(resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }), 'high');
  });
  const noDefault = noGlobal.replace('default_effort = "high"\n', '');
  withConfig(noDefault, (configPath) => {
    assert.equal(resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }), 'on');
  });
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-snap-'));
}

test('snapshot pins the level per session across config changes', () => {
  const snapshotDir = tmpDir();
  withConfig(CONFIG, (configPath) => {
    assert.equal(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      'high',
    );
    // Another session runs /effort low -> global config rewritten.
    fs.writeFileSync(configPath, CONFIG.replace('effort = "high"', 'effort = "low"'));
    // s1 keeps its start-of-session level; a new session sees the new config.
    assert.equal(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      'high',
    );
    assert.equal(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's2', snapshotDir }),
      'low',
    );
  });
});

test('in-session change updates the snapshot', () => {
  const snapshotDir = tmpDir();
  withConfig(CONFIG, (configPath) => {
    assert.equal(
      resolveThinkingLevel({ sessionLevel: 'max', model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      'max',
    );
    // Later renders without a wire level keep the in-session choice.
    assert.equal(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      'max',
    );
  });
});

test('model change re-resolves and rewrites the snapshot', () => {
  const snapshotDir = tmpDir();
  withConfig(CONFIG, (configPath) => {
    assert.equal(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      'high',
    );
    assert.equal(
      resolveThinkingLevel({ sessionLevel: null, model: 'kimi-for-coding', configPath, sessionId: 's1', snapshotDir }),
      'on',
    );
    assert.equal(
      resolveThinkingLevel({ sessionLevel: null, model: 'kimi-for-coding', configPath: '/nonexistent/x', sessionId: 's1', snapshotDir }),
      'on',
    );
  });
});

test('snapshot session id cannot escape the snapshot directory', () => {
  const parent = tmpDir();
  const snapshotDir = path.join(parent, 'snapshots');
  const sessionId = 'x/../../escape';
  const escapedPath = path.join(parent, 'escape.json');

  assert.equal(
    resolveThinkingLevel({
      sessionLevel: 'max',
      model: 'K3',
      sessionId,
      snapshotDir,
      configPath: path.join(parent, 'missing.toml'),
    }),
    'max',
  );
  assert.equal(fs.existsSync(escapedPath), false);
  assert.equal(fs.readdirSync(snapshotDir).length, 1);
  assert.equal(
    resolveThinkingLevel({
      sessionLevel: null,
      model: 'K3',
      sessionId,
      snapshotDir,
      configPath: path.join(parent, 'missing.toml'),
    }),
    'max',
  );
});
