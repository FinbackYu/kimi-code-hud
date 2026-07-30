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
