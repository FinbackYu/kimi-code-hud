import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTERS, selectProviderUsageAdapter } from '../src/provider-usage.mjs';
import { ADAPTER as deepSeekAdapter } from '../src/provider-usage/deepseek.mjs';
import { ADAPTER as openCodeGoAdapter } from '../src/provider-usage/opencode-go.mjs';
import { ADAPTER as zhipuAdapter } from '../src/provider-usage/zhipu.mjs';
import { ADAPTER as moonshotAdapter } from '../src/provider-usage/moonshot.mjs';
import { ADAPTER as miniMaxAdapter } from '../src/provider-usage/minimax.mjs';
import { ADAPTER as syntheticAdapter } from '../src/provider-usage/synthetic.mjs';
import { ADAPTER as chutesAdapter } from '../src/provider-usage/chutes.mjs';
import { ADAPTER as openRouterAdapter } from '../src/provider-usage/openrouter.mjs';
import { ADAPTER as deepInfraAdapter } from '../src/provider-usage/deepinfra.mjs';
import { ADAPTER as veniceAdapter } from '../src/provider-usage/venice.mjs';
import { ADAPTER as ollamaAdapter } from '../src/provider-usage/ollama.mjs';
import { ADAPTER as commandCodeAdapter } from '../src/provider-usage/command-code.mjs';
import { ADAPTER as clinePassAdapter } from '../src/provider-usage/clinepass.mjs';
import { ADAPTER as kiloAdapter } from '../src/provider-usage/kilo.mjs';
import { ADAPTER as vercelAiGatewayAdapter } from '../src/provider-usage/vercel-ai-gateway.mjs';

const MODULES = Object.freeze([
  deepSeekAdapter,
  openCodeGoAdapter,
  zhipuAdapter,
  moonshotAdapter,
  miniMaxAdapter,
  syntheticAdapter,
  chutesAdapter,
  openRouterAdapter,
  deepInfraAdapter,
  veniceAdapter,
  ollamaAdapter,
  commandCodeAdapter,
  clinePassAdapter,
  kiloAdapter,
  vercelAiGatewayAdapter,
]);

const ADAPTER_KEYS = ['accepts', 'hosts', 'id', 'metric', 'request'];

test('the registry lists every adapter module exactly once', () => {
  assert.equal(new Set(ADAPTERS).size, ADAPTERS.length, 'the registry repeats an adapter');
  assert.deepEqual(
    ADAPTERS.map((adapter) => adapter.id).sort(),
    MODULES.map((adapter) => adapter.id).sort(),
  );
  for (const adapter of MODULES) {
    assert.ok(ADAPTERS.includes(adapter), `${adapter.id} is not registered`);
  }
});

test('every registered adapter matches the frozen ADAPTER contract', () => {
  for (const adapter of ADAPTERS) {
    assert.equal(typeof adapter.id, 'string', 'adapter id must be a string');
    assert.match(adapter.id, /^[a-z0-9][a-z0-9-]{0,63}$/, `bad adapter id ${adapter.id}`);
    assert.ok(Array.isArray(adapter.hosts), `${adapter.id} hosts must be an array`);
    assert.ok(adapter.hosts.length > 0, `${adapter.id} declares no host`);
    assert.ok(Object.isFrozen(adapter.hosts), `${adapter.id} hosts must be frozen`);
    for (const host of adapter.hosts) {
      assert.equal(typeof host, 'string', `${adapter.id} host must be a string`);
      assert.equal(new URL(`https://${host}`).hostname, host,
        `${adapter.id} host ${host} is not a bare lowercase hostname`);
    }
    assert.equal(typeof adapter.metric, 'string', `${adapter.id} metric must be a string`);
    assert.ok(adapter.metric.length > 0, `${adapter.id} metric is empty`);
    assert.deepEqual(Object.keys(adapter).sort(), ADAPTER_KEYS,
      `${adapter.id} does not expose the contract shape`);
    assert.equal(typeof adapter.accepts, 'function', `${adapter.id} accepts must be a function`);
    assert.equal(typeof adapter.request, 'function', `${adapter.id} request must be a function`);
    assert.ok(Object.isFrozen(adapter), `${adapter.id} ADAPTER must be frozen`);
  }
});

test('adapter ids are unique', () => {
  const seen = new Set();
  for (const adapter of ADAPTERS) {
    assert.ok(!seen.has(adapter.id), `duplicate adapter id ${adapter.id}`);
    seen.add(adapter.id);
  }
});

test('enumerated hosts are pairwise disjoint across adapters', () => {
  // Only the documented `hosts` lists are compared, by exact string. An
  // adapter's extra subdomain rule lives in accepts() (e.g. Chutes accepts any
  // single label under chutes.ai) and is intentionally outside this invariant:
  // the registry must never let two adapters claim the same exact host.
  const owner = new Map();
  for (const adapter of ADAPTERS) {
    for (const host of adapter.hosts) {
      if (owner.has(host)) {
        assert.fail(`host ${host} is claimed by both ${owner.get(host)} and ${adapter.id}`);
      }
      owner.set(host, adapter.id);
    }
  }
});

test('no adapter accepts a look-alike or non-https base URL', () => {
  for (const adapter of ADAPTERS) {
    for (const host of adapter.hosts) {
      assert.equal(
        adapter.accepts({ baseUrl: `https://${host}.evil.example.com/v1` }),
        null,
        `${adapter.id} accepted a look-alike host for ${host}`,
      );
      assert.equal(
        adapter.accepts({ baseUrl: `http://${host}/v1` }),
        null,
        `${adapter.id} accepted a non-https base URL for ${host}`,
      );
    }
  }
});

test('selection is driven by base_url host, not the provider name', () => {
  const config = { baseUrl: 'https://openrouter.ai/api/v1' };
  assert.equal(selectProviderUsageAdapter(config).adapter.id, 'openrouter');
  assert.equal(
    selectProviderUsageAdapter({ baseUrl: 'https://proxy.example.com/api/v1' }),
    null,
  );
  assert.equal(selectProviderUsageAdapter(null), null);
});
