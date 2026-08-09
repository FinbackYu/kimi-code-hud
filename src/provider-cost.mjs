import {
  resolveModelConfig,
  resolveProviderConfig,
} from './model-config.mjs';

export const PROVIDER_COST_PRICING_AS_OF = '2026-08-09';

// Official standard text-token prices checked against:
// https://api-docs.deepseek.com/quick_start/pricing
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// https://developers.openai.com/api/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing

const OPENAI_TYPES = new Set(['openai', 'openai_responses']);
const SONNET_5_PROMO_END_MS = Date.UTC(2026, 8, 1);
const MILLION = 1_000_000;

const DEEPSEEK_PRICES = new Map([
  ['CNY', deepSeekPriceTable(price(1, 0.02, 1, 2), price(3, 0.025, 3, 6))],
  ['USD', deepSeekPriceTable(price(0.14, 0.0028, 0.14, 0.28), price(0.435, 0.003625, 0.435, 0.87))],
]);

// Kimi Code's current OpenAI-compatible usage normalizer does not yet map
// DeepSeek's prompt_cache_hit_tokens field. Until the host exposes that split,
// those prompt tokens arrive as inputOther and are conservatively priced as
// cache misses; inputCacheRead is honored whenever a future host supplies it.

const OPENAI_PRICES = new Map([
  ['gpt-5.6', price(5, 0.5, 6.25, 30)],
  ['gpt-5.6-sol', price(5, 0.5, 6.25, 30)],
  ['gpt-5.6-terra', price(2, 0.2, 2.5, 12)],
  ['gpt-5.6-luna', price(0.2, 0.02, 0.25, 1.2)],
]);

const ANTHROPIC_PRICES = new Map([
  ['claude-fable-5', price(10, 1, 12.5, 50)],
  ['claude-mythos-5', price(10, 1, 12.5, 50)],
  ['claude-opus-5', price(5, 0.5, 6.25, 25)],
  ['claude-opus-4-8', price(5, 0.5, 6.25, 25)],
  ['claude-opus-4-7', price(5, 0.5, 6.25, 25)],
  ['claude-opus-4-6', price(5, 0.5, 6.25, 25)],
  ['claude-opus-4-5', price(5, 0.5, 6.25, 25)],
  ['claude-opus-4-5-20251101', price(5, 0.5, 6.25, 25)],
  ['claude-opus-4-1', price(15, 1.5, 18.75, 75)],
  ['claude-opus-4-1-20250805', price(15, 1.5, 18.75, 75)],
  ['claude-opus-4', price(15, 1.5, 18.75, 75)],
  ['claude-opus-4-20250514', price(15, 1.5, 18.75, 75)],
  ['claude-sonnet-4-6', price(3, 0.3, 3.75, 15)],
  ['claude-sonnet-4-5', price(3, 0.3, 3.75, 15)],
  ['claude-sonnet-4-5-20250929', price(3, 0.3, 3.75, 15)],
  ['claude-sonnet-4', price(3, 0.3, 3.75, 15)],
  ['claude-sonnet-4-20250514', price(3, 0.3, 3.75, 15)],
  ['claude-haiku-4-5', price(1, 0.1, 1.25, 5)],
  ['claude-haiku-4-5-20251001', price(1, 0.1, 1.25, 5)],
  ['claude-3-5-haiku-latest', price(0.8, 0.08, 1, 4)],
  ['claude-3-5-haiku-20241022', price(0.8, 0.08, 1, 4)],
]);

function price(input, cacheRead, cacheWrite, output) {
  return { input, cacheRead, cacheWrite, output };
}

function deepSeekPriceTable(flash, pro) {
  return new Map([
    ['deepseek-v4-flash', flash],
    ['deepseek-v4-pro', pro],
    // The official pricing page maps both compatibility names to V4 Flash.
    ['deepseek-chat', flash],
    ['deepseek-reasoner', flash],
  ]);
}

