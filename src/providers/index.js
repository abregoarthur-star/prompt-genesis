// Provider dispatcher. Routes generation calls to the correct backend
// based on a `--model <provider>:<id>` syntax (or bare `<id>` for backward
// compatibility — defaults to Anthropic).
//
// Each provider exposes the same async generate({ apiKey, model, systemPrompt,
// userPrompt, maxTokens, schema }) → { text, usage } interface. Usage is
// normalized to Anthropic's shape so cost.js works uniformly.

import * as anthropic from './anthropic.js';
import * as groq from './groq.js';

const PROVIDERS = { anthropic, groq };

// Parse "groq:llama-3.3-70b-versatile" → { provider: 'groq', model: 'llama-3.3-70b-versatile' }
// Parse "claude-sonnet-4-6"           → { provider: 'anthropic', model: 'claude-sonnet-4-6' }
// Parse "openai/gpt-4o" via prefix    → not yet supported, throws clearly
export function parseModelSpec(spec) {
  if (!spec || typeof spec !== 'string') {
    throw new Error('model spec must be a non-empty string');
  }
  // Provider prefix uses ':' as separator. Split only on the FIRST colon —
  // some model IDs contain colons (e.g., HuggingFace org/model:tag).
  const idx = spec.indexOf(':');
  if (idx > 0) {
    const provider = spec.slice(0, idx);
    const model = spec.slice(idx + 1);
    if (!PROVIDERS[provider]) {
      throw new Error(
        `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}. ` +
        `Use "<provider>:<model-id>" e.g. "groq:llama-3.3-70b-versatile".`
      );
    }
    return { provider, model };
  }
  // Bare model id → default to anthropic for backward compatibility
  return { provider: 'anthropic', model: spec };
}

export function apiKeyFor(provider, override) {
  if (override) return override;
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
  if (provider === 'groq')      return process.env.GROQ_API_KEY;
  return null;
}

export async function generate(opts) {
  const { provider, model } = parseModelSpec(opts.model);
  const impl = PROVIDERS[provider];
  return impl.generate({ ...opts, model });
}
