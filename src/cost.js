// Track API cost across generation calls. Prices are $/1M tokens.
// Cache reads cost ~0.1×; cache writes cost 1.25× for the 5-minute TTL default.
// Anthropic numbers as of 2026-11. Haiku 5.5 is priced for prompts up to 100K
// tokens ($0.50 / $2.50 beyond that, which these runs never reach).
// Groq numbers per https://groq.com/pricing as of 2026-04 (no caching).

const PRICING = {
  // Anthropic (cache-aware)
  'claude-fable-5-2':  { input: 8.00, cacheWrite5m: 10.00, cacheRead: 0.20, output: 40.00 },
  'claude-opus-5-5':   { input: 4.00, cacheWrite5m: 5.00, cacheRead: 0.20, output: 20.00 },
  'claude-sonnet-5-5': { input: 2.00, cacheWrite5m: 2.50, cacheRead: 0.10, output: 10.00 },
  'claude-haiku-5-5':  { input: 0.10, cacheWrite5m: 0.125, cacheRead: 0.01, output:  0.50 },
  'claude-opus-4-7':   { input: 5.00, cacheWrite5m: 6.25, cacheRead: 0.50, output: 25.00 },
  'claude-opus-4-6':   { input: 5.00, cacheWrite5m: 6.25, cacheRead: 0.50, output: 25.00 },
  'claude-sonnet-4-6': { input: 3.00, cacheWrite5m: 3.75, cacheRead: 0.30, output: 15.00 },
  'claude-haiku-4-5':  { input: 1.00, cacheWrite5m: 1.25, cacheRead: 0.10, output:  5.00 },
  // Groq (no caching; rate-limited free tier means real spend is often $0)
  'llama-3.3-70b-versatile':                     { input: 0.59, cacheWrite5m: 0, cacheRead: 0, output: 0.79 },
  'llama-3.1-8b-instant':                        { input: 0.05, cacheWrite5m: 0, cacheRead: 0, output: 0.08 },
  'meta-llama/llama-4-scout-17b-16e-instruct':   { input: 0.18, cacheWrite5m: 0, cacheRead: 0, output: 0.59 },
};

// Accept "<provider>:<model-id>" or bare "<model-id>". Strip provider prefix
// to look up pricing — model ID alone is the pricing key.
export function priceFor(model) {
  const id = typeof model === 'string' && model.includes(':') ? model.split(':').slice(1).join(':') : model;
  // An unknown model is priced at the highest rate in the table, so a cost cap
  // stops early instead of late.
  return PRICING[id] || PRICING['claude-fable-5-2'];
}

export function computeCostUsd(model, usage) {
  const p = priceFor(model);
  const million = 1_000_000;
  const input        = (usage.input_tokens || 0)                * p.input        / million;
  const cacheWrite   = (usage.cache_creation_input_tokens || 0) * p.cacheWrite5m / million;
  const cacheRead    = (usage.cache_read_input_tokens || 0)     * p.cacheRead    / million;
  const output       = (usage.output_tokens || 0)               * p.output       / million;
  return input + cacheWrite + cacheRead + output;
}

export function createCostTracker(model) {
  const totals = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  let totalUsd = 0;
  let calls = 0;

  return {
    add(usage) {
      totals.input_tokens                += usage.input_tokens                || 0;
      totals.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
      totals.cache_read_input_tokens     += usage.cache_read_input_tokens     || 0;
      totals.output_tokens               += usage.output_tokens               || 0;
      totalUsd += computeCostUsd(model, usage);
      calls += 1;
    },
    snapshot() {
      return { ...totals, totalUsd, calls };
    },
    usd: () => totalUsd,
    calls: () => calls,
  };
}
