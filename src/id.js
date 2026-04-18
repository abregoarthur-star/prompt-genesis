// Content-hashed IDs for generated attacks. Same prompt → same ID, across
// runs. Makes merging idempotent and keeps IDs stable when the same attack
// is (re)generated independently.
import { createHash } from 'node:crypto';

export function contentHashId(promptText) {
  const sha = createHash('sha256')
    .update(promptText)
    .digest('hex')
    .slice(0, 8);
  return `gen-${sha}`;
}
