-- =============================================================
-- BotForge – PostgreSQL 15 Database Schema
-- Generated: 2026-06-11
-- =============================================================

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================
-- ENUM TYPES
-- =============================================================

CREATE TYPE session_outcome AS ENUM (
    'resolved',
    'escalated',
    'abandoned',
    'blocked'
);

-- =============================================================
-- TABLE: users
-- =============================================================

CREATE TABLE users (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT        NOT NULL UNIQUE,
    google_id   TEXT        UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- TABLE: openai_tokens
-- Stores AES-encrypted OpenAI API tokens per user.
-- `iv` holds the initialisation vector used during encryption.
-- =============================================================

CREATE TABLE openai_tokens (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_token BYTEA       NOT NULL,
    iv              BYTEA       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- TABLE: bots
-- =============================================================

CREATE TABLE bots (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    personality         TEXT,
    purpose             TEXT,
    instructions        TEXT,
    topic_allow_list    TEXT[]      NOT NULL DEFAULT '{}',
    topic_block_list    TEXT[]      NOT NULL DEFAULT '{}',
    spend_cap           NUMERIC(12, 6),                        -- USD cap per billing period
    model               TEXT        NOT NULL DEFAULT 'gpt-4o',
    openai_project_id   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- TABLE: sessions
-- One row per chat session with a bot.
-- `messages` stores the full turn-by-turn conversation as JSONB.
-- `topics_detected` is populated by topic-classification middleware.
-- =============================================================

CREATE TABLE sessions (
    session_id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id              UUID            NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_fingerprint    TEXT            NOT NULL,              -- anonymous visitor identifier
    started_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    ended_at            TIMESTAMPTZ,
    turn_count          INTEGER         NOT NULL DEFAULT 0,
    outcome             session_outcome,
    blocked             BOOLEAN         NOT NULL DEFAULT FALSE,
    messages            JSONB           NOT NULL DEFAULT '[]',
    topics_detected     TEXT[]          NOT NULL DEFAULT '{}'
);

-- =============================================================
-- TABLE: embed_configs
-- Governs where each bot widget may be embedded.
-- `embed_key` is the public key sent with every widget request.
-- `domain_allowlist` restricts valid embedding origins.
-- =============================================================

CREATE TABLE embed_configs (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id          UUID    NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,  -- one embed config per bot
    embed_key      TEXT    NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'base64'),
    domain_allowlist TEXT[] NOT NULL DEFAULT '{}'
);

-- =============================================================
-- INDEXES
-- =============================================================

-- users
CREATE INDEX idx_users_email        ON users(email);
CREATE INDEX idx_users_google_id    ON users(google_id);

-- openai_tokens
CREATE INDEX idx_openai_tokens_user_id ON openai_tokens(user_id);

-- bots
CREATE INDEX idx_bots_user_id      ON bots(user_id);
CREATE INDEX idx_bots_created_at   ON bots(created_at);

-- sessions
CREATE INDEX idx_sessions_bot_id       ON sessions(bot_id);
CREATE INDEX idx_sessions_started_at   ON sessions(started_at);
CREATE INDEX idx_sessions_bot_started  ON sessions(bot_id, started_at DESC); -- composite for per-bot history queries
CREATE INDEX idx_sessions_fingerprint  ON sessions(user_fingerprint);
CREATE INDEX idx_sessions_messages_gin ON sessions USING GIN (messages);      -- fast JSONB queries
CREATE INDEX idx_sessions_topics_gin   ON sessions USING GIN (topics_detected); -- fast array containment queries

-- embed_configs (bot_id is covered by its UNIQUE constraint)
CREATE INDEX idx_embed_configs_embed_key ON embed_configs(embed_key);

-- =============================================================
-- TRIGGERS: updated_at auto-maintenance
-- =============================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER set_openai_tokens_updated_at
BEFORE UPDATE ON openai_tokens
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================
-- COMMENTS
-- =============================================================

COMMENT ON TABLE users             IS 'BotForge platform users (Google OAuth or email/password).';
COMMENT ON TABLE openai_tokens     IS 'Encrypted OpenAI API keys – one active token per user.';
COMMENT ON TABLE bots              IS 'Bot definitions created and owned by platform users.';
COMMENT ON TABLE sessions          IS 'End-user chat sessions with a deployed bot widget.';
COMMENT ON TABLE embed_configs     IS 'Widget embed configuration: public key + allowed origins.';

COMMENT ON COLUMN openai_tokens.encrypted_token IS 'AES-256-GCM ciphertext of the raw OpenAI API key.';
COMMENT ON COLUMN openai_tokens.iv              IS 'Unique initialisation vector (nonce) used for encryption.';
COMMENT ON COLUMN bots.spend_cap               IS 'Maximum USD spend allowed per billing period; NULL = unlimited.';
COMMENT ON COLUMN sessions.user_fingerprint    IS 'Anonymous browser fingerprint – not linked to a platform user account.';
COMMENT ON COLUMN sessions.messages            IS 'Array of {role, content, ts} objects representing the conversation.';
COMMENT ON COLUMN sessions.topics_detected     IS 'Topics identified by the classifier during this session.';
COMMENT ON COLUMN embed_configs.embed_key      IS 'Public widget key sent in every embed request for bot lookup and auth.';
COMMENT ON COLUMN embed_configs.domain_allowlist IS 'Allowed origins (e.g. https://example.com). Empty = unrestricted.';
