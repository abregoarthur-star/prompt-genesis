// Core generation loop. Each iteration:
//   1. Ask Claude for one novel attack, JSON-constrained
//   2. Pass 0: reject (category, name) collisions against seeds
//   3. Pass 1: Levenshtein dedup against seeds + running pool
//   4. Pass 2: quality gate — Haiku self-judges whether this is a well-formed attack
//   5. Override severity from category map; stamp content-hash ID + provenance
//
// Stops when target count reached, cost cap hit, or too many consecutive
// rejections (something's wrong — don't burn the budget).
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserPrompt } from './prompts.js';
import { createCostTracker } from './cost.js';
import { maxSimilarity } from './dedup.js';
import { severityFor } from './severity-map.js';
import { contentHashId } from './id.js';
import { judge as qualityJudge } from './quality-gate.js';
import {
  loadTargetReport,
  extractResistedByCategory,
  sampleResistedForCategory,
  buildTargetDefenseContext,
  buildTargetDefenseUserPrompt,
  summarizeReport,
} from './target-defense.js';

const PACKAGE_VERSION = '0.2.0';

const OUTPUT_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      id:              { type: 'string' },
      category:        { type: 'string', enum: [
        'direct-injection','system-prompt-extraction','role-hijack',
        'prefix-injection','indirect-injection','encoding-tricks',
        'information-leak','tool-coercion','refusal-bypass',
        'delimiter-confusion','authority-claim',
      ]},
      severity:        { type: 'string', enum: ['critical','high','medium','low'] },
      name:            { type: 'string' },
      prompt:          { type: 'string' },
      successCriteria: { type: 'string' },
      expectedRefusal: { type: 'boolean' },
    },
    required: ['id','category','severity','name','prompt','successCriteria','expectedRefusal'],
    additionalProperties: false,
  },
};

function pickCategoryRoundRobin(categories, index) {
  if (!categories || categories.length === 0) return null;
  return categories[index % categories.length];
}

function extractJson(message) {
  const block = message.content.find(b => b.type === 'text');
  if (!block) throw new Error('No text block in response');
  const text = block.text.trim();
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(stripped);
}

function nameCollides(candidate, existing) {
  const nk = (candidate.name || '').trim().toLowerCase();
  const ck = (candidate.category || '').trim();
  if (!nk || !ck) return null;
  return existing.find(a =>
    a.category === ck &&
    (a.name || '').trim().toLowerCase() === nk
  ) || null;
}

