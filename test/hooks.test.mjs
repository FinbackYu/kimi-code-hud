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

// Legacy bare block left by installs that predate the marker pair.
const BARE = `[[hooks]]
event = "SessionStart"
command = "${HOOK}"
timeout = 5`;

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

test('leaves a dangling START marker untouched instead of deleting trailing config', () => {
  const input = `model = "K3-256k"\n\n# --- kimi-code-hud hooks START (managed, do not edit) ---\n[[hooks]]\nevent = "SessionStart"\n\n[unrelated]\nkeep = true\n`;
  assert.equal(ensureHooksBlock(input, HOOK), input);
  assert.equal(removeHooksBlock(input), input);
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

test('remove strips legacy bare blocks and keeps foreign hooks', () => {
  const foreign = '[[hooks]]\nevent = "SessionStart"\ncommand = "node /opt/vibe-island/hooks/sync.mjs"\ntimeout = 5';
  const input = `model = "K3-256k"\n\n${BARE}\n\n${foreign}\n`;
  const out = removeHooksBlock(input, HOOK);
  assert.equal(out, `model = "K3-256k"\n\n${foreign}\n`);
});

test('remove strips the marked block and legacy bare blocks together', () => {
  assert.equal(removeHooksBlock(`${BLOCK}\n\n${BARE}\n`, HOOK), '');
});

test('remove without the hook command leaves bare blocks alone', () => {
  const input = `${BARE}\n`;
  assert.equal(removeHooksBlock(input), input);
});

test('ensure upgrades a legacy bare block in place', () => {
  const input = `model = "K3-256k"\n\n${BARE}\n\n[upgrade]\nchannel = "stable"\n`;
  const out = ensureHooksBlock(input, HOOK);
  assert.equal(out, `model = "K3-256k"\n\n${BLOCK}\n\n[upgrade]\nchannel = "stable"\n`);
});

test('ensure adopts the first of duplicate bare blocks and removes the rest', () => {
  const once = ensureHooksBlock(`${BARE}\n\n${BARE}\n`, HOOK);
  assert.equal(once, `${BLOCK}\n`);
  assert.equal(ensureHooksBlock(once, HOOK), once);
  assert.equal(once.split('kimi-code-hud hooks START').length - 1, 1);
  assert.equal(once.split('[[hooks]]').length - 1, 1);
});

test('ensure refreshes the marked block and removes bare stragglers', () => {
  const moved = BLOCK.replace(HOOK, 'node /old/location/hooks/sync-status-line.mjs');
  const input = `${BARE}\n\n${moved}\n\n[upgrade]\nchannel = "stable"\n`;
  const out = ensureHooksBlock(input, HOOK);
  assert.equal(out, `${BLOCK}\n\n[upgrade]\nchannel = "stable"\n`);
});

test('bare blocks pointing at other scripts are left alone', () => {
  const foreign = '[[hooks]]\nevent = "SessionStart"\ncommand = "node /opt/other-tool/notify.mjs"\ntimeout = 5\n';
  assert.equal(removeHooksBlock(foreign, HOOK), foreign);
  assert.equal(ensureHooksBlock(foreign, HOOK), `${foreign}\n${BLOCK}\n`);
});

test('a bare block from a moved install path is not claimed', () => {
  const moved = `${BARE.replace(HOOK, 'node /old/location/hooks/sync-status-line.mjs')}\n`;
  assert.equal(removeHooksBlock(moved, HOOK), moved);
});

test('a dangling START marker leaves even legacy bare blocks untouched', () => {
  const input = `# --- kimi-code-hud hooks START (managed, do not edit) ---\n[[hooks]]\nevent = "SessionStart"\n\n${BARE}\n`;
  assert.equal(ensureHooksBlock(input, HOOK), input);
  assert.equal(removeHooksBlock(input, HOOK), input);
});
