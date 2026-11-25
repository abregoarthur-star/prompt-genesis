// Anthropic provider — wraps the current SDK call. Default provider for
// backward compatibility with --model <id> (no provider prefix).
//
// Returns the same shape as Groq/OpenAI providers so the generator can
// dispatch uniformly: { text, usage }. Usage is the Anthropic-native
// shape (input_tokens, cache_*, output_tokens) which cost.js already
// understands.

import Anthropic from '@anthropic-ai/sdk';

let _client = null;
function client(apiKey) {
  // Cache the client across calls — same key per process lifetime.
  if (!_client) _client = new Anthropic(apiKey ? { apiKey } : {});
  return _client;
}

export async function generate({ apiKey, model, systemPrompt, userPrompt, maxTokens, schema }) {
  const c = client(apiKey);
  let response;
  try {
    response = await c.messages.create({
      model,
      max_tokens: maxTokens || 8000,
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
      output_config: schema ? { format: schema } : undefined,
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Anthropic API key invalid or missing. Set ANTHROPIC_API_KEY.');
    }
    throw err;
  }

  // A safety classifier can decline to write the attack (HTTP 200,
  // stop_reason "refusal"). Thrown with the word "refused" so the generator
  // counts it as generator-refused, with the usage attached so it is still
  // charged to the run. No fallback model is requested on purpose: this tool
  // measures what a named generator model produces, and a silent switch to
  // another model would corrupt that.
  if (response.stop_reason === 'refusal') {
    const err = new Error(`generator refused (stop_reason refusal, category: ${response.stop_details?.category || 'unspecified'})`);
    err.usage = response.usage || {};
    throw err;
  }

  // Truncated or empty output is returned as it is; the generator's JSON
  // parse rejects it as a parse-failure and moves on.
  const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    text,
    usage: response.usage || {},
    stopReason: response.stop_reason,
  };
}
