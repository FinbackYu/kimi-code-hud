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
