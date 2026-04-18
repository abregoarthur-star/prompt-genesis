#!/usr/bin/env node
import { loadCorpus, saveCorpus, generate, mergeCorpora, renumber } from '../src/index.js';

const HELP = `prompt-genesis — adversarial attack corpus generator for prompt-eval

Usage:
  prompt-genesis generate --seed <corpus.json> [options]
  prompt-genesis merge <base.json> <incoming.json> [--out combined.json]

Generate options:
  --seed <path>               Seed corpus (required). JSON array matching prompt-eval's schema.
  --out <path>                Where to write new attacks (default: new-attacks.json)
  --count <n>                 How many attacks to generate (default: 20)
  --categories <a,b,c>        Restrict generation to specific categories (comma-separated)
  --hint "<text>"             Guidance to nudge the generator toward specific angles
  --max-cost-usd <n>          Stop when cost reaches this (default: 1.00)
  --similarity-threshold <n>  Reject candidates with >this similarity (0-1, default: 0.80)
  --model <id>                Generator model override (default: claude-sonnet-4-6)
  --judge-model <id>          Quality-gate judge model (default: claude-haiku-4-5)
  --skip-judge                Skip the quality gate (faster, risks malformed attacks)
  --merge                     Merge into seed corpus and overwrite --seed (preserves original as .bak)
  --quiet                     Suppress per-attack progress

Env:
  ANTHROPIC_API_KEY           Required.

Examples:
  prompt-genesis generate --seed corpus.json --count 50 --out new.json
  prompt-genesis generate --seed corpus.json --categories tool-coercion,role-hijack --count 10
  prompt-genesis generate --seed corpus.json --count 30 --merge
  prompt-genesis merge corpus.json new.json --out combined.json
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const cmd = argv[0];
  if (cmd === 'generate') return runGenerate(argv.slice(1));
  if (cmd === 'merge')    return runMerge(argv.slice(1));

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exit(2);
}

async function runGenerate(args) {
  const opts = parseArgs(args);

  if (!opts.seed) {
    process.stderr.write('generate requires --seed <corpus.json>\n\n' + HELP);
    process.exit(2);
  }

  const seedCorpus = await loadCorpus(opts.seed);
  const categories = opts.categories ? opts.categories.split(',').map(s => s.trim()).filter(Boolean) : null;
  const count = Number.parseInt(opts.count || '20', 10);
  const maxCostUsd = Number.parseFloat(opts.maxCostUsd || '1.00');
  const similarityThreshold = Number.parseFloat(opts.similarityThreshold || '0.80');

  process.stderr.write(
    `prompt-genesis: generating ${count} attacks · ` +
    `seed=${seedCorpus.length} · model=${opts.model || 'claude-sonnet-4-6'} · ` +
    `budget=$${maxCostUsd.toFixed(2)} · dedup>=${similarityThreshold}\n`,
  );

  const onProgress = opts.quiet ? null : ({ type, reason, attack, dupeCheck, matchedId, verdict, costs }) => {
    if (type === 'accept') {
      process.stderr.write(`  ✓ [${attack.category}] ${attack.name}  $${costs.totalUsd.toFixed(4)}\n`);
    } else if (type === 'reject') {
      const marker = '  ✗';
      if (reason === 'dup')             process.stderr.write(`${marker} dup of ${dupeCheck.matchedId} (${(dupeCheck.similarity * 100).toFixed(0)}% similar)\n`);
      else if (reason === 'name-collision') process.stderr.write(`${marker} name collision with ${matchedId}\n`);
      else if (reason === 'quality')    process.stderr.write(`${marker} quality gate: ${verdict.verdict} — ${verdict.reason}\n`);
      else                              process.stderr.write(`${marker} rejected (${reason})\n`);
    }
  };

  const result = await generate({
    seedCorpus,
    count,
    categories,
    maxCostUsd,
    similarityThreshold,
    model: opts.model,
    judgeModel: opts.judgeModel,
    skipJudge: opts.skipJudge,
    hint: opts.hint,
    onProgress,
  });

  const g = result.cost.generator, j = result.cost.judge;
  process.stderr.write(
    `\nDone (${result.stoppedBy}): ${result.attacks.length} attacks, ${result.rejects.length} rejects\n` +
    `Cost: $${result.cost.totalUsd.toFixed(4)} across ${result.cost.calls} API calls ` +
    `(generator $${g.totalUsd.toFixed(4)} · judge $${j.totalUsd.toFixed(4)})\n` +
    `Generator tokens: cache_write=${g.cache_creation_input_tokens} · ` +
    `cache_read=${g.cache_read_input_tokens} · output=${g.output_tokens}\n` +
    `Judge tokens: input=${j.input_tokens} · cache_read=${j.cache_read_input_tokens} · output=${j.output_tokens}\n`,
  );

  if (opts.merge) {
    const { merged, kept, dropped } = mergeCorpora(seedCorpus, result.attacks, { similarityThreshold });
    // Back up original corpus file before overwrite
    const { copyFile } = await import('node:fs/promises');
    await copyFile(opts.seed, opts.seed + '.bak');
    await saveCorpus(opts.seed, merged);
    process.stderr.write(
      `Merged into ${opts.seed} (backup at ${opts.seed}.bak): ` +
      `+${kept.length} kept, ${dropped.length} dropped as duplicate\n`,
    );
  } else {
    const outPath = opts.out || 'new-attacks.json';
    // Preserve content-hash IDs — they make re-runs idempotent and let the
    // `merge` subcommand detect duplicates by ID, not just content.
    await saveCorpus(outPath, result.attacks);
    process.stderr.write(`Wrote ${result.attacks.length} attacks to ${outPath}\n`);
  }
}

async function runMerge(args) {
  const opts = parseArgs(args);
  const [basePath, incomingPath] = opts._;
  if (!basePath || !incomingPath) {
    process.stderr.write('merge requires two positional args: <base.json> <incoming.json>\n');
    process.exit(2);
  }
  const outPath = opts.out || 'merged.json';
  const threshold = Number.parseFloat(opts.similarityThreshold || '0.80');

  const base = await loadCorpus(basePath);
  const incoming = await loadCorpus(incomingPath);
  const { merged, kept, dropped } = mergeCorpora(base, incoming, { similarityThreshold: threshold });
  await saveCorpus(outPath, merged);
  process.stderr.write(
    `Merged → ${outPath}: ${merged.length} total (${kept.length} new kept, ${dropped.length} dropped as duplicate)\n`,
  );
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--seed':                 out.seed = next(); break;
      case '--out':                  out.out = next(); break;
      case '--count':                out.count = next(); break;
      case '--categories':           out.categories = next(); break;
      case '--hint':                 out.hint = next(); break;
      case '--max-cost-usd':         out.maxCostUsd = next(); break;
      case '--similarity-threshold': out.similarityThreshold = next(); break;
      case '--model':                out.model = next(); break;
      case '--judge-model':          out.judgeModel = next(); break;
      case '--skip-judge':            out.skipJudge = true; break;
      case '--merge':                out.merge = true; break;
      case '--quiet':                out.quiet = true; break;
      case '-h':
      case '--help':                 process.stdout.write(HELP); process.exit(0);
      default:
        if (a.startsWith('--')) {
          process.stderr.write(`Unknown arg: ${a}\n`);
          process.exit(2);
        }
        out._.push(a);
    }
  }
  return out;
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  if (process.env.DEBUG) console.error(e);
  process.exit(2);
});
