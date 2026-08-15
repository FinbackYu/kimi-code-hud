import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/fs-store.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hud-fs-store-'));
}

test('atomicWriteFile writes the given content', () => {
  const file = path.join(tmpDir(), 'state.json');
  atomicWriteFile(file, '{"ok":true}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}');
});

test('atomicWriteFile overwrites an existing file', () => {
  const file = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(file, 'old');
  atomicWriteFile(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('atomicWriteFile retains existing permission bits', () => {
  const file = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(file, 'old');
  fs.chmodSync(file, 0o644);
  atomicWriteFile(file, 'new', { mode: 0o600 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test('atomicWriteFile can force mode without inheriting the target', () => {
  const file = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(file, 'old');
  fs.chmodSync(file, 0o644);
  atomicWriteFile(file, 'new', { mode: 0o600, preserveMode: false });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('atomicWriteFile leaves no .tmp- residue after success', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  atomicWriteFile(file, 'new');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('atomicWriteFile creates a missing target directory', () => {
  const file = path.join(tmpDir(), 'nested', 'deeper', 'state.json');
  atomicWriteFile(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});
