import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureHooksBlock, removeHooksBlock } from '../src/hooks.mjs';

const HOOK = 'node /Users/test/kimi-code-hud/hooks/sync-status-line.mjs';

const BLOCK = `# --- kimi-code-hud hooks START (managed, do not edit) ---
[[hooks]]
event = "SessionStart"
command = "${HOOK}"
timeout = 5
# --- kimi-code-hud hooks END ---`;

test('installs into an empty file', () => {
  assert.equal(ensureHooksBlock('', HOOK), `${BLOCK}\n`);
});

test('appends alongside existing hooks and settings', () => {
  const input = 'model = "K3-256k"\n\n[[hooks]]\nevent = "Stop"\ncommand = "/other/bin"\n';
  const out = ensureHooksBlock(input, HOOK);
  assert.equal(out, `${input}\n${BLOCK}\n`);
});

test('ensure is idempotent', () => {
  const once = ensureHooksBlock('model = "K3-256k"\n', HOOK);
  const twice = ensureHooksBlock(once, HOOK);
  assert.equal(twice, once);
  assert.equal(once.split('kimi-code-hud hooks START').length - 1, 1);
  assert.equal(once.split('[[hooks]]').length - 1, 1);
});

test('refreshes the block in place when the hook path moved', () => {
  const moved = BLOCK.replace(HOOK, 'node /old/location/hooks/sync-status-line.mjs');
  const input = `model = "K3-256k"\n\n${moved}\n\n[upgrade]\nchannel = "stable"\n`;
  const out = ensureHooksBlock(input, HOOK);
  assert.equal(out, `model = "K3-256k"\n\n${BLOCK}\n\n[upgrade]\nchannel = "stable"\n`);
});

test('recovers from a dangling START marker without END', () => {
  const input = `model = "K3-256k"\n\n# --- kimi-code-hud hooks START (managed, do not edit) ---\n[[hooks]]\n`;
  const out = ensureHooksBlock(input, HOOK);
  assert.equal(out, `model = "K3-256k"\n\n${BLOCK}\n`);
});

test('escapes quotes and backslashes in the hook command', () => {
  const out = ensureHooksBlock('', 'node "C:\\Program Files\\hud.mjs"');
  assert.match(out, /command = "node \\"C:\\\\Program Files\\\\hud\.mjs\\""/);
});

test('remove strips only our block', () => {
  const input = `model = "K3-256k"\n\n[[hooks]]\nevent = "Stop"\ncommand = "/other/bin"\n\n${BLOCK}\n`;
  const out = removeHooksBlock(input);
  assert.equal(out, 'model = "K3-256k"\n\n[[hooks]]\nevent = "Stop"\ncommand = "/other/bin"\n');
});

test('remove on a file without the block is a no-op', () => {
  const input = 'model = "K3-256k"\n';
  assert.equal(removeHooksBlock(input), input);
});

test('remove on a file with only our block leaves an empty file', () => {
  assert.equal(removeHooksBlock(`${BLOCK}\n`), '');
});
