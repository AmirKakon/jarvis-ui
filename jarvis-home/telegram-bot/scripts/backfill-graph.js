/**
 * One-time backfill: populate the knowledge graph from existing memory_facts.
 *
 * For every fact that is not yet linked to any entity, run triple extraction
 * and upsert entities/relations/fact_entities. Safe to re-run — already-linked
 * facts are skipped and entity/relation upserts are idempotent.
 *
 * Usage (from telegram-bot/):
 *   node scripts/backfill-graph.js            # backfill all unlinked facts
 *   node scripts/backfill-graph.js --all      # re-process every fact
 *   node scripts/backfill-graph.js --limit 50 # cap number of facts processed
 *
 * Requires DATABASE_URL and OPENAI_API_KEY (loaded from ~/jarvis/.env).
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

// --- Load environment from ~/jarvis/.env (same convention as the bot) ---
const ENV_PATH = (process.env.HOME || '/home/iot') + '/jarvis/.env';
try {
  const envContent = readFileSync(ENV_PATH, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch (err) {
  console.error(`Failed to load ${ENV_PATH}: ${err.message}`);
}

const { linkFactToGraph, closePool } = await import('../src/memory.js');

function parseArgs() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;
  return { all, limit };
}

async function main() {
  const { all, limit } = parseArgs();

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

  // Facts to process: either all, or only those with no fact_entities links yet.
  const sql = all
    ? `SELECT id, content FROM memory_facts ORDER BY id ${limit ? 'LIMIT ' + Number(limit) : ''}`
    : `SELECT f.id, f.content
         FROM memory_facts f
         LEFT JOIN fact_entities fe ON fe.fact_id = f.id
        WHERE fe.fact_id IS NULL
        ORDER BY f.id ${limit ? 'LIMIT ' + Number(limit) : ''}`;

  const { rows } = await pool.query(sql);
  await pool.end();

  console.log(`Backfilling graph for ${rows.length} fact(s) (${all ? 'all' : 'unlinked only'})...`);

  let ok = 0;
  let entities = 0;
  let relations = 0;
  for (const [i, row] of rows.entries()) {
    try {
      const res = await linkFactToGraph(row.id, row.content);
      ok++;
      entities += res?.entities || 0;
      relations += res?.relations || 0;
      if ((i + 1) % 10 === 0) {
        console.log(`  ${i + 1}/${rows.length} processed`);
      }
    } catch (err) {
      console.error(`  fact ${row.id} failed: ${err.message}`);
    }
  }

  console.log(`Done. ${ok}/${rows.length} facts processed, ${entities} entity links, ${relations} relations upserted.`);

  await closePool();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
