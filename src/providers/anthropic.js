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
      max_tokens: maxTokens || 2000,
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

  const block = (response.content || []).find(b => b.type === 'text');
  if (!block) throw new Error('Anthropic returned no text block');
  return {
    text: block.text,
    usage: response.usage || {},
  };
}
