// Groq provider — OpenAI-compatible chat completions API. Used as a
// non-Claude generator for the cross-provider refusal-rate experiment
// (Addendum 3 / Addendum 8 of the design memo): measure which generators
// refuse to write which attack categories. Hypothesis: Claude-as-generator
// refuses to write the very attacks it was trained to resist; open-weights
// generators (Llama on Groq) have different RLHF curves and will produce
// attacks Claude won't even attempt.
//
// Same retry pattern as the prompt-eval Groq target adapter — Groq's free
// tier rate-limits (12000 TPM on Llama 3.3 70B) and returns precise retry
// hints in the error body.
//
// Schema enforcement: Groq doesn't have Anthropic's output_config structured
// output, so we pass the schema as a JSON-mode hint and parse the text.
// Less strict than Anthropic; quality gate downstream catches malformed.

const MAX_RETRIES = 5;

export async function generate({ apiKey, model, systemPrompt, userPrompt, maxTokens, schema }) {
  if (!apiKey) throw new Error('Groq provider requires GROQ_API_KEY env var');

  // Append the schema requirements to the user prompt — Groq's response_format:
  // {type: 'json_object'} guarantees JSON, but doesn't enforce a specific schema.
  // We rely on the system prompt's existing schema instructions plus the quality
  // gate to filter malformed output.
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens || 2000,
        temperature: 0.7,
        response_format: schema ? { type: 'json_object' } : undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      // Normalize Groq's usage shape to Anthropic's so cost.js works uniformly.
      const u = data.usage || {};
      return {
        text,
        usage: {
          input_tokens:                u.prompt_tokens     || 0,
          output_tokens:               u.completion_tokens || 0,
          cache_creation_input_tokens: 0, // Groq doesn't have prompt caching
          cache_read_input_tokens:     0,
        },
      };
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const body = await res.text();
      const m = body.match(/try again in ([\d.]+)(ms|s)/);
      const waitMs = m ? (m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1])) : 1000;
      await new Promise(r => setTimeout(r, waitMs + 250));
      continue;
    }

    throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error(`Groq: exceeded ${MAX_RETRIES} retries on rate limit`);
}
