/**
 * Long-term memory module — direct PostgreSQL + PGVector + OpenAI embeddings.
 *
 * Two-tier memory:
 *   Tier 1: Durable facts (memory_facts) — never decay, always in context
 *   Tier 2: Session summaries (chat_summaries) — recency-weighted retrieval
 *
 * Session lifecycle:
 *   messages stored in `sessions`/`messages` tables →
 *   session closes (30-min gap or /new) →
 *   summarised via Claude Haiku CLI →
 *   embedded via OpenAI →
 *   stored as chat_summary →
 *   raw messages deleted
 */

import pg from 'pg';
import { exec } from 'node:child_process';

const { Pool } = pg;

// --- Configuration ---

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const DECAY_LAMBDA = 0.023; // ln(2)/30 ≈ 30-day half-life
const SIMILARITY_THRESHOLD = 0.25;
const FACT_DEDUP_THRESHOLD = 0.92;

const HAIKU_MODEL = 'claude-haiku-4-20250514';
const JARVIS_DIR = process.env.HOME + '/jarvis';

// --- Fact categorization & context bounding ---

const KNOWN_CATEGORIES = ['identity', 'preference', 'infrastructure', 'relationship', 'general'];
const ALWAYS_INCLUDE_CATEGORIES = new Set(['identity', 'preference']);
const MAX_FACTS_IN_CONTEXT = 25;
const RETRIEVED_FACTS_LIMIT = 12;
const FACT_RETRIEVAL_THRESHOLD = 0.20;
const MAX_FACT_LENGTH = 300;

// --- Knowledge graph ---

const GRAPH_ENABLED = process.env.GRAPH_ENABLED !== 'false';
const GRAPH_MAX_HOPS = Number(process.env.GRAPH_MAX_HOPS || 2);
const GRAPH_RELATION_MIN_CONFIDENCE = Number(process.env.GRAPH_RELATION_MIN_CONFIDENCE || 0.5);
const GRAPH_ENTITY_MERGE_THRESHOLD = Number(process.env.GRAPH_ENTITY_MERGE_THRESHOLD || 0.90);
const GRAPH_MAX_RELATED_FACTS = Number(process.env.GRAPH_MAX_RELATED_FACTS || 10);
const GRAPH_MAX_RELATIONS_IN_CONTEXT = Number(process.env.GRAPH_MAX_RELATIONS_IN_CONTEXT || 15);
const ENTITY_TYPES = ['person', 'org', 'place', 'service', 'device', 'concept', 'other'];

const TRIPLE_EXTRACTION_PROMPT = `Extract a small knowledge graph from this single fact about the USER or their setup.
Return canonical entities (with a type) and directed relations between them.

Entity types: person, org, place, service, device, concept, other.
Predicates: short snake_case verbs, e.g. works_at, located_in, owns, runs_on, part_of, uses, has_role, related_to, member_of, manages.

Rules:
- Only extract information explicitly present in the fact. Do NOT invent facts.
- Use concise canonical entity names (e.g. "Payoneer", not "the company Payoneer").
- Refer to the user as "User".
- confidence is a number in [0,1] reflecting how clearly the relation is stated.
- If there are no meaningful relations, return "relations": [] but still list the entities.

FACT: {fact}

Respond ONLY with valid JSON, no markdown:
{"entities":[{"name":"User","type":"person"},{"name":"Payoneer","type":"org"}],"relations":[{"subject":"User","predicate":"works_at","object":"Payoneer","confidence":0.9}]}`;

