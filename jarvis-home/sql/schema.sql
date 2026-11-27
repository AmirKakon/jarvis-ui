-- JARVIS database schema (PostgreSQL + pgvector).
--
-- Every table the Telegram bot reads and writes. Idempotent: setup.sh applies
-- it on each deploy, and it is safe to run by hand:
--
--   psql "$DATABASE_URL" -f jarvis-home/sql/schema.sql
--
-- Consolidated from the retired FastAPI backend's Alembic migrations
-- (initial schema, chat summaries, memory facts + recency, knowledge graph).
-- Embeddings are text-embedding-3-small at 1536 dimensions (memory.js).

CREATE EXTENSION IF NOT EXISTS vector;

-- --- Conversations ---

CREATE TABLE IF NOT EXISTS sessions (
    session_id    UUID PRIMARY KEY,
    user_id       VARCHAR(255),
    created_at    TIMESTAMPTZ NOT NULL,
    last_activity TIMESTAMPTZ NOT NULL,
    metadata      JSONB
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions (last_activity);

CREATE TABLE IF NOT EXISTS messages (
    id         SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    role       VARCHAR(20) NOT NULL,
    content    TEXT NOT NULL,
    timestamp  TIMESTAMPTZ NOT NULL,
    metadata   JSONB
);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);

-- --- Long-term memory ---

CREATE TABLE IF NOT EXISTS chat_summaries (
    id                 SERIAL PRIMARY KEY,
    session_id         UUID NOT NULL UNIQUE,
    user_id            VARCHAR(255),
    summary            TEXT NOT NULL,
    topics             JSONB,
    embedding          vector(1536),
    message_count      INTEGER NOT NULL,
    session_created_at TIMESTAMPTZ NOT NULL,
    session_ended_at   TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL,
    metadata           JSONB,
    last_accessed_at   TIMESTAMPTZ,
    source             VARCHAR(50)
);
ALTER TABLE chat_summaries ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE chat_summaries ADD COLUMN IF NOT EXISTS source VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_session_id ON chat_summaries (session_id);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_created_at ON chat_summaries (created_at);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_user_id ON chat_summaries (user_id);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_embedding ON chat_summaries USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS memory_facts (
    id               SERIAL PRIMARY KEY,
    content          TEXT NOT NULL,
    category         VARCHAR(100),
    embedding        vector(1536),
    source           VARCHAR(50) NOT NULL DEFAULT 'telegram',
    created_by       VARCHAR(255),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ,
    metadata         JSONB
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_created_at ON memory_facts (created_at);
CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts (category);
CREATE INDEX IF NOT EXISTS idx_memory_facts_embedding ON memory_facts USING hnsw (embedding vector_cosine_ops);

-- --- Knowledge graph ---

CREATE TABLE IF NOT EXISTS graph_entities (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    normalized_name VARCHAR(255) NOT NULL,
    type            VARCHAR(50),
    aliases         JSONB,
    embedding       vector(1536),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB
);
CREATE INDEX IF NOT EXISTS idx_graph_entities_normalized_name ON graph_entities (normalized_name);
CREATE INDEX IF NOT EXISTS idx_graph_entities_created_at ON graph_entities (created_at);
CREATE INDEX IF NOT EXISTS idx_graph_entities_embedding ON graph_entities USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS graph_relations (
    id                SERIAL PRIMARY KEY,
    subject_entity_id INTEGER NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    predicate         VARCHAR(255) NOT NULL,
    object_entity_id  INTEGER NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    source_fact_id    INTEGER REFERENCES memory_facts(id) ON DELETE SET NULL,
    confidence        DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata          JSONB
);
CREATE INDEX IF NOT EXISTS idx_graph_relations_subject ON graph_relations (subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_graph_relations_object ON graph_relations (object_entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_graph_relations_triple
    ON graph_relations (subject_entity_id, predicate, object_entity_id);

CREATE TABLE IF NOT EXISTS fact_entities (
    fact_id   INTEGER NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    PRIMARY KEY (fact_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities (entity_id);

-- --- Reminders (remind.js also creates this on first use) ---

CREATE TABLE IF NOT EXISTS reminders (
    id                SERIAL PRIMARY KEY,
    chat_id           TEXT NOT NULL,
    message           TEXT NOT NULL,
    fire_at           TIMESTAMPTZ NOT NULL,
    recurrence        TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    fired             BOOLEAN DEFAULT FALSE,
    kind              TEXT,
    calendar_event_id TEXT
);
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders (fire_at) WHERE fired = FALSE;
