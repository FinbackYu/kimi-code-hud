import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateProviderSessionCost,
  resolveProviderCostTarget,
} from '../src/provider-cost.mjs';

function config({ openAIBase = 'https://api.openai.com/v1', anthropicBase = null } = {}) {
  return `
[providers.deepseek]
type = "openai"
base_url = "https://api.deepseek.com"
api_key = "redacted-deepseek-key"

[providers.openai]
type = "openai_responses"
base_url = "${openAIBase}"
api_key = "redacted-openai-key"

[providers.anthropic]
type = "anthropic"
${anthropicBase === null ? '' : `base_url = "${anthropicBase}"`}
api_key = "redacted-anthropic-key"

[models."openai/gpt-5.6"]
provider = "openai"
model = "gpt-5.6"
display_name = "GPT-5.6"

[models."anthropic/sonnet-5"]
provider = "anthropic"
model = "claude-sonnet-5"
display_name = "Claude Sonnet 5"

[models."anthropic/unknown"]
provider = "anthropic"
model = "claude-future-9"

[models."deepseek/flash"]
provider = "deepseek"
model = "deepseek-v4-flash"

[models."deepseek/pro"]
provider = "deepseek"
model = "deepseek-v4-pro"
`;
}

function modelUsage(byModel) {
  return { scope: 'session', agents: 'all', byModel };
}

const TOKENS = {
  inputOther: 1_000,
  inputCacheRead: 2_000,
  inputCacheCreation: 100,
  output: 500,
};

test('cost targets require official direct DeepSeek, OpenAI, or Anthropic API bases', () => {
  const text = config();
  assert.deepEqual(resolveProviderCostTarget({ provider: 'deepseek', configText: text }), {
    provider: 'deepseek', adapter: 'deepseek-local-cost', label: 'DeepSeek',
  });
  assert.deepEqual(resolveProviderCostTarget({ provider: 'openai', configText: text }), {
    provider: 'openai', adapter: 'openai-local-cost', label: 'OpenAI',
  });
  assert.deepEqual(resolveProviderCostTarget({ provider: 'anthropic', configText: text }), {
    provider: 'anthropic', adapter: 'anthropic-local-cost', label: 'Anthropic',
  });
  assert.equal(resolveProviderCostTarget({
    provider: 'openai', configText: config({ openAIBase: 'https://proxy.example/v1' }),
  }), null);
  assert.equal(resolveProviderCostTarget({
    provider: 'anthropic', configText: config({ anthropicBase: 'https://api.anthropic.com.evil' }),
  }), null);
  assert.equal(resolveProviderCostTarget({
    provider: 'anthropic', configText: text, env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
  }), null);
  assert.equal(resolveProviderCostTarget({
    provider: 'deepseek',
    configText: text.replace('https://api.deepseek.com', 'https://deepseek-proxy.example'),
  }), null);
});

test('DeepSeek session cost follows the balance currency and its official V4 rates', () => {
  const configText = config();
  const target = resolveProviderCostTarget({ provider: 'deepseek', configText });
  const usage = modelUsage({
    'deepseek/flash': {
      inputOther: 1_000_000,
      inputCacheRead: 1_000_000,
      inputCacheCreation: 1_000_000,
      output: 1_000_000,
    },
    'deepseek/pro': {
      inputOther: 1_000_000,
      inputCacheRead: 1_000_000,
      inputCacheCreation: 0,
      output: 1_000_000,
    },
  });
  const cny = estimateProviderSessionCost({
    target,
    configText,
    modelUsage: usage,
    currency: 'CNY',
  });
  assert.equal(cny.label, 'DeepSeek');
  assert.equal(cny.currency, 'CNY');
  assert.ok(Math.abs(cny.amount - 13.045) < 1e-12);

  const usd = estimateProviderSessionCost({
    target, configText, modelUsage: usage, currency: 'USD',
  });
  assert.equal(usd.currency, 'USD');
  assert.ok(Math.abs(usd.amount - 1.871425) < 1e-12);
  assert.equal(estimateProviderSessionCost({
    target, configText, modelUsage: usage,
  }), null);
});

test('OpenAI session cost uses official input, cache, cache-write, and output rates', () => {
  const configText = config();
  const target = resolveProviderCostTarget({ provider: 'openai', configText });
  const cost = estimateProviderSessionCost({
    target,
    configText,
    modelUsage: modelUsage({ 'openai/gpt-5.6': TOKENS }),
  });
  assert.equal(cost.kind, 'cost');
  assert.equal(cost.label, 'OpenAI');
  assert.equal(cost.scope, 'session');
  assert.equal(cost.estimated, true);
  assert.ok(Math.abs(cost.amount - 0.021625) < 1e-12);
});

test('Anthropic session cost follows the dated Sonnet 5 introductory price', () => {
  const configText = config();
  const target = resolveProviderCostTarget({ provider: 'anthropic', configText });
  const usage = modelUsage({
    'anthropic/sonnet-5': {
      inputOther: 1_000,
      inputCacheRead: 1_000,
      inputCacheCreation: 1_000,
      output: 1_000,
    },
  });
  const promo = estimateProviderSessionCost({
    target, configText, modelUsage: usage, now: Date.UTC(2026, 7, 31),
  });
  const standard = estimateProviderSessionCost({
    target, configText, modelUsage: usage, now: Date.UTC(2026, 8, 1),
  });
  assert.ok(Math.abs(promo.amount - 0.0147) < 1e-12);
  assert.ok(Math.abs(standard.amount - 0.02205) < 1e-12);
});

test('cost estimation fails closed on unknown models or partial ledgers', () => {
  const configText = config();
  const target = resolveProviderCostTarget({ provider: 'anthropic', configText });
  assert.equal(estimateProviderSessionCost({
    target,
    configText,
    modelUsage: modelUsage({ 'anthropic/unknown': TOKENS }),
  }), null);
  assert.equal(estimateProviderSessionCost({
    target,
    configText,
    modelUsage: { scope: 'session', agents: 'main', byModel: {} },
  }), null);
});

test('cost estimation fails closed instead of undercounting a mixed-provider session', () => {
  const configText = config();
  const target = resolveProviderCostTarget({ provider: 'openai', configText });
  assert.equal(estimateProviderSessionCost({
    target,
    configText,
    modelUsage: modelUsage({
      'openai/gpt-5.6': TOKENS,
      'anthropic/sonnet-5': TOKENS,
    }),
  }), null);
  assert.equal(estimateProviderSessionCost({
    target,
    configText,
    modelUsage: modelUsage({
      'openai/gpt-5.6': TOKENS,
      'unconfigured/subagent-model': TOKENS,
    }),
  }), null);
});

test('zero-token rows from another provider do not hide a complete active-provider cost', () => {
  const configText = config();
  const target = resolveProviderCostTarget({ provider: 'openai', configText });
  const cost = estimateProviderSessionCost({
    target,
    configText,
    modelUsage: modelUsage({
      'openai/gpt-5.6': TOKENS,
      'anthropic/sonnet-5': {
        inputOther: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        output: 0,
      },
    }),
  });
  assert.ok(Math.abs(cost.amount - 0.021625) < 1e-12);
});