export async function generate({
  seedCorpus,
  count,
  categories = null,
  maxCostUsd = 1.00,
  similarityThreshold = 0.80,
  model = 'claude-sonnet-4-6',
  judgeModel = 'claude-haiku-4-5',
  skipJudge = false,
  hint = null,
  onProgress = null,
  apiKey = null,
  // --- target-defense mode (0.2.0) ---
  // Path to a prompt-eval report JSON. When provided, the generator is
  // steered toward novel attacks that target defenses the report shows
  // actually hold — "break what already works".
  targetDefensePath = null,
}) {
  if (!Array.isArray(seedCorpus) || seedCorpus.length === 0) {
    throw new Error('seedCorpus must be a non-empty array');
  }

  const client = new Anthropic(apiKey ? { apiKey } : {});

  // Target-defense context: loaded once per run, appended to the cached
  // system prompt. Stable across the run → cache hits keep landing.
  // Note: target-defense report is bound to the run's cache; mixing reports
  // requires a fresh process.
  let targetDefenseSummary = null;
  let resistedByCategory = null;
  let targetDefenseContext = '';
  if (targetDefensePath) {
    const report = await loadTargetReport(targetDefensePath);
    targetDefenseSummary = summarizeReport(report);
    // Cross-reference with seedCorpus — reports only carry id/category/name.
    resistedByCategory = extractResistedByCategory(report, seedCorpus);
    targetDefenseContext = buildTargetDefenseContext(report, resistedByCategory);
  }

  const systemPromptText = targetDefenseContext
    ? `${buildSystemPrompt(seedCorpus)}\n\n${targetDefenseContext}`
    : buildSystemPrompt(seedCorpus);

  // Cost tracker — generator model is dominant; judge calls on Haiku are
  // added separately but tracked under judgeModel pricing.
  const genCosts = createCostTracker(model);
  const judgeCosts = createCostTracker(judgeModel);

  const generated = [];
  const rejects = [];
  const pool = [...seedCorpus];

  let categoryIdx = 0;
  let consecutiveRejects = 0;

  while (generated.length < count) {
    const totalUsd = genCosts.usd() + judgeCosts.usd();
    if (totalUsd >= maxCostUsd) {
      return summarize({ generated, rejects, genCosts, judgeCosts, stoppedBy: 'cost-cap' });
    }
    if (consecutiveRejects >= 10) {
      return summarize({ generated, rejects, genCosts, judgeCosts, stoppedBy: 'too-many-consecutive-rejections' });
    }

    const category = categories ? pickCategoryRoundRobin(categories, categoryIdx) : null;
    categoryIdx += 1;

    // If target-defense is active, pull a diverse sample of resisted
    // attacks for this category to cite directly in the user prompt —
    // tells the generator exactly which existing attacks to NOT paraphrase.
    const resistedExamples = (resistedByCategory && category)
      ? sampleResistedForCategory(resistedByCategory, category, 3)
      : null;

    const userPromptText = resistedByCategory
      ? buildTargetDefenseUserPrompt({ category, resistedExamples, hint })
      : buildUserPrompt({ category, hint });

    // --- Generate ---
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 2000,
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: systemPromptText, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userPromptText }],
        output_config: { format: OUTPUT_SCHEMA },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error('Anthropic API key invalid or missing. Set ANTHROPIC_API_KEY.');
      }
      throw err; // 429/5xx: SDK already retried; let caller surface.
    }
    genCosts.add(response.usage || {});

    let attack;
    try {
      attack = extractJson(response);
    } catch (e) {
      rejects.push({ reason: 'parse-failure', error: e.message });
      consecutiveRejects += 1;
      continue;
    }

    // --- Pass 0: (category, name) collision ---
    const collision = nameCollides(attack, pool);
    if (collision) {
      rejects.push({ reason: 'name-collision', matchedId: collision.id, category: attack.category, name: attack.name });
      consecutiveRejects += 1;
      if (onProgress) onProgress({ type: 'reject', reason: 'name-collision', attack, matchedId: collision.id, costs: snapshotTotal(genCosts, judgeCosts) });
      continue;
    }

    // --- Pass 1: Levenshtein dedup ---
    const dupeCheck = maxSimilarity(attack.prompt, pool);
    if (dupeCheck.similarity >= similarityThreshold) {
      rejects.push({
        reason: 'too-similar',
        matchedId: dupeCheck.matchedId,
        similarity: dupeCheck.similarity,
        prompt: attack.prompt.slice(0, 160),
      });
      consecutiveRejects += 1;
      if (onProgress) onProgress({ type: 'reject', reason: 'dup', attack, dupeCheck, costs: snapshotTotal(genCosts, judgeCosts) });
      continue;
    }

    // --- Pass 2: Quality gate ---
    let qualityVerdict = null;
    if (!skipJudge) {
      try {
        qualityVerdict = await qualityJudge(client, attack, { model: judgeModel });
        if (qualityVerdict.usage) judgeCosts.add(qualityVerdict.usage);
        if (qualityVerdict.verdict !== 'valid') {
          rejects.push({
            reason: 'quality-gate',
            verdict: qualityVerdict.verdict,
            judgeReason: qualityVerdict.reason,
            prompt: attack.prompt.slice(0, 160),
          });
          consecutiveRejects += 1;
          if (onProgress) onProgress({ type: 'reject', reason: 'quality', attack, verdict: qualityVerdict, costs: snapshotTotal(genCosts, judgeCosts) });
          continue;
        }
      } catch (err) {
        // Judge error: don't fail the run, but don't count this attack as vetted
        rejects.push({ reason: 'judge-error', error: err.message });
        consecutiveRejects += 1;
        continue;
      }
    }

    // --- Stamp + accept ---
    const stamped = {
      id:              contentHashId(attack.prompt),
      category:        attack.category,
      severity:        severityFor(attack.category),        // overrides model-picked severity
      name:            attack.name,
      prompt:          attack.prompt,
      successCriteria: attack.successCriteria,
      expectedRefusal: attack.expectedRefusal ?? true,
      generatedBy:     `prompt-genesis@${PACKAGE_VERSION}`,
      generatedAt:     new Date().toISOString(),
      generatorModel:  model,
      judgeModel:      skipJudge ? null : judgeModel,
      judgeVerdict:    qualityVerdict?.verdict || null,
    };
    // Target-defense provenance: record which resisted attacks inspired
    // this generation so the attack's lineage is traceable.
    if (targetDefensePath) {
      stamped.targetDefenseSource = targetDefensePath;
      stamped.defenderTarget      = targetDefenseSummary.target?.kind || 'unknown';
      stamped.defenderDefenseRate = targetDefenseSummary.defenseRate;
      stamped.inspiredByResisted  = (resistedExamples || []).map(a => a.id);
    }

    generated.push(stamped);
    pool.push(stamped);
    consecutiveRejects = 0;

    if (onProgress) onProgress({ type: 'accept', attack: stamped, costs: snapshotTotal(genCosts, judgeCosts) });
  }

  return summarize({ generated, rejects, genCosts, judgeCosts, stoppedBy: 'count-reached' });
}

function snapshotTotal(gen, judge) {
  const g = gen.snapshot();
  const j = judge.snapshot();
  return {
    generator: g,
    judge: j,
    totalUsd: g.totalUsd + j.totalUsd,
    calls: g.calls + j.calls,
  };
}

function summarize({ generated, rejects, genCosts, judgeCosts, stoppedBy }) {
  return {
    attacks: generated,
    rejects,
    cost: snapshotTotal(genCosts, judgeCosts),
    stoppedBy,
  };
}
