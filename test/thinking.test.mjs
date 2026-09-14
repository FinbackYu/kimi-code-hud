import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveThinkingLevel } from '../src/thinking.mjs';

const levelOf = (opts) => resolveThinkingLevel(opts).level;

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
      levelOf({ sessionLevel: 'max', model: 'K3', configPath }),
      'max',
    );
    assert.equal(
      levelOf({ sessionLevel: 'off', model: 'K3', configPath }),
      'off',
    );
  });
});

test('missing config file defaults to a provisional boolean on', () => {
  assert.deepEqual(
    resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath: '/nonexistent/config.toml' }),
    { level: 'on', confirmed: false },
  );
});

test('[thinking] enabled = false yields off', () => {
  withConfig('[thinking]\nenabled = false\n', (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'K3', configPath }), 'off');
  });
});

test('boolean model without support_efforts yields on', () => {
  withConfig(CONFIG, (configPath) => {
    assert.equal(
      levelOf({ sessionLevel: null, model: 'kimi-for-coding', configPath }),
      'on',
    );
  });
});

test('effort model uses global effort, matched via display_name', () => {
  withConfig(CONFIG, (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'K3', configPath }), 'high');
  });
});

test('effort model falls back to model default_effort', () => {
  const noGlobal = CONFIG.replace('effort = "high"\n', '');
  withConfig(noGlobal, (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'K3', configPath }), 'high');
  });
  const noDefault = noGlobal.replace('default_effort = "high"\n', '');
  withConfig(noDefault, (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'K3', configPath }), 'on');
  });
});

const THIRD_PARTY = `
[models."vision-only"]
model = "vision-only"
capabilities = [ "image_in", "tool_use" ]

[models."adaptive"]
model = "adaptive"
capabilities = [ "tool_use" ]
adaptive_thinking = true

[models."always-bool"]
model = "always-bool"
capabilities = [ "thinking", "always_thinking" ]

[models."always-effort"]
model = "always-effort"
capabilities = [ "thinking", "always_thinking" ]
support_efforts = [ "low", "high", "max" ]
default_effort = "max"
`;

test('model declaring capabilities without thinking resolves to off', () => {
  withConfig(THIRD_PARTY, (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'vision-only', configPath }), 'off');
  });
});

test('global effort keeps a non-thinking third-party model on (passthrough)', () => {
  withConfig(`[thinking]\nenabled = true\neffort = "high"\n${THIRD_PARTY}`, (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'vision-only', configPath }), 'on');
  });
});

test('adaptive_thinking counts as thinking support', () => {
  withConfig(THIRD_PARTY, (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'adaptive', configPath }), 'on');
  });
});

test('always_thinking models never resolve to off', () => {
  const disabled = `[thinking]\nenabled = false\n${THIRD_PARTY}`;
  withConfig(disabled, (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'always-bool', configPath }), 'on');
    // Effort-capable: falls back to the model default, skipping off.
    assert.equal(levelOf({ sessionLevel: null, model: 'always-effort', configPath }), 'max');
  });
  const offEffort = `[thinking]\nenabled = true\neffort = "off"\n${THIRD_PARTY}`;
  withConfig(offEffort, (configPath) => {
    assert.equal(levelOf({ sessionLevel: null, model: 'always-effort', configPath }), 'max');
  });
});

test('config-derived levels stay provisional in every source layer', () => {
  withConfig(CONFIG, (configPath) => {
    // Even the explicit [thinking] effort stays provisional: the host does
    // not persist the top effort tier, so config can silently lag the
    // current choice.
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }),
      { level: 'high', confirmed: false },
    );
  });
  const noGlobal = CONFIG.replace('effort = "high"\n', '');
  withConfig(noGlobal, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }),
      { level: 'high', confirmed: false }, // model default_effort
    );
    const noDefault = noGlobal.replace('default_effort = "high"\n', '');
    withConfig(noDefault, (fallbackPath) => {
      assert.deepEqual(
        resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath: fallbackPath }),
        { level: 'on', confirmed: false }, // boolean fallback
      );
    });
  });
});

test('explicit off states stay provisional too', () => {
  withConfig(CONFIG.replace('enabled = true', 'enabled = false'), (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }),
      { level: 'off', confirmed: false },
    );
  });
  withConfig(CONFIG.replace('effort = "high"', 'effort = "off"'), (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }),
      { level: 'off', confirmed: false },
    );
  });
});

test('always_thinking models stay provisional: global effort or model default', () => {
  withConfig(`[thinking]\nenabled = true\neffort = "low"\n${THIRD_PARTY}`, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'always-effort', configPath }),
      { level: 'low', confirmed: false },
    );
  });
  withConfig(THIRD_PARTY, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'always-effort', configPath }),
      { level: 'max', confirmed: false }, // model default_effort
    );
  });
});

test('third-party passthrough stays provisional either way', () => {
  withConfig(THIRD_PARTY, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'vision-only', configPath }),
      { level: 'off', confirmed: false }, // capability-derived
    );
  });
  withConfig(`[thinking]\nenabled = true\neffort = "high"\n${THIRD_PARTY}`, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'vision-only', configPath }),
      { level: 'on', confirmed: false }, // rides on the explicit key
    );
  });
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-snap-'));
}

