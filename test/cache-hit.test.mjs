import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCacheWireRow,
  cacheMetricFromState,
  resetCacheState,
} from '../src/cache-hit.mjs';
import { CACHE_MAX_SAMPLES, CACHE_TTL_MS } from '../src/metrics-constants.mjs';

const NOW = Date.parse('2026-07-31T00:00:00Z');

function makeState() {
  return {};
}

function prompt(time = NOW) {
  return { type: 'turn.prompt', input: [{ type: 'text', text: 'hello' }], time };
}

function stepEnd(turnId, usage, time = NOW) {
  return {
    type: 'context.append_loop_event',
    event: { type: 'step.end', turnId, usage },
    time,
  };
}

function metric(state, now = NOW) {
  return cacheMetricFromState(state, now);
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

  assert.deepEqual(metric(state), {
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

  assert.deepEqual(metric(state), {
    hitRate: 190 / 1100,
    readTokens: 190,
    inputTokens: 1100,
    stale: false,
  });
});

test('keeps only the newest five requests so a cache miss lowers the ratio', () => {
  const state = makeState();
  for (let i = 0; i < CACHE_MAX_SAMPLES; i += 1) {
    applyCacheWireRow(state, stepEnd(String(i), usage({
      inputOther: 0,
      inputCacheRead: 100,
      inputCacheCreation: 0,
    }), NOW + i));
  }
  assert.equal(metric(state).hitRate, 1);

  applyCacheWireRow(state, stepEnd('miss', usage({
    inputOther: 100,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  }), NOW + CACHE_MAX_SAMPLES));
  assert.equal(state.cache.samples.length, CACHE_MAX_SAMPLES);
  assert.deepEqual(metric(state), {
    hitRate: 0.8,
    readTokens: 400,
    inputTokens: 500,
    stale: false,
  });
});

test('turn.prompt leaves the ratio untouched and refreshes the idle anchor', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage(), NOW - CACHE_TTL_MS));
  assert.deepEqual(metric(state), {
    hitRate: 0.6,
    readTokens: 300,
    inputTokens: 500,
    stale: true,
  });

  applyCacheWireRow(state, prompt());
  assert.deepEqual(metric(state), {
    hitRate: 0.6,
    readTokens: 300,
    inputTokens: 500,
    stale: false,
  });

  applyCacheWireRow(state, stepEnd('2', usage({ inputCacheRead: 0 })));
  const m = metric(state);
  assert.equal(m.readTokens, 300);
  assert.equal(m.inputTokens, 700);
});

test('marks the unchanged value stale exactly thirty minutes after the last message', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  const fresh = metric(state, NOW + CACHE_TTL_MS - 1);
  const stale = metric(state, NOW + CACHE_TTL_MS);
  assert.equal(fresh.stale, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.hitRate, fresh.hitRate);
  assert.equal(stale.readTokens, fresh.readTokens);
  assert.equal(stale.inputTokens, fresh.inputTokens);
});

test('an older message timestamp cannot move the freshness anchor backwards', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  applyCacheWireRow(state, prompt(NOW - CACHE_TTL_MS));
  assert.equal(metric(state).stale, false);
});

test('a changed turnId keeps contributing to the recent window', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  applyCacheWireRow(state, stepEnd('2', usage({
    inputOther: 100,
    inputCacheRead: 100,
    inputCacheCreation: 0,
  })));

  assert.deepEqual(metric(state), {
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
  assert.deepEqual(metric(state), {
    hitRate: 0,
    readTokens: 0,
    inputTokens: 200,
    stale: false,
  });
});

test('zero total input has no cache metric and does not displace a useful sample', () => {
  const state = makeState();
  applyCacheWireRow(state, prompt());
  assert.equal(metric(state), null);
  applyCacheWireRow(state, stepEnd('1', usage({
    inputOther: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  })));
  assert.equal(metric(state), null);

  applyCacheWireRow(state, stepEnd('2', usage()));
  applyCacheWireRow(state, stepEnd('3', usage({
    inputOther: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  })));
  assert.equal(state.cache.samples.length, 1);
  assert.equal(metric(state).hitRate, 0.6);
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
    assert.equal(metric(state), null);

    applyCacheWireRow(state, stepEnd('1', usage()));
    assert.deepEqual(metric(state), {
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

  assert.equal(metric(state)?.readTokens, 300);
});

test('a metric without a reliable message timestamp renders as stale', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage(), null));
  assert.equal(metric(state).stale, true);
});

test('resetCacheState clears the samples back to a hidden metric', () => {
  const state = makeState();
  applyCacheWireRow(state, stepEnd('1', usage()));
  resetCacheState(state);
  assert.equal(metric(state), null);
});

test('malformed persisted counters are discarded before new usage is added', () => {
  const state = {
    cache: {
      readTokens: '300',
      inputTokens: 500,
    },
  };
  applyCacheWireRow(state, stepEnd('1', usage()));
  assert.deepEqual(metric(state), {
    hitRate: 0.6,
    readTokens: 300,
    inputTokens: 500,
    stale: false,
  });
});