// --- Junk patterns: facts we never want stored ---
//
// Each pattern has a name (for diagnostics) and a regex. Order matters only
// for which `reason` is reported when multiple match. Add new patterns here
// rather than spreading them across files.
const JUNK_PATTERNS = [
  // Credentials & secrets
  { name: 'password', re: /\bpassword\s*[:=]/i },
  { name: 'api_key',  re: /\b(api[_-]?key|access[_-]?token|bearer\s+token)\b\s*[:=]/i },
  { name: 'secret',   re: /\bsecret\s*[:=]/i },
  { name: 'env_secret_name', re: /\b[A-Z][A-Z0-9_]{2,}_(PASSWORD|PASS|KEY|SECRET|TOKEN|CREDENTIAL)\b/ },
  { name: 'env_var_assignment', re: /\b[A-Z][A-Z0-9_]{3,}_[A-Z]+\s*[:=]\s*\S+/ },

  // Transient runtime state
  { name: 'pid',              re: /\bPID\s*[:=]\s*\d+/i },
  { name: 'usage_metric',     re: /\b(memory|cpu|disk|ram|swap)\s+usage\s*[:=]/i },
  { name: 'active_clients',   re: /\bactive\s+(clients?|connections?|sessions?)\b/i },
  { name: 'running_since',    re: /\b(active|running|up)\s+(and\s+running\s+)?since\s+/i },
  { name: 'uptime',           re: /\buptime\s+(is|of)\b/i },
  { name: 'peak_value',       re: /\bpeak\s+\d+(\.\d+)?\s*(MB|GB|MiB|GiB|KB)\b/i },
  { name: 'currently_state',  re: /\bis\s+(currently|now)\s+(running|active|connected|online|up|down)\b/i },
  { name: 'recent_activity',  re: /\brecent\s+activity\s+(for|of|on)\b/i },
  { name: 'load_average',     re: /\bload\s+average[s]?\b/i },

  // Time-bound items / reminders
  { name: 'reminder_subject',    re: /^reminder\b/i },
  { name: 'has_reminder',        re: /^user\s+has\s+a\s+reminder\b/i },
  { name: 'reminder_action',     re: /\breminder\s+(at|set|for|to)\s+/i },
  { name: 'at_specific_time_to', re: /\bat\s+\d{1,2}:\d{2}\s+(to|for)\b/i },
  { name: 'in_n_hours_to',       re: /\bin\s+\d+\s+(hour|minute|hr|min)s?\s+to\b/i },

  // Trivia / common knowledge
  { name: 'country_code_def', re: /^[+\d\s]+is\s+the\s+country\s+code\b/i },

  // Self-references about the assistant
  { name: 'about_assistant', re: /^(the\s+)?(assistant|jarvis|bot)\s+(runs|is|operates|lives)\b/i },
];

/**
 * Decide whether a fact looks like junk that should never be persisted.
 * Returns { junk: boolean, reason?: string }.
 */
export function looksLikeJunk(content) {
  if (!content || typeof content !== 'string') return { junk: true, reason: 'empty' };
  const trimmed = content.trim();
  if (trimmed.length < 6) return { junk: true, reason: 'too_short' };
  if (trimmed.length > MAX_FACT_LENGTH) return { junk: true, reason: 'too_long' };
  for (const { name, re } of JUNK_PATTERNS) {
    if (re.test(trimmed)) return { junk: true, reason: name };
  }
  return { junk: false };
}

function normalizeCategory(category) {
  if (!category || typeof category !== 'string') return 'general';
  const lower = category.toLowerCase();
  return KNOWN_CATEGORIES.includes(lower) ? lower : 'general';
}

const SUMMARIZATION_PROMPT = `Analyze this conversation and provide:
1. A concise summary (2-4 sentences) capturing the main topics and outcomes
2. A list of 3-5 key topic tags
3. DURABLE facts about the USER worth remembering permanently, each tagged with a category

Each fact MUST be tagged with exactly one category from: identity, preference, infrastructure, relationship.

INCLUDE only stable facts about the USER:
- identity: name, birthday, location, nationality, religion, employer, family members
- preference: stable preferences ("user prefers X", "default behavior is Y", "user dislikes Z")
- infrastructure: stable network/system topology — server IPs, hostnames, mount points, fixed file paths, service names, port numbers
- relationship: contact details and named relationships

NEVER EXTRACT (these are not facts):
- Credentials of any kind: passwords, API keys, tokens, secrets, env-var values, "PASSWORD=", "_KEY:", "Bearer", connection strings
- Transient state from tool output: PIDs, memory/CPU/disk usage, percentages, uptime, "active since", connection counts, "currently running", load averages, peak values
- Time-bound or scheduled items: reminders, "remind me to...", "at HH:MM", "in N hours", one-time tasks, today/tonight tasks
- Common knowledge the model already has: country codes, public general facts, dictionary definitions
- Facts about the assistant/Jarvis itself, its location, capabilities, or session metadata
- Troubleshooting steps, commands run, conversation filler, greetings, status reports

If a fact straddles excluded ground or you are unsure, OMIT IT.

Respond ONLY with valid JSON, no markdown:
{"summary": "...", "topics": ["..."], "facts": [{"content": "User's birthday is May 21st", "category": "identity"}]}
If nothing worth remembering, return: {"summary": "...", "topics": ["..."], "facts": []}

CONVERSATION:
`;

const EXTRACTION_PROMPT = `Extract DURABLE facts about the USER from this exchange. Each fact must be tagged with exactly one category from: identity, preference, infrastructure, relationship.

INCLUDE only stable facts about the USER:
- identity: name, birthday, location, nationality, religion, employer, family
- preference: stable preferences ("user prefers X", "default behavior is Y")
- infrastructure: stable topology — IPs, hostnames, mount points, fixed paths, service names, port numbers
- relationship: contact details and named relationships

NEVER EXTRACT:
- Credentials: passwords, API keys, tokens, secrets, "PASSWORD=", env-var values, connection strings
- Transient state: PIDs, memory/CPU/disk usage, %, uptime, "active since", connection counts, "currently running", load averages, peak values
- Time-bound items: reminders, "remind me", "at HH:MM", "in N hours", one-time tasks, today/tonight items
- Common knowledge: country codes, public general facts, dictionary trivia
- Facts about the assistant/Jarvis itself
- Conversation filler, troubleshooting steps, commands run

If unsure, OMIT.

USER: {user}
ASSISTANT: {assistant}

Respond ONLY with valid JSON, no markdown:
{"facts": [{"content": "User lives in Jerusalem", "category": "identity"}]}
If nothing worth remembering: {"facts": []}`;

