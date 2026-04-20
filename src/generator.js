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
import { generate as providerGenerate, parseModelSpec, apiKeyFor } from './providers/index.js';
import {
  loadTargetReport,
  extractResistedByCategory,
  sampleResistedForCategory,
  buildTargetDefenseContext,
  buildTargetDefenseUserPrompt,
  summarizeReport,
} from './target-defense.js';

const PACKAGE_VERSION = '0.2.2';

// Canonical taxonomy. Source of truth for both the output schema enum
// (what the generator is allowed to emit) and the fallback round-robin
// when the caller doesn't pass --categories.
const TAXONOMY_CATEGORIES = [
  'direct-injection','system-prompt-extraction','role-hijack',
  'prefix-injection','indirect-injection','encoding-tricks',
  'information-leak','tool-coercion','refusal-bypass',
  'delimiter-confusion','authority-claim',
];

const OUTPUT_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      id:              { type: 'string' },
      category:        { type: 'string', enum: TAXONOMY_CATEGORIES },
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

function extractJsonFromText(text) {
  if (!text) throw new Error('Empty response from provider');
  const trimmed = text.trim();
  // Strip Markdown code fences if present (some non-Anthropic providers
  // return ```json ... ``` even with response_format: json_object).
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // If still not pure JSON, try to extract the first {...} block.
  if (!stripped.startsWith('{')) {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  }
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

  // Resolve which provider the caller asked for so we can pull the right
  // API key from env. Bare model IDs default to Anthropic for backward
  // compatibility; "groq:..." prefix routes to the Groq provider for the
  // cross-provider refusal-rate experiment. The dispatcher does its own
  // parse on the full spec — we only parse here to pick the API key.
  const { provider: generatorProvider } = parseModelSpec(model);
  const generatorApiKey = apiKeyFor(generatorProvider, apiKey);

  // Judge stays on Anthropic regardless of generator provider — judge
  // consistency is more important than judge cost, and Haiku is the
  // cheapest reliable judge available.
  const client = new Anthropic({});

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
  // Name-collisions are tracked separately from other rejects. They signal
  // the generator has converged within a category, not that generation is
  // broken — round-robin advances us out naturally. Only terminate if the
  // generator can't produce a novel name across an entire taxonomy pass × 2.
  let consecutiveNameCollisions = 0;

  while (generated.length < count) {
    const totalUsd = genCosts.usd() + judgeCosts.usd();
    if (totalUsd >= maxCostUsd) {
      return summarize({ generated, rejects, genCosts, judgeCosts, stoppedBy: 'cost-cap' });
    }
    if (consecutiveRejects >= 10) {
      return summarize({ generated, rejects, genCosts, judgeCosts, stoppedBy: 'too-many-consecutive-rejections' });
    }
    if (consecutiveNameCollisions >= TAXONOMY_CATEGORIES.length * 2) {
      return summarize({ generated, rejects, genCosts, judgeCosts, stoppedBy: 'name-collision-saturation' });
    }

    // Force server-side round-robin across all categories when the caller
    // didn't restrict. Without this, the generator converges on a single
    // attack family (biased by seed dominance or target-defense emphasis),
    // which produces a non-diverse corpus and triggers name-collision loops.
    const effectiveCategories = categories && categories.length > 0 ? categories : TAXONOMY_CATEGORIES;
    const category = pickCategoryRoundRobin(effectiveCategories, categoryIdx);
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
    // Dispatched to the chosen provider (anthropic | groq). Anthropic uses
    // structured-output schema enforcement; Groq uses response_format json_object
    // with the schema described in the system prompt and downstream quality
    // gate as a backstop.
    let providerResult;
    try {
      providerResult = await providerGenerate({
        apiKey: generatorApiKey,
        model,  // pass the full spec; dispatcher strips the prefix once
        systemPrompt: systemPromptText,
        userPrompt: userPromptText,
        maxTokens: 2000,
        schema: OUTPUT_SCHEMA,
      });
    } catch (err) {
      // Generator-side refusal detection. Some providers (Llama 3.x in particular)
      // refuse certain attack categories at the API layer rather than producing
      // a malformed JSON. Surface as a distinct reject reason so the cross-provider
      // refusal-rate experiment can count them.
      const msg = String(err.message || err);
      if (/refus|cannot|won't|will not|unable to/i.test(msg)) {
        rejects.push({ reason: 'generator-refused', provider: generatorProvider, error: msg.slice(0, 200) });
        consecutiveRejects += 1;
        if (onProgress) onProgress({ type: 'reject', reason: 'generator-refused', costs: snapshotTotal(genCosts, judgeCosts) });
        continue;
      }
      throw err;
    }
    genCosts.add(providerResult.usage || {});

    let attack;
    try {
      attack = extractJsonFromText(providerResult.text);
    } catch (e) {
      // Soft-refusal: provider returned text instead of JSON, often a refusal
      // ("I can't help with that") rather than a parse error per se.
      const refusalLike = /^(I (cannot|can't|won't|will not|am unable|am not able)|Sorry|Unfortunately)/i.test(providerResult.text.trim());
      if (refusalLike) {
        rejects.push({ reason: 'generator-refused', provider: generatorProvider, preview: providerResult.text.slice(0, 200) });
        if (onProgress) onProgress({ type: 'reject', reason: 'generator-refused', preview: providerResult.text.slice(0, 200), costs: snapshotTotal(genCosts, judgeCosts) });
      } else {
        rejects.push({ reason: 'parse-failure', error: e.message, preview: providerResult.text.slice(0, 200) });
        if (onProgress) onProgress({ type: 'reject', reason: 'parse-failure', error: e.message, preview: providerResult.text.slice(0, 200), costs: snapshotTotal(genCosts, judgeCosts) });
      }
      consecutiveRejects += 1;
      continue;
    }

    // --- Pass 0: (category, name) collision ---
    const collision = nameCollides(attack, pool);
    if (collision) {
      rejects.push({ reason: 'name-collision', matchedId: collision.id, category: attack.category, name: attack.name });
      consecutiveNameCollisions += 1;
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
    consecutiveNameCollisions = 0;

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
