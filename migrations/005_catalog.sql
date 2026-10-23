-- =============================================================
-- BotForge – Migration 005
-- Catalog RAG: pgvector, catalog sources/products/info,
-- unanswered questions, and per-bot answer mode.
-- Requires DB-owner rights for CREATE EXTENSION. Safe to re-run.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── bots: answer mode ────────────────────────────────────────
ALTER TABLE bots
    ADD COLUMN IF NOT EXISTS answer_mode TEXT NOT NULL DEFAULT 'flexible'
        CHECK (answer_mode IN ('strict', 'flexible')),
    ADD COLUMN IF NOT EXISTS fallback_message TEXT;

-- ── catalog_sources: one row per upload or URL ───────────────
CREATE TABLE IF NOT EXISTS catalog_sources (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id         UUID        NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    kind           TEXT        NOT NULL CHECK (kind IN ('spreadsheet', 'pdf', 'url')),
    name           TEXT        NOT NULL,                 -- file name or URL
    status         TEXT        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    error          TEXT,
    item_count     INTEGER     NOT NULL DEFAULT 0,       -- products + info chunks
    last_synced_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── catalog_products ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_products (
    id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id        UUID           NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    source_id     UUID           NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
    external_key  TEXT           NOT NULL,               -- SKU, else normalized name
    name          TEXT           NOT NULL,
    category      TEXT,
    description   TEXT,
    price         NUMERIC(12, 2),
    currency      TEXT           NOT NULL DEFAULT 'INR',
    in_stock      BOOLEAN,                                -- NULL = unknown
    url           TEXT,
    image_url     TEXT,
    attributes    JSONB          NOT NULL DEFAULT '{}',
    content_hash  TEXT           NOT NULL,
    embedding     vector(1536)   NOT NULL,
    search_tsv    tsvector GENERATED ALWAYS AS (
                      to_tsvector('simple',
                          coalesce(name, '') || ' ' || coalesce(category, '') || ' ' ||
                          coalesce(description, '') || ' ' || external_key)
                  ) STORED,
    updated_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, external_key)
);

-- ── catalog_info: non-product text (policies, FAQ, about) ────
CREATE TABLE IF NOT EXISTS catalog_info (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id        UUID         NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    source_id     UUID         NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
    title         TEXT         NOT NULL,
    content       TEXT         NOT NULL,
    url           TEXT,
    content_hash  TEXT         NOT NULL,
    embedding     vector(1536) NOT NULL,
    search_tsv    tsvector GENERATED ALWAYS AS (
                      to_tsvector('simple', title || ' ' || content)
                  ) STORED,
    UNIQUE (source_id, content_hash)
);

-- ── unanswered_questions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS unanswered_questions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id       UUID        NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    session_id   UUID,
    question     TEXT        NOT NULL,
    reason       TEXT        NOT NULL CHECK (reason IN ('no_results', 'fallback')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at  TIMESTAMPTZ
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_catalog_sources_bot        ON catalog_sources (bot_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_bot       ON catalog_products (bot_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_bot_price ON catalog_products (bot_id, price);
CREATE INDEX IF NOT EXISTS idx_catalog_products_embedding ON catalog_products USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_catalog_products_tsv       ON catalog_products USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_catalog_info_bot           ON catalog_info (bot_id);
CREATE INDEX IF NOT EXISTS idx_catalog_info_embedding     ON catalog_info USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_catalog_info_tsv           ON catalog_info USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_unanswered_open
    ON unanswered_questions (bot_id, created_at DESC)
    WHERE resolved_at IS NULL;

-- ── updated_at triggers (trigger_set_updated_at() is defined in schema.sql) ──
DROP TRIGGER IF EXISTS set_catalog_sources_updated_at ON catalog_sources;
CREATE TRIGGER set_catalog_sources_updated_at
BEFORE UPDATE ON catalog_sources
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_catalog_products_updated_at ON catalog_products;
CREATE TRIGGER set_catalog_products_updated_at
BEFORE UPDATE ON catalog_products
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMENT ON COLUMN bots.answer_mode       IS 'strict = answer only from the catalog; flexible = general questions allowed.';
COMMENT ON COLUMN bots.fallback_message  IS 'Reply used in strict mode when the catalog has nothing relevant.';
COMMENT ON TABLE  catalog_products       IS 'Products imported from a bot''s catalog sources, with embeddings.';
COMMENT ON TABLE  unanswered_questions   IS 'Visitor questions the catalog could not answer.';
