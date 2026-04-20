// Public API surface.
import { readFile, writeFile } from 'node:fs/promises';
import { generate as runGenerate } from './generator.js';
import { maxSimilarity } from './dedup.js';

export { generate } from './generator.js';
export { computeCostUsd, createCostTracker, priceFor } from './cost.js';
export { similarity, maxSimilarity } from './dedup.js';
export { buildSystemPrompt, buildUserPrompt, TAXONOMY } from './prompts.js';
export {
  loadTargetReport,
  summarizeReport,
  extractResistedByCategory,
  sampleResistedForCategory,
  buildTargetDefenseContext,
  buildTargetDefenseUserPrompt,
} from './target-defense.js';
export {
  loadEvalReport,
  categoryStats,
  recommend,
  formatRecommendation,
} from './recommend.js';

export async function loadCorpus(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

export async function saveCorpus(path, corpus) {
  await writeFile(path, JSON.stringify(corpus, null, 2) + '\n');
}

// Renumber ids sequentially within each category (matches prompt-eval's
// <category>-NNN convention). Preserves existing ids that already match
// the convention; renumbers anything else.
export function renumber(corpus) {
  const counters = new Map();
  return corpus.map(attack => {
    const cat = attack.category;
    const n = (counters.get(cat) || 0) + 1;
    counters.set(cat, n);
    return {
      ...attack,
      id: `${cat}-${String(n).padStart(3, '0')}`,
    };
  });
}

// Merge two corpora. Seed wins (curated wording is battle-tested):
//   - Incoming entries whose ID already exists in `base` are dropped.
//   - Incoming entries whose prompt is too similar to any base prompt are
//     dropped (the base entry stays — its hand-curated phrasing wins).
// Preserves original IDs on both sides. Call renumber() separately if you
// want a sequential-numbered corpus.
export function mergeCorpora(base, incoming, { similarityThreshold = 0.80 } = {}) {
  const merged = [...base];
  const existingIds = new Set(base.map(a => a.id));
  const kept = [];
  const dropped = [];
  for (const attack of incoming) {
    // Dedup-by-ID (content-hash idempotency): same payload re-generated
    // across runs produces the same `gen-<sha>` ID.
    if (existingIds.has(attack.id)) {
      dropped.push({ ...attack, _droppedBecauseDuplicateId: attack.id });
      continue;
    }
    // Dedup-by-similarity: seed's curated phrasing wins.
    const match = maxSimilarity(attack.prompt, merged);
    if (match.similarity >= similarityThreshold) {
      dropped.push({ ...attack, _droppedBecauseSimilarTo: match.matchedId, _similarity: match.similarity });
      continue;
    }
    merged.push(attack);
    existingIds.add(attack.id);
    kept.push(attack);
  }
  return { merged, kept, dropped };
}
