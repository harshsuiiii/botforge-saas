-- =============================================================
-- BotForge – Migration 004
-- Makes embed_configs.bot_id unique so POST /api/bots/:id/embed-key
-- can upsert with ON CONFLICT (bot_id).
-- Safe to re-run.
-- =============================================================

BEGIN;

-- Keep only one embed config per bot (an arbitrary survivor; keys are rotatable)
DELETE FROM embed_configs a
USING  embed_configs b
WHERE  a.bot_id = b.bot_id
  AND  a.id > b.id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE  conname = 'embed_configs_bot_id_key'
    ) THEN
        ALTER TABLE embed_configs
            ADD CONSTRAINT embed_configs_bot_id_key UNIQUE (bot_id);
    END IF;
END;
$$;

-- Redundant now that the unique constraint provides an index
DROP INDEX IF EXISTS idx_embed_configs_bot_id;

COMMIT;
