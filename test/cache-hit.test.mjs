import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCacheWireRow,
  cacheMetricFromState,
  resetCacheState,
} from '../src/cache-hit.mjs';

function makeState() {
  return {};
}

function prompt() {
  return { type: 'turn.prompt', input: [{ type: 'text', text: 'hello' }] };
}

function stepEnd(turnId, usage) {
  return {
    type: 'context.append_loop_event',
    event: { type: 'step.end', turnId, usage },
  };
}

const usage = (overrides = {}) => ({
  inputOther: 100,
  output: 20,
  inputCacheRead: 300,
  inputCacheCreation: 100,
  ...overrides,
});

test('uses the official cache-read over total-input formula', () => {
  const state = makeState();
  applyCacheWireRow(state, prompt());
  applyCacheWireRow(state, stepEnd('1', usage()));

  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 0.6,
    readTokens: 300,
    inputTokens: 500,
  });
});

test('aggregates tokens before dividing across steps in one turn', () => {
  const state = makeState();
  applyCacheWireRow(state, prompt());
  applyCacheWireRow(state, stepEnd('1', usage({
    inputOther: 10,
    inputCacheRead: 90,
    inputCacheCreation: 0,
  })));
  applyCacheWireRow(state, stepEnd('1', usage({
    inputOther: 900,
    inputCacheRead: 100,
    inputCacheCreation: 0,
  })));

  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 190 / 1100,
    readTokens: 190,
    inputTokens: 1100,
  });
});

test('turn.prompt clears the previous turn until a new step completes', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  assert.notEqual(cacheMetricFromState(state), null);

  applyCacheWireRow(state, prompt());
  assert.equal(cacheMetricFromState(state), null);

  applyCacheWireRow(state, stepEnd('2', usage({ inputCacheRead: 0 })));
  assert.equal(cacheMetricFromState(state)?.hitRate, 0);
});

test('a changed turnId defensively starts a new aggregation', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  applyCacheWireRow(state, stepEnd('2', usage({
    inputOther: 100,
    inputCacheRead: 100,
    inputCacheCreation: 0,
  })));

  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 0.5,
    readTokens: 100,
    inputTokens: 200,
  });
});

test('positive input with no cache reads is a visible zero rate', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage({
    inputOther: 200,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  })));
  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 0,
    readTokens: 0,
    inputTokens: 200,
  });
});

test('zero total input has no cache metric', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage({
    inputOther: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  })));
  assert.equal(cacheMetricFromState(state), null);
});

for (const [label, invalid] of [
  ['missing', undefined],
  ['negative', -1],
  ['infinite', Number.POSITIVE_INFINITY],
  ['non-numeric', '100'],
]) {
  test(`${label} input usage hides the incomplete turn until the next prompt`, () => {
    const state = makeState();
    applyCacheWireRow(state, stepEnd('1', usage({ inputCacheRead: invalid })));
    applyCacheWireRow(state, stepEnd('1', usage()));
    assert.equal(cacheMetricFromState(state), null);

    applyCacheWireRow(state, prompt());
    applyCacheWireRow(state, stepEnd('2', usage()));
    assert.notEqual(cacheMetricFromState(state), null);
  });
}

test('usage.record is ignored to avoid double counting step.end', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  applyCacheWireRow(state, {
    type: 'usage.record',
    usage: usage({ inputCacheRead: 9999 }),
    usageScope: 'turn',
  });

  assert.equal(cacheMetricFromState(state)?.readTokens, 300);
});

test('needs-prompt state ignores partial steps until a prompt boundary', () => {
  const state = makeState();
  resetCacheState(state, { needsPrompt: true });
  applyCacheWireRow(state, stepEnd('8', usage()));
  assert.equal(cacheMetricFromState(state), null);

  applyCacheWireRow(state, prompt());
  applyCacheWireRow(state, stepEnd('9', usage()));
  assert.notEqual(cacheMetricFromState(state), null);
});

test('malformed persisted counters are discarded before new usage is added', () => {
  const state = {
    cacheTurn: {
      turnId: '1',
      readTokens: '300',
      inputTokens: 500,
      complete: true,
    },
    cacheNeedsPrompt: false,
  };
  applyCacheWireRow(state, stepEnd('1', usage()));
  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 0.6,
    readTokens: 300,
    inputTokens: 500,
  });
});
