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

const SUMMARIZATION_PROMPT = `Analyze this conversation and provide:
1. A concise summary (2-4 sentences) capturing the main topics and outcomes
2. A list of 3-5 key topic tags
3. Any durable facts worth remembering permanently (server IPs, passwords, setup details, user preferences, device names)

Respond ONLY with valid JSON, no markdown:
{"summary": "...", "topics": ["..."], "facts": ["..."]}

CONVERSATION:
`;

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

// --- Session summarization ---

function runHaiku(prompt) {
  return new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const cmd = `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions --model ${HAIKU_MODEL} -p '${escaped}' 2>/dev/null`;
    exec(cmd, { timeout: 60_000, shell: '/bin/bash', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
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

  const raw = await runHaiku(SUMMARIZATION_PROMPT + conversationText);
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

  // Auto-extract durable facts
  for (const fact of facts) {
    if (fact && fact.length > 5) {
      await storeFact(fact, null, source);
    }
  }

  await deleteSession(sessionId);

  return { summary, topics, facts: facts.length };
}

async function deleteSession(sessionId) {
  // Messages cascade-delete with the session
  await query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
}

// --- Durable facts ---

export async function storeFact(content, category = null, source = 'telegram', createdBy = null) {
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

  await query(
    `INSERT INTO memory_facts (content, category, embedding, source, created_by, created_at, metadata)
     VALUES ($1, $2, $3::vector, $4, $5, NOW(), '{}')`,
    [content, category, embedding ? vectorLiteral(embedding) : null, source, createdBy]
  );

  return { deduplicated: false };
}

export async function getAllFacts() {
  const { rows } = await query(
    'SELECT id, content, category, created_at FROM memory_facts ORDER BY created_at'
  );
  return rows;
}

export async function getMemoryStats() {
  const [factsRes, summariesRes, topicsRes] = await Promise.all([
    query('SELECT COUNT(*) AS count FROM memory_facts'),
    query('SELECT COUNT(*) AS count, MIN(session_created_at) AS oldest, MAX(session_ended_at) AS newest FROM chat_summaries'),
    query(`SELECT topic, COUNT(*) AS cnt
           FROM chat_summaries, jsonb_array_elements_text(topics) AS topic
           GROUP BY topic ORDER BY cnt DESC LIMIT 10`),
  ]);

  return {
    facts: Number(factsRes.rows[0]?.count || 0),
    summaries: Number(summariesRes.rows[0]?.count || 0),
    oldest: summariesRes.rows[0]?.oldest,
    newest: summariesRes.rows[0]?.newest,
    topTopics: topicsRes.rows.map((r) => ({ topic: r.topic, count: Number(r.cnt) })),
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
 * Build the memory block to prepend to Claude prompts.
 * Includes durable facts, relevant past summaries, and current session history.
 */
export async function buildMemoryContext(currentPrompt, sessionId) {
  const [facts, memories, sessionMsgs] = await Promise.all([
    getAllFacts(),
    searchMemory(currentPrompt, 3),
    getSessionMessages(sessionId),
  ]);

  const parts = [];

  if (facts.length) {
    parts.push('## Your Memory\n');
    parts.push('### Permanent Facts');
    for (const f of facts) {
      parts.push(`- ${f.content}`);
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

// --- Cleanup ---

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
