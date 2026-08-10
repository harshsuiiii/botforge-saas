ALTER TABLE users
    ADD COLUMN IF NOT EXISTS default_spend_cap NUMERIC(12, 6);

COMMENT ON COLUMN users.default_spend_cap IS
    'Default monthly OpenAI spend cap (USD) set during onboarding.';