const pendingFactBatches = new Map();
const PENDING_TTL = 5 * 60 * 1000;

// --- Database pool (lazy init) ---

let pool = null;

function getPool() {
  if (!pool) {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) {
      console.error('DATABASE_URL not set — memory module disabled');
      return null;
    }
    pool = new Pool({ connectionString: connStr, max: 3 });
    pool.on('error', (err) => console.error('PG pool error:', err.message));
  }
  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) return { rows: [] };
  return p.query(sql, params);
}

// --- OpenAI embedding ---

async function createEmbedding(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !text?.trim()) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.trim(),
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });
    if (!res.ok) {
      console.error(`OpenAI embedding error: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    return data.data?.[0]?.embedding ?? null;
  } catch (err) {
    console.error('Embedding fetch failed:', err.message);
    return null;
  }
}

function vectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}

// --- Session management ---

/**
 * Ensure a session row exists and return its UUID.
 * The bot calls this once per getOrRotateSession.
 */
export async function ensureSession(sessionId, source = 'telegram') {
  await query(
    `INSERT INTO sessions (session_id, created_at, last_activity, metadata)
     VALUES ($1, NOW(), NOW(), $2)
     ON CONFLICT (session_id) DO UPDATE SET last_activity = NOW()`,
    [sessionId, JSON.stringify({ source })]
  );
}

export async function storeMessage(sessionId, role, content) {
  await query(
    `INSERT INTO messages (session_id, role, content, timestamp, metadata)
     VALUES ($1, $2, $3, NOW(), '{}')`,
    [sessionId, role, content]
  );
}

export async function getSessionMessages(sessionId) {
  const { rows } = await query(
    `SELECT role, content, timestamp FROM messages
     WHERE session_id = $1 ORDER BY timestamp`,
    [sessionId]
  );
  return rows;
}

// --- Small model for summarization / extraction ---

async function runSmallModel(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 500,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || null;
      }
      console.error(`[memory] OpenAI API error: ${res.status} ${await res.text()}`);
    } catch (err) {
      console.error('[memory] OpenAI API call failed:', err.message);
    }
  }

  // Fallback: Claude CLI
  const escaped = prompt.replace(/'/g, "'\\''");
  const cmd = `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions --model ${HAIKU_MODEL} -p '${escaped}' 2>&1`;
  return new Promise((resolve) => {
    exec(cmd, { timeout: 60_000, shell: '/bin/bash', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.error('[memory] Claude CLI fallback failed:', stdout?.slice(0, 200) || err.message);
        resolve(null);
      } else {
        resolve(stdout?.trim() || null);
      }
    });
  });
}

function parseJsonResponse(text) {
  if (!text) return null;
  let cleaned = text.trim();
  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    cleaned = lines.slice(1, lines.findIndex((l, i) => i > 0 && l.startsWith('```'))).join('\n');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Summarize a closed session: generate summary + embedding, store as chat_summary,
 * extract durable facts, delete raw messages.
 */
export async function summarizeSession(sessionId, source = 'telegram') {
  const messages = await getSessionMessages(sessionId);
  if (messages.length < 2) {
    await deleteSession(sessionId);
    return null;
  }

  const conversationText = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');

  const raw = await runSmallModel(SUMMARIZATION_PROMPT + conversationText);
  const parsed = parseJsonResponse(raw);

  const summary = parsed?.summary || raw || 'Session with no extractable summary.';
  const topics = parsed?.topics || [];
  const facts = parsed?.facts || [];

  // Generate embedding for the summary
  const embeddingText = topics.length
    ? `${summary} Topics: ${topics.join(', ')}`
    : summary;
  const embedding = await createEmbedding(embeddingText);

  const firstTs = messages[0].timestamp;
  const lastTs = messages[messages.length - 1].timestamp;

  await query(
    `INSERT INTO chat_summaries
       (session_id, summary, topics, embedding, message_count,
        session_created_at, session_ended_at, created_at, source, metadata)
     VALUES ($1, $2, $3, $4::vector, $5, $6, $7, NOW(), $8, '{}')
     ON CONFLICT (session_id) DO NOTHING`,
    [
      sessionId, summary, JSON.stringify(topics),
      embedding ? vectorLiteral(embedding) : null,
      messages.length, firstTs, lastTs, source,
    ]
  );

  // Auto-extract durable facts. Tolerate both shapes:
  //   new: [{content, category}]
  //   legacy: ["fact text", ...]
  let stored = 0;
  for (const item of facts) {
    const content = typeof item === 'string' ? item : item?.content;
    const category = typeof item === 'string' ? null : item?.category;
    if (!content || content.length <= 5) continue;
    const result = await storeFact(content, category, source);
    if (!result.rejected && !result.deduplicated) stored++;
  }

  await deleteSession(sessionId);

  return { summary, topics, facts: stored };
}

async function deleteSession(sessionId) {
  // Messages cascade-delete with the session
  await query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
}

// --- Durable facts ---

export async function storeFact(content, category = null, source = 'telegram', createdBy = null) {
  // Reject obvious junk (secrets, transient state, reminders, trivia) before any DB work
  const junkCheck = looksLikeJunk(content);
  if (junkCheck.junk) {
    return { rejected: true, reason: junkCheck.reason };
  }

  const cat = normalizeCategory(category);
  const embedding = await createEmbedding(content);

  // Deduplication: check if a very similar fact already exists
  if (embedding) {
    const { rows } = await query(
      `SELECT id, content,
              1 - (embedding <=> $1::vector) AS similarity
       FROM memory_facts
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [vectorLiteral(embedding)]
    );
    if (rows.length && rows[0].similarity >= FACT_DEDUP_THRESHOLD) {
      return { deduplicated: true, existing: rows[0].content };
    }
  }

  const { rows: inserted } = await query(
    `INSERT INTO memory_facts (content, category, embedding, source, created_by, created_at, metadata)
     VALUES ($1, $2, $3::vector, $4, $5, NOW(), '{}')
     RETURNING id`,
    [content, cat, embedding ? vectorLiteral(embedding) : null, source, createdBy]
  );

  // Best-effort: extract entities/relations and link the fact into the graph.
  // A graph failure must never prevent the fact itself from being stored.
  const factId = inserted?.[0]?.id;
  if (factId && GRAPH_ENABLED) {
    try {
      await linkFactToGraph(factId, content);
    } catch (err) {
      console.error('[graph] linkFactToGraph failed:', err.message);
    }
  }

  return { deduplicated: false, category: cat, factId };
}

/**
 * Scan all stored facts and delete rows whose content matches any junk pattern.
 * Returns counts grouped by reason and a small sample of deleted contents.
 *
 * Pass `{ dryRun: true }` to preview without deleting.
 */
export async function purgeJunkFacts({ dryRun = false } = {}) {
  const { rows } = await query('SELECT id, content FROM memory_facts');
  const toDelete = [];
  const samples = [];
  const byReason = {};

  for (const row of rows) {
    const check = looksLikeJunk(row.content);
    if (!check.junk) continue;
    toDelete.push(row.id);
    byReason[check.reason] = (byReason[check.reason] || 0) + 1;
    if (samples.length < 10) samples.push({ content: row.content, reason: check.reason });
  }

  if (!dryRun && toDelete.length) {
    await query('DELETE FROM memory_facts WHERE id = ANY($1)', [toDelete]);
  }

  return {
    scanned: rows.length,
    candidates: toDelete.length,
    deleted: dryRun ? 0 : toDelete.length,
    byReason,
    samples,
    dryRun,
  };
}

export async function getAllFacts() {
  const { rows } = await query(
    'SELECT id, content, category, created_at FROM memory_facts ORDER BY created_at'
  );
  return rows;
}

export async function getMemoryStats() {
  const [factsRes, summariesRes, topicsRes, entitiesRes, relationsRes] = await Promise.all([
    query('SELECT COUNT(*) AS count FROM memory_facts'),
    query('SELECT COUNT(*) AS count, MIN(session_created_at) AS oldest, MAX(session_ended_at) AS newest FROM chat_summaries'),
    query(`SELECT topic, COUNT(*) AS cnt
           FROM chat_summaries, jsonb_array_elements_text(topics) AS topic
           GROUP BY topic ORDER BY cnt DESC LIMIT 10`),
    query('SELECT COUNT(*) AS count FROM graph_entities').catch(() => ({ rows: [{ count: 0 }] })),
    query('SELECT COUNT(*) AS count FROM graph_relations').catch(() => ({ rows: [{ count: 0 }] })),
  ]);

  return {
    facts: Number(factsRes.rows[0]?.count || 0),
    summaries: Number(summariesRes.rows[0]?.count || 0),
    oldest: summariesRes.rows[0]?.oldest,
    newest: summariesRes.rows[0]?.newest,
    topTopics: topicsRes.rows.map((r) => ({ topic: r.topic, count: Number(r.cnt) })),
    entities: Number(entitiesRes.rows[0]?.count || 0),
    relations: Number(relationsRes.rows[0]?.count || 0),
  };
}

// --- Recency-weighted memory search ---

/**
 * Search chat_summaries with cosine similarity * temporal decay.
 *
 * final_score = similarity * e^(-λ * age_days)
 *
 * λ = 0.023 gives a 30-day half-life:
 *   today: 100%, 7d: 85%, 30d: 50%, 90d: 12.5%
 *
 * Summaries that get retrieved have their last_accessed_at refreshed,
 * which resets their effective age (spaced-repetition effect).
 */
export async function searchMemory(queryText, limit = 3) {
  const embedding = await createEmbedding(queryText);
  if (!embedding) {
    // Fallback: return most recent summaries
    const { rows } = await query(
      `SELECT id, summary, topics, session_ended_at, source
       FROM chat_summaries ORDER BY session_ended_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({ ...r, score: 0.5 }));
  }

  const vec = vectorLiteral(embedding);

  const { rows } = await query(
    `SELECT id, summary, topics, session_ended_at, source,
            1 - (embedding <=> $1::vector) AS similarity,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed_at, session_ended_at))) / 86400.0 AS age_days,
            (1 - (embedding <=> $1::vector))
              * EXP(-${DECAY_LAMBDA} * EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed_at, session_ended_at))) / 86400.0)
              AS final_score
     FROM chat_summaries
     WHERE embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) >= $2
     ORDER BY final_score DESC
     LIMIT $3`,
    [vec, SIMILARITY_THRESHOLD, limit]
  );

  // Refresh last_accessed_at for retrieved summaries (spaced repetition)
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    await query(
      `UPDATE chat_summaries SET last_accessed_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );
  }

  return rows.map((r) => ({
    id: r.id,
    summary: r.summary,
    topics: r.topics,
    session_ended_at: r.session_ended_at,
    source: r.source,
    score: Number(r.final_score),
    similarity: Number(r.similarity),
    age_days: Math.round(Number(r.age_days)),
  }));
}

// --- Context builder ---

function daysAgoLabel(date) {
  if (!date) return '';
  const days = Math.round((Date.now() - new Date(date).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * Retrieve facts to inject into a Claude prompt:
 *   - Always include facts in ALWAYS_INCLUDE_CATEGORIES (identity, preference)
 *   - For other categories, semantic-rank by similarity to the current prompt,
 *     keeping the top RETRIEVED_FACTS_LIMIT
 *   - Total cap: MAX_FACTS_IN_CONTEXT
 *
 * Falls back to most-recent-first if no embedding can be generated.
 */
async function selectFactsForContext(currentPrompt) {
  const alwaysIncludeList = Array.from(ALWAYS_INCLUDE_CATEGORIES);

  const alwaysIncludeRows = await query(
    `SELECT id, content, category, created_at
       FROM memory_facts
      WHERE category = ANY($1)
      ORDER BY created_at`,
    [alwaysIncludeList]
  );

  const embedding = await createEmbedding(currentPrompt);
  let retrievedRows = [];

  if (embedding) {
    const { rows } = await query(
      `SELECT id, content, category, created_at,
              1 - (embedding <=> $1::vector) AS similarity
         FROM memory_facts
        WHERE (category IS NULL OR NOT (category = ANY($2)))
          AND embedding IS NOT NULL
          AND 1 - (embedding <=> $1::vector) >= $3
        ORDER BY embedding <=> $1::vector
        LIMIT $4`,
      [vectorLiteral(embedding), alwaysIncludeList, FACT_RETRIEVAL_THRESHOLD, RETRIEVED_FACTS_LIMIT]
    );
    retrievedRows = rows;
  } else {
    const { rows } = await query(
      `SELECT id, content, category, created_at
         FROM memory_facts
        WHERE (category IS NULL OR NOT (category = ANY($1)))
        ORDER BY created_at DESC
        LIMIT $2`,
      [alwaysIncludeList, RETRIEVED_FACTS_LIMIT]
    );
    retrievedRows = rows;
  }

  // Combine, dedup by id, cap at MAX_FACTS_IN_CONTEXT
  const seen = new Set();
  const combined = [];
  for (const row of [...alwaysIncludeRows.rows, ...retrievedRows]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    combined.push(row);
    if (combined.length >= MAX_FACTS_IN_CONTEXT) break;
  }
  return combined;
}

/**
 * Build the memory block to prepend to Claude prompts.
 * Includes durable facts (bounded), relevant past summaries, and current session history.
 */
export async function buildMemoryContext(currentPrompt, sessionId) {
  const [facts, memories, sessionMsgs] = await Promise.all([
    selectFactsForContext(currentPrompt),
    searchMemory(currentPrompt, 3),
    getSessionMessages(sessionId),
  ]);

  // Graph expansion: pull in facts/relations connected to the selected facts.
  let graphFacts = [];
  let graphRelations = [];
  if (GRAPH_ENABLED && facts.length) {
    try {
      const seedIds = facts.map((f) => f.id).filter((id) => id != null);
      const expansion = await expandFactsViaGraph(seedIds);
      graphRelations = expansion.relations;
      // Merge connected facts, dedup against already-selected facts, respect cap
      const seen = new Set(facts.map((f) => f.id));
      for (const gf of expansion.facts) {
        if (seen.has(gf.id)) continue;
        seen.add(gf.id);
        graphFacts.push(gf);
        if (facts.length + graphFacts.length >= MAX_FACTS_IN_CONTEXT) break;
      }
    } catch (err) {
      console.error('[graph] expandFactsViaGraph failed:', err.message);
    }
  }

  const parts = [];

  if (facts.length || graphFacts.length) {
    parts.push('## Your Memory\n');
    parts.push('### Permanent Facts');
    for (const f of [...facts, ...graphFacts]) {
      parts.push(`- ${f.content}`);
    }
    parts.push('');
  }

  if (graphRelations.length) {
    parts.push('### Related Knowledge');
    for (const r of graphRelations) {
      parts.push(`- ${r.subject} ${r.predicate.replace(/_/g, ' ')} ${r.object}`);
    }
    parts.push('');
  }

  if (memories.length) {
    if (!parts.length) parts.push('## Your Memory\n');
    parts.push('### Relevant Past Conversations');
    for (const m of memories) {
      const when = daysAgoLabel(m.session_ended_at);
      const topicStr = m.topics?.length ? ` (${m.topics.join(', ')})` : '';
      parts.push(`- [${when}]${topicStr} ${m.summary}`);
    }
    parts.push('');
  }

  if (sessionMsgs.length) {
    parts.push('### Current Session');
    const recent = sessionMsgs.slice(-10); // last 10 messages
    for (const msg of recent) {
      const label = msg.role === 'user' ? 'User' : 'Jarvis';
      const text = msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content;
      parts.push(`${label}: ${text}`);
    }
    parts.push('');
  }

  if (!parts.length) return currentPrompt;

  return parts.join('\n') + '\nCurrent message:\n' + currentPrompt;
}

// --- Real-time fact extraction ---

/**
 * Extract durable, categorized facts from a user/assistant exchange.
 * Returns Array<{content: string, category: string}>.
 * Junk-pattern matches are silently dropped at this stage so the user
 * is never asked to confirm something we'd reject anyway.
 */
export async function extractFactsFromExchange(userMessage, assistantResponse) {
  const prompt = EXTRACTION_PROMPT
    .replace('{user}', userMessage.slice(0, 1000))
    .replace('{assistant}', assistantResponse.slice(0, 1000));

  const raw = await runSmallModel(prompt);
  if (!raw) {
    console.error('[memory] Small model returned null');
    return [];
  }
  console.log('[memory] Extraction response:', raw.slice(0, 200));
  const parsed = parseJsonResponse(raw);
  if (!parsed) {
    console.error('[memory] Failed to parse extraction response as JSON');
    return [];
  }
  const rawFacts = parsed?.facts || [];
  const normalized = [];
  for (const item of rawFacts) {
    const content = typeof item === 'string' ? item : item?.content;
    const category = typeof item === 'string' ? null : item?.category;
    if (!content || content.length <= 5) continue;
    if (looksLikeJunk(content).junk) continue;
    normalized.push({ content, category: normalizeCategory(category) });
  }
  return normalized;
}

/**
 * Filter out candidate facts that already exist in memory_facts
 * by embedding each candidate and checking PGVector similarity.
 * Operates on Array<{content, category}> and returns only genuinely novel facts.
 */
export async function deduplicateFacts(candidateFacts) {
  const novel = [];
  for (const fact of candidateFacts) {
    const content = typeof fact === 'string' ? fact : fact?.content;
    if (!content) continue;
    const embedding = await createEmbedding(content);
    if (!embedding) {
      novel.push(fact);
      continue;
    }
    const { rows } = await query(
      `SELECT 1 FROM memory_facts
       WHERE embedding IS NOT NULL
         AND 1 - (embedding <=> $1::vector) >= $2
       LIMIT 1`,
      [vectorLiteral(embedding), FACT_DEDUP_THRESHOLD]
    );
    if (!rows.length) novel.push(fact);
  }
  return novel;
}

// --- Knowledge graph: extraction, entity resolution, linking, traversal ---

function normalizeEntityName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?"'`]+$/g, '')
    .trim();
}

function normalizePredicate(pred) {
  return String(pred || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'related_to';
}

function normalizeEntityType(type) {
  const lower = String(type || '').toLowerCase().trim();
  return ENTITY_TYPES.includes(lower) ? lower : 'other';
}

/**
 * Resolve a surface-form entity name to a canonical graph_entities row id.
 * Resolution order:
 *   1. Exact normalized-name match
 *   2. Embedding nearest-neighbour >= GRAPH_ENTITY_MERGE_THRESHOLD (records alias)
 *   3. Insert a new entity
 * Uses a per-call cache to avoid re-resolving the same name repeatedly.
 */
async function resolveEntity(name, type, cache) {
  const canonical = String(name || '').trim();
  const normalized = normalizeEntityName(canonical);
  if (!normalized) return null;
  if (cache && cache.has(normalized)) return cache.get(normalized);

  // 1. Exact normalized-name match
  const exact = await query(
    `SELECT id FROM graph_entities WHERE normalized_name = $1 LIMIT 1`,
    [normalized]
  );
  if (exact.rows.length) {
    if (cache) cache.set(normalized, exact.rows[0].id);
    return exact.rows[0].id;
  }

  // 2. Embedding nearest-neighbour merge
  const embedding = await createEmbedding(canonical);
  if (embedding) {
    const { rows } = await query(
      `SELECT id, aliases, 1 - (embedding <=> $1::vector) AS similarity
         FROM graph_entities
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 1`,
      [vectorLiteral(embedding)]
    );
    if (rows.length && rows[0].similarity >= GRAPH_ENTITY_MERGE_THRESHOLD) {
      const id = rows[0].id;
      const aliases = Array.isArray(rows[0].aliases) ? rows[0].aliases : [];
      if (!aliases.map(normalizeEntityName).includes(normalized)) {
        aliases.push(canonical);
        await query(`UPDATE graph_entities SET aliases = $1 WHERE id = $2`,
          [JSON.stringify(aliases), id]);
      }
      if (cache) cache.set(normalized, id);
      return id;
    }
  }

  // 3. Insert new entity
  const { rows: created } = await query(
    `INSERT INTO graph_entities (name, normalized_name, type, aliases, embedding, created_at, metadata)
     VALUES ($1, $2, $3, '[]'::jsonb, $4::vector, NOW(), '{}')
     RETURNING id`,
    [canonical, normalized, normalizeEntityType(type), embedding ? vectorLiteral(embedding) : null]
  );
  const id = created?.[0]?.id ?? null;
  if (cache && id) cache.set(normalized, id);
  return id;
}

/**
 * Run the triple-extraction model over a single fact.
 * Returns { entities: [{name,type}], relations: [{subject,predicate,object,confidence}] }.
 */
async function extractGraphFromFact(content) {
  const raw = await runSmallModel(TRIPLE_EXTRACTION_PROMPT.replace('{fact}', content.slice(0, 500)));
  const parsed = parseJsonResponse(raw);
  if (!parsed) return { entities: [], relations: [] };
  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const relations = Array.isArray(parsed.relations) ? parsed.relations : [];
  return { entities, relations };
}

/**
 * Extract a fact's entities/relations and persist them:
 *   - resolve every mentioned entity to a canonical node
 *   - link the fact to those entities (fact_entities)
 *   - upsert typed relations (graph_relations), tracing source_fact_id
 */
export async function linkFactToGraph(factId, content) {
  const { entities, relations } = await extractGraphFromFact(content);

  const cache = new Map();
  const entityIds = new Set();

  // Resolve standalone entities plus every subject/object mentioned in relations
  const names = [];
  for (const e of entities) if (e?.name) names.push({ name: e.name, type: e.type });
  for (const r of relations) {
    if (r?.subject) names.push({ name: r.subject, type: null });
    if (r?.object) names.push({ name: r.object, type: null });
  }

  for (const { name, type } of names) {
    const id = await resolveEntity(name, type, cache);
    if (id) entityIds.add(id);
  }

  // Link fact -> entities
  for (const entityId of entityIds) {
    await query(
      `INSERT INTO fact_entities (fact_id, entity_id) VALUES ($1, $2)
       ON CONFLICT (fact_id, entity_id) DO NOTHING`,
      [factId, entityId]
    );
  }

  // Upsert typed relations
  let storedRelations = 0;
  for (const r of relations) {
    const subjId = cache.get(normalizeEntityName(r?.subject));
    const objId = cache.get(normalizeEntityName(r?.object));
    if (!subjId || !objId || subjId === objId) continue;
    const predicate = normalizePredicate(r?.predicate);
    const confidence = Math.max(0, Math.min(1, Number(r?.confidence) || 0.7));
    await query(
      `INSERT INTO graph_relations
         (subject_entity_id, predicate, object_entity_id, source_fact_id, confidence, created_at, metadata)
       VALUES ($1, $2, $3, $4, $5, NOW(), '{}')
       ON CONFLICT (subject_entity_id, predicate, object_entity_id)
       DO UPDATE SET confidence = GREATEST(graph_relations.confidence, EXCLUDED.confidence),
                     source_fact_id = COALESCE(graph_relations.source_fact_id, EXCLUDED.source_fact_id)`,
      [subjId, predicate, objId, factId, confidence]
    );
    storedRelations++;
  }

  return { entities: entityIds.size, relations: storedRelations };
}

/**
 * Given seed fact ids, expand through the graph:
 *   seed facts -> their entities -> N-hop related entities (recursive CTE)
 *   -> facts linked to those entities, plus the relation triples traversed.
 *
 * Returns { facts: [{id, content, category}], relations: [{subject, predicate, object}] }.
 */
export async function expandFactsViaGraph(seedFactIds, { maxHops = GRAPH_MAX_HOPS } = {}) {
  if (!GRAPH_ENABLED || !seedFactIds?.length) return { facts: [], relations: [] };

  // Recursive traversal from the seed facts' entities out to maxHops:
  // first the relation triples on reachable entities, then facts linked to them.
  const { rows: relRows } = await query(
    `WITH RECURSIVE seed_entities AS (
        SELECT DISTINCT entity_id AS id FROM fact_entities WHERE fact_id = ANY($1)
     ),
     reachable AS (
        SELECT id, 0 AS depth FROM seed_entities
        UNION
        SELECT CASE WHEN r.subject_entity_id = rc.id THEN r.object_entity_id
                    ELSE r.subject_entity_id END AS id,
               rc.depth + 1 AS depth
          FROM reachable rc
          JOIN graph_relations r
            ON (r.subject_entity_id = rc.id OR r.object_entity_id = rc.id)
           AND r.confidence >= $2
         WHERE rc.depth < $3
     )
     SELECT DISTINCT r.id, r.predicate, r.confidence,
            s.name AS subject, o.name AS object
       FROM graph_relations r
       JOIN reachable rs ON rs.id = r.subject_entity_id
       JOIN reachable ro ON ro.id = r.object_entity_id
       JOIN graph_entities s ON s.id = r.subject_entity_id
       JOIN graph_entities o ON o.id = r.object_entity_id
      WHERE r.confidence >= $2
      ORDER BY r.confidence DESC
      LIMIT $4`,
    [seedFactIds, GRAPH_RELATION_MIN_CONFIDENCE, maxHops, GRAPH_MAX_RELATIONS_IN_CONTEXT]
  );

  const { rows: factRows } = await query(
    `WITH RECURSIVE seed_entities AS (
        SELECT DISTINCT entity_id AS id FROM fact_entities WHERE fact_id = ANY($1)
     ),
     reachable AS (
        SELECT id, 0 AS depth FROM seed_entities
        UNION
        SELECT CASE WHEN r.subject_entity_id = rc.id THEN r.object_entity_id
                    ELSE r.subject_entity_id END AS id,
               rc.depth + 1 AS depth
          FROM reachable rc
          JOIN graph_relations r
            ON (r.subject_entity_id = rc.id OR r.object_entity_id = rc.id)
           AND r.confidence >= $2
         WHERE rc.depth < $3
     )
     SELECT DISTINCT f.id, f.content, f.category
       FROM memory_facts f
       JOIN fact_entities fe ON fe.fact_id = f.id
       JOIN reachable rc ON rc.id = fe.entity_id
      WHERE NOT (f.id = ANY($1))
      ORDER BY f.id
      LIMIT $4`,
    [seedFactIds, GRAPH_RELATION_MIN_CONFIDENCE, maxHops, GRAPH_MAX_RELATED_FACTS]
  );

  return {
    facts: factRows,
    relations: relRows.map((r) => ({
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      confidence: Number(r.confidence),
    })),
  };
}

function cleanupPendingBatches() {
  const now = Date.now();
  for (const [id, batch] of pendingFactBatches) {
    if (now - batch.timestamp > PENDING_TTL) pendingFactBatches.delete(id);
  }
}

export function storePendingBatch(facts) {
  cleanupPendingBatches();
  const id = Math.random().toString(36).slice(2, 10);
  pendingFactBatches.set(id, { facts, timestamp: Date.now() });
  return id;
}

export function getPendingBatch(batchId) {
  const batch = pendingFactBatches.get(batchId);
  if (!batch) return null;
  if (Date.now() - batch.timestamp > PENDING_TTL) {
    pendingFactBatches.delete(batchId);
    return null;
  }
  return batch.facts;
}

export function deletePendingBatch(batchId) {
  pendingFactBatches.delete(batchId);
}

// --- Cleanup ---

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
