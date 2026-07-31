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
    stale: false,
  });
});

test('aggregates tokens before dividing across steps and turns', () => {
  const state = makeState();
  applyCacheWireRow(state, prompt());
  applyCacheWireRow(state, stepEnd('1', usage({
    inputOther: 10,
    inputCacheRead: 90,
    inputCacheCreation: 0,
  })));
  applyCacheWireRow(state, prompt());
  applyCacheWireRow(state, stepEnd('2', usage({
    inputOther: 900,
    inputCacheRead: 100,
    inputCacheCreation: 0,
  })));

  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 190 / 1100,
    readTokens: 190,
    inputTokens: 1100,
    stale: false,
  });
});

test('turn.prompt dims the session ratio until a new step is counted', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  assert.equal(cacheMetricFromState(state).stale, false);

  // A new prompt keeps the cumulative value visible but marks it stale.
  applyCacheWireRow(state, prompt());
  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 0.6,
    readTokens: 300,
    inputTokens: 500,
    stale: true,
  });

  applyCacheWireRow(state, stepEnd('2', usage({ inputCacheRead: 0 })));
  const m = cacheMetricFromState(state);
  assert.equal(m.stale, false);
  assert.equal(m.readTokens, 300);
  assert.equal(m.inputTokens, 700);
});

test('a changed turnId keeps accumulating across the session', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  applyCacheWireRow(state, stepEnd('2', usage({
    inputOther: 100,
    inputCacheRead: 100,
    inputCacheCreation: 0,
  })));

  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 400 / 700,
    readTokens: 400,
    inputTokens: 700,
    stale: false,
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
    stale: false,
  });
});

test('zero total input has no cache metric', () => {
  const state = makeState();
  applyCacheWireRow(state, prompt());
  assert.equal(cacheMetricFromState(state), null);
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
  test(`${label} usage skips the step instead of poisoning the ratio`, () => {
    const state = makeState();
    applyCacheWireRow(state, stepEnd('1', usage({ inputCacheRead: invalid })));
    assert.equal(cacheMetricFromState(state), null);

    applyCacheWireRow(state, stepEnd('1', usage()));
    assert.deepEqual(cacheMetricFromState(state), {
      hitRate: 0.6,
      readTokens: 300,
      inputTokens: 500,
      stale: false,
    });
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

test('resetCacheState clears the counters back to a hidden metric', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  resetCacheState(state);
  assert.equal(cacheMetricFromState(state), null);
});

test('malformed persisted counters are discarded before new usage is added', () => {
  const state = {
    cache: {
      readTokens: '300',
      inputTokens: 500,
      awaitsUsage: false,
    },
  };
  applyCacheWireRow(state, stepEnd('1', usage()));
  assert.deepEqual(cacheMetricFromState(state), {
    hitRate: 0.6,
    readTokens: 300,
    inputTokens: 500,
    stale: false,
  });
});
