-- Knowledge-graph schema (mirror of Alembic migration 004).
--
-- Use this on hosts where the FastAPI backend's Python env is not installed
-- (e.g. the Telegram-bot box), applying the schema directly with psql:
--
--   psql "$DATABASE_URL" -f backend/sql/004_add_knowledge_graph.sql
--
-- Idempotent: safe to run more than once. Also bumps alembic_version to 004
-- if that table exists, so a later `alembic upgrade head` stays consistent.

CREATE EXTENSION IF NOT EXISTS vector;

-- --- graph_entities ---
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

-- --- graph_relations ---
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

-- --- fact_entities (join table) ---
CREATE TABLE IF NOT EXISTS fact_entities (
    fact_id   INTEGER NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    PRIMARY KEY (fact_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities (entity_id);

-- Keep Alembic bookkeeping in sync if the backend uses it on this DB.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'alembic_version') THEN
        UPDATE alembic_version SET version_num = '004' WHERE version_num = '003';
    END IF;
END $$;