test('config-pinned snapshots follow config edits; wire-pinned ones stay pinned', () => {
  const snapshotDir = tmpDir();
  withConfig(CONFIG, (configPath) => {
    // s1 lazy-starts under the config effort (provisional, like any
    // config-derived level).
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'high', confirmed: false },
    );
    // Another session runs /effort low -> global config rewritten. A
    // config-derived snapshot must not shadow the edit: same model, changed
    // config basis -> re-resolve.
    fs.writeFileSync(configPath, CONFIG.replace('effort = "high"', 'effort = "low"'));
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'low', confirmed: false },
    );
    // s2 is pinned by its own profile.bind wire row before the edit.
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: 'max', model: 'K3', configPath, sessionId: 's2', snapshotDir }),
      { level: 'max', confirmed: true },
    );
    fs.writeFileSync(configPath, CONFIG.replace('effort = "high"', 'effort = "off"'));
    // The wire-pinned session keeps its start-of-session level; a fresh
    // session sees the new config.
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's2', snapshotDir }),
      { level: 'max', confirmed: true },
    );
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's3', snapshotDir }),
      { level: 'off', confirmed: false },
    );
  });
});

test('in-session change updates the snapshot', () => {
  const snapshotDir = tmpDir();
  withConfig(CONFIG, (configPath) => {
    assert.equal(
      levelOf({ sessionLevel: 'max', model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      'max',
    );
    // Later renders without a wire level keep the in-session choice.
    assert.equal(
      levelOf({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      'max',
    );
  });
});

test('model change re-resolves and rewrites the snapshot', () => {
  const snapshotDir = tmpDir();
  withConfig(CONFIG, (configPath) => {
    assert.equal(
      levelOf({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      'high',
    );
    assert.equal(
      levelOf({ sessionLevel: null, model: 'kimi-for-coding', configPath, sessionId: 's1', snapshotDir }),
      'on',
    );
    assert.equal(
      levelOf({ sessionLevel: null, model: 'kimi-for-coding', configPath: '/nonexistent/x', sessionId: 's1', snapshotDir }),
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
    levelOf({
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
    levelOf({
      sessionLevel: null,
      model: 'K3',
      sessionId,
      snapshotDir,
      configPath: path.join(parent, 'missing.toml'),
    }),
    'max',
  );
});

test('wire levels are confirmed; config inference is provisional', () => {
  withConfig(CONFIG, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: 'max', model: 'K3', configPath }),
      { level: 'max', confirmed: true },
    );
    // Even an explicit config effort stays provisional until a wire row
    // confirms it (the top tier is never persisted to config.toml).
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath }),
      { level: 'high', confirmed: false },
    );
  });
});

test('config-pinned snapshot stays provisional until the wire confirms', () => {
  const snapshotDir = tmpDir();
  withConfig(CONFIG, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'high', confirmed: false },
    );
    // Re-reads of the unchanged config stay provisional.
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'high', confirmed: false },
    );
    // The first wire row confirms the level and rewrites the snapshot.
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: 'max', model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'max', confirmed: true },
    );
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'max', confirmed: true },
    );
    // ...and the wire pin is immune to later config edits on the same model.
    fs.writeFileSync(configPath, CONFIG.replace('effort = "high"', 'effort = "low"'));
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'max', confirmed: true },
    );
  });
});

test('legacy snapshots without a confirmed flag read as confirmed', () => {
  const snapshotDir = tmpDir();
  fs.writeFileSync(
    path.join(snapshotDir, 'thinking-s1.json'),
    JSON.stringify({ level: 'max', model: 'K3' }),
  );
  withConfig(CONFIG, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'max', confirmed: true },
    );
    // Later config edits on the same model do not re-resolve it, and reads
    // never rewrite the legacy file into the new format.
    fs.writeFileSync(configPath, CONFIG.replace('effort = "high"', 'effort = "low"'));
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'max', confirmed: true },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(snapshotDir, 'thinking-s1.json'), 'utf8')),
      { level: 'max', model: 'K3' },
    );
  });
});

test('snapshots record provenance: wire pins store a null config basis', () => {
  const snapshotDir = tmpDir();
  withConfig(CONFIG, (configPath) => {
    resolveThinkingLevel({ sessionLevel: 'max', model: 'K3', configPath, sessionId: 'w1', snapshotDir });
    resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 'c1', snapshotDir });
    const wirePinned = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'thinking-w1.json'), 'utf8'));
    assert.deepEqual(
      { level: wirePinned.level, confirmed: wirePinned.confirmed, configBasis: wirePinned.configBasis },
      { level: 'max', confirmed: true, configBasis: null },
    );
    const configPinned = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'thinking-c1.json'), 'utf8'));
    assert.equal(configPinned.level, 'high');
    assert.equal(configPinned.confirmed, false);
    assert.equal(typeof configPinned.configBasis, 'string');
  });
});

test('a same-model default_effort edit re-resolves instead of being shadowed', () => {
  const snapshotDir = tmpDir();
  const noGlobal = CONFIG.replace('effort = "high"\n', '');
  withConfig(noGlobal, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'high', confirmed: false },
    );
    fs.writeFileSync(
      configPath,
      noGlobal.replace('default_effort = "high"', 'default_effort = "max"'),
    );
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'max', confirmed: false },
    );
  });
});

test('pre-basis config-pinned snapshots stop shadowing on first read', () => {
  const snapshotDir = tmpDir();
  const snapshotFile = path.join(snapshotDir, 'thinking-s1.json');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    snapshotFile,
    JSON.stringify({ level: 'low', model: 'K3', confirmed: false }),
  );
  withConfig(CONFIG, (configPath) => {
    assert.deepEqual(
      resolveThinkingLevel({ sessionLevel: null, model: 'K3', configPath, sessionId: 's1', snapshotDir }),
      { level: 'high', confirmed: false },
    );
    const upgraded = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    assert.equal(upgraded.level, 'high');
    assert.equal(typeof upgraded.configBasis, 'string');
  });
});