function officialBaseUrl(value, hostname, allowedPaths) {
  if (value === null) return true;
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.protocol === 'https:'
      && parsed.hostname === hostname
      && (parsed.port === '' || parsed.port === '443')
      && allowedPaths.has(pathname)
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function providerCostAdapter(config, env = {}) {
  const openAIBaseUrl = config.baseUrl ?? env.OPENAI_BASE_URL ?? null;
  const anthropicBaseUrl = config.baseUrl ?? env.ANTHROPIC_BASE_URL ?? null;
  if (
    config.provider === 'deepseek'
    && config.type === 'openai'
    && config.baseUrl !== null
    && officialBaseUrl(config.baseUrl, 'api.deepseek.com', new Set(['', '/v1']))
  ) {
    return {
      adapter: 'deepseek-local-cost', label: 'DeepSeek', pricing: deepSeekPrice,
      currencies: new Set(['CNY', 'USD']),
    };
  }
  if (
    OPENAI_TYPES.has(config.type)
    && officialBaseUrl(openAIBaseUrl, 'api.openai.com', new Set(['', '/v1']))
  ) {
    return {
      adapter: 'openai-local-cost', label: 'OpenAI', pricing: openAIPrice,
      currency: 'USD',
    };
  }
  if (
    config.type === 'anthropic'
    && officialBaseUrl(anthropicBaseUrl, 'api.anthropic.com', new Set(['', '/v1']))
  ) {
    return {
      adapter: 'anthropic-local-cost', label: 'Anthropic', pricing: anthropicPrice,
      currency: 'USD',
    };
  }
  return null;
}

function deepSeekPrice(model, _now, currency) {
  return DEEPSEEK_PRICES.get(currency)?.get(model) || null;
}

function openAIPrice(model) {
  return OPENAI_PRICES.get(model) || null;
}

function anthropicPrice(model, now) {
  if (model === 'claude-sonnet-5') {
    return now < SONNET_5_PROMO_END_MS
      ? price(2, 0.2, 2.5, 10)
      : price(3, 0.3, 3.75, 15);
  }
  return ANTHROPIC_PRICES.get(model) || null;
}

function validTokens(usage) {
  return usage
    && typeof usage === 'object'
    && ['inputOther', 'inputCacheRead', 'inputCacheCreation', 'output']
      .every((field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0);
}

function costForTokens(usage, pricing) {
  return (
    usage.inputOther * pricing.input
    + usage.inputCacheRead * pricing.cacheRead
    + usage.inputCacheCreation * pricing.cacheWrite
    + usage.output * pricing.output
  ) / MILLION;
}

/** Resolve an official direct API provider into a secret-free local-cost target. */
export function resolveProviderCostTarget({ provider, configText, env = {} } = {}) {
  const config = resolveProviderConfig({ provider, configText });
  if (!config) return null;
  const adapter = providerCostAdapter(config, env);
  if (!adapter) return null;
  return {
    provider,
    adapter: adapter.adapter,
    label: adapter.label,
  };
}

/**
 * Price the complete all-agent usage ledger for the active provider. Unknown
 * models fail closed so the HUD never presents a partial total as the session
 * cost. Standard text-token pricing is used; provider-side tools, negotiated
 * discounts, regional/fast/batch tiers, and taxes are intentionally excluded.
 */
export function estimateProviderSessionCost({
  target,
  modelUsage,
  configText,
  env = {},
  currency = null,
  now = Date.now(),
} = {}) {
  if (
    !target
    || !modelUsage
    || modelUsage.scope !== 'session'
    || modelUsage.agents !== 'all'
    || !modelUsage.byModel
    || typeof modelUsage.byModel !== 'object'
  ) {
    return null;
  }
  const config = resolveProviderConfig({ provider: target.provider, configText });
  const adapter = config ? providerCostAdapter(config, env) : null;
  if (!adapter || adapter.adapter !== target.adapter || adapter.label !== target.label) return null;
  const costCurrency = adapter.currency
    || (adapter.currencies?.has(currency) ? currency : null);
  if (!costCurrency) return null;

  let amount = 0;
  let matched = 0;
  for (const [usageModel, usage] of Object.entries(modelUsage.byModel)) {
    if (!validTokens(usage)) return null;
    const model = resolveModelConfig({ name: usageModel, configText });
    if (!model || model.provider !== target.provider) continue;
    if (!model.model) return null;
    const pricing = adapter.pricing(model.model, now, costCurrency);
    if (!pricing) return null;
    amount += costForTokens(usage, pricing);
    matched += 1;
  }
  if (matched === 0 || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    kind: 'cost',
    label: adapter.label,
    scope: 'session',
    currency: costCurrency,
    amount,
    estimated: true,
    pricingAsOf: PROVIDER_COST_PRICING_AS_OF,
  };
}
