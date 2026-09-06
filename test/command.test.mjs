import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeCommand, quoteCommandArg } from '../src/command.mjs';

test('ordinary script paths keep the historical command format', () => {
  assert.equal(nodeCommand('/Users/test/kimi-code-hud/bin/kimi-hud.mjs'),
    'node /Users/test/kimi-code-hud/bin/kimi-hud.mjs');
});

test('paths with spaces and shell metacharacters stay one argument', () => {
  assert.equal(nodeCommand('/Users/Test User/hud$1.mjs'),
    'node "/Users/Test User/hud\\$1.mjs"');
  assert.equal(quoteCommandArg('plain/path'), 'plain/path');
});

test('backslash paths are quoted so POSIX shells do not consume the escape', () => {
  // Unquoted, sh reads back\slash as backslash; the doubled form inside
  // double quotes survives every POSIX shell byte-for-byte.
  assert.equal(quoteCommandArg('back\\slash/kimi-hud.mjs'), '"back\\\\slash/kimi-hud.mjs"');
  assert.equal(nodeCommand('back\\slash/kimi-hud.mjs'), 'node "back\\\\slash/kimi-hud.mjs"');
});
