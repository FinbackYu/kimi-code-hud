import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findProviderTable,
  findModelTable,
  resolveModelConfig,
  resolveProviderConfig,
  stringArrayValue,
  resolveModelProvider,
  MANAGED_KIMI_PROVIDER,
} from '../src/model-config.mjs';

const CONFIG = `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[providers.anthropic]
type = "anthropic"

[providers.deepseek]
type = "openai"
base_url = "https://api.deepseek.com/v1"
api_key = "redacted\\\\value"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
display_name = "K3"
capabilities = [ "thinking", "always_thinking", "image_in" ]
support_efforts = [ "low", "high", "max" ]
default_effort = "high"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000

[models."orphan"]
model = "orphan"
`;

function withConfig(text, fn) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-mcfg-')), 'config.toml');
  fs.writeFileSync(p, text);
  return fn(p);
}

test('findModelTable matches by alias, display_name, and model id', () => {
  assert.match(findModelTable(CONFIG, 'kimi-code/k3'), /managed:kimi-code/);
  assert.match(findModelTable(CONFIG, 'K3'), /managed:kimi-code/);
  assert.match(findModelTable(CONFIG, 'k3'), /managed:kimi-code/);
  assert.match(findModelTable(CONFIG, 'claude-opus-4-7'), /anthropic/);
  assert.equal(findModelTable(CONFIG, 'nope'), null);
  assert.equal(findModelTable(CONFIG, ''), null);
});

test('resolveModelConfig returns the billing identity without provider secrets', () => {
  assert.deepEqual(resolveModelConfig({ name: 'claude-opus-4-7', configText: CONFIG }), {
    alias: 'claude-opus-4-7',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    displayName: null,
  });
  assert.equal(resolveModelConfig({ name: 'missing', configText: CONFIG }), null);
});

test('provider config resolves quoted and bare tables with decoded credentials', () => {
  assert.match(findProviderTable(CONFIG, 'managed:kimi-code'), /api.kimi.com/);
  assert.match(findProviderTable(CONFIG, 'deepseek'), /api_key/);
  assert.deepEqual(resolveProviderConfig({ provider: 'deepseek', configText: CONFIG }), {
    provider: 'deepseek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'redacted\\value',
  });
  assert.equal(resolveProviderConfig({ provider: 'missing', configText: CONFIG }), null);
});

test('stringArrayValue parses inline arrays and reports absent keys as null', () => {
  const table = findModelTable(CONFIG, 'kimi-code/k3');
  assert.deepEqual(stringArrayValue(table, 'capabilities'), ['thinking', 'always_thinking', 'image_in']);
  assert.deepEqual(stringArrayValue(table, 'support_efforts'), ['low', 'high', 'max']);
  assert.equal(stringArrayValue(table, 'missing'), null);
  const bare = findModelTable(CONFIG, 'claude-opus-4-7');
  assert.equal(stringArrayValue(bare, 'capabilities'), null);
});

test('resolveModelProvider prefers the exact wire alias over the display string', () => {
  withConfig(CONFIG, (configPath) => {
    // Display string alone would also resolve, but the alias wins when they
    // could disagree.
    assert.equal(
      resolveModelProvider({ modelAlias: 'kimi-code/k3', modelDisplay: 'claude-opus-4-7', configPath }),
      MANAGED_KIMI_PROVIDER,
    );
  });
});

test('resolveModelProvider resolves managed and third-party models', () => {
  withConfig(CONFIG, (configPath) => {
    assert.equal(resolveModelProvider({ modelAlias: 'kimi-code/k3', configPath }), MANAGED_KIMI_PROVIDER);
    assert.equal(resolveModelProvider({ modelAlias: 'claude-opus-4-7', configPath }), 'anthropic');
    // Falls back to the payload display string when the alias is unknown.
    assert.equal(
      resolveModelProvider({ modelAlias: 'gone', modelDisplay: 'K3', configPath }),
      MANAGED_KIMI_PROVIDER,
    );
  });
});

test('resolveModelProvider returns null when it cannot determine the provider', () => {
  withConfig(CONFIG, (configPath) => {
    assert.equal(resolveModelProvider({ modelAlias: 'unknown-model', configPath }), null);
    // Model table without a provider key -> unknown, not "managed".
    assert.equal(resolveModelProvider({ modelAlias: 'orphan', configPath }), null);
  });
  assert.equal(resolveModelProvider({ modelAlias: 'kimi-code/k3', configPath: '/nonexistent.toml' }), null);
  assert.equal(resolveModelProvider({}), null);
});
