-- =============================================================
-- BotForge – Migration 006
-- 1. One OpenAI key per user, so saving a key is an atomic upsert.
-- 2. At most one running (pending/processing) catalog import per bot,
--    closing the race between the API's check and its insert.
-- Safe to re-run.
-- =============================================================

BEGIN;

-- Keep only each user's most recent token
DELETE FROM openai_tokens a
USING  openai_tokens b
WHERE  a.user_id = b.user_id
  AND  (a.updated_at < b.updated_at OR (a.updated_at = b.updated_at AND a.id < b.id));

DROP INDEX IF EXISTS idx_openai_tokens_user_id;   -- superseded by the unique index
CREATE UNIQUE INDEX IF NOT EXISTS uq_openai_tokens_user_id ON openai_tokens (user_id);

-- If a bot somehow has several running imports, keep the newest one
UPDATE catalog_sources s
SET    status = 'failed', error = 'Superseded by a newer import'
WHERE  s.status IN ('pending', 'processing')
  AND  EXISTS (
         SELECT 1 FROM catalog_sources n
         WHERE  n.bot_id = s.bot_id
           AND  n.status IN ('pending', 'processing')
           AND  (n.created_at > s.created_at OR (n.created_at = s.created_at AND n.id > s.id))
       );

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_sources_one_running
    ON catalog_sources (bot_id)
    WHERE status IN ('pending', 'processing');

COMMIT;
