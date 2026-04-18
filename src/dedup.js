// Reject near-duplicate attack prompts. Uses Levenshtein-based normalized
// similarity as a cheap first pass; a future version may add embedding-based
// semantic dedup.

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length, n = b.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j]     + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

// Returns the highest similarity between `candidate.prompt` and any prompt
// in `existing`. If above `threshold`, the candidate is a duplicate.
export function maxSimilarity(candidatePrompt, existingAttacks) {
  let max = 0;
  let matchedId = null;
  for (const a of existingAttacks) {
    const s = similarity(candidatePrompt, a.prompt);
    if (s > max) { max = s; matchedId = a.id; }
  }
  return { similarity: max, matchedId };
}
