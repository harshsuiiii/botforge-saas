-- =============================================================
-- BotForge – Migration 002
-- Adds system_prompt and deleted_at to bots table.
-- Run ONCE against your Postgres 15 database.
-- =============================================================

ALTER TABLE bots
    ADD COLUMN IF NOT EXISTS system_prompt TEXT,
    ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ;

-- Index: soft-delete filter (the common "active bots" query)
CREATE INDEX IF NOT EXISTS idx_bots_deleted_at
    ON bots (deleted_at)
    WHERE deleted_at IS NULL;

-- Index: per-user active bots (most frequent list query)
CREATE INDEX IF NOT EXISTS idx_bots_user_active
    ON bots (user_id, created_at DESC)
    WHERE deleted_at IS NULL;

COMMENT ON COLUMN bots.system_prompt IS
    'Assembled LLM system prompt derived from personality, purpose, instructions, and topic lists.';

COMMENT ON COLUMN bots.deleted_at IS
    'Soft-delete timestamp. NULL = active. Set by DELETE /api/bots/:id.';
