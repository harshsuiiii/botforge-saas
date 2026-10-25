# BotForge -- SaaS Chatbot Platform

## Stack
- **Backend**: Node.js ≥ 20.18.1, Express 4.21, PostgreSQL 15+ with pgvector (pg 8.13)
- **Frontend**: React 18, Vite 5, Tailwind CSS 3, react-router-dom 6
- **Auth**: Passport Google OAuth2 → single-use login code → JWT; optional local dev sign-in
- **AI**: OpenAI via each owner's own API key (chat, embeddings, catalog extraction)

## Project Structure
```
server.js               # Express entry point (port 3000)
auth/
  db.js                 # PG connection pool (single export)
  google.js             # Google OAuth, /auth/google, /auth/exchange, /auth/me
  login-codes.js        # 60-second single-use login codes (no JWTs in URLs)
  dev-login.js          # DEV_LOGIN localhost-only sign-in
  middleware.js         # JWT verify middleware
  openai-key.js         # Connect OpenAI by API key (/auth/openai/*)
  openai-project.js     # OpenAI project provisioning (/openai/*)
  token-crypto.js       # AES-256-GCM encrypt/decrypt of stored OpenAI keys
bots/
  bots.js               # Bot CRUD routes (/api/bots)
  ownership.js          # requireBotOwner / loadOwnedBot guard
  system-prompt.js      # Assembles GPT system prompt from bot fields
catalog/
  routes.js             # Catalog import API (/api/bots/:id/catalog)
  ingest.js             # Import pipeline: parse → extract → diff → embed → save
  parsers/              # spreadsheet.js, pdf.js, website.js (SSRF-guarded crawler)
  extract.js, embed.js  # LLM extraction and batched embeddings
  search.js, tools.js   # Hybrid pgvector search and the chat search tools
  url-guard.js          # Blocks private/internal addresses, incl. at connect time
chat/
  chat.js               # Public chat endpoint (/chat), SSE streaming + tools
  rate-limit.js         # In-memory /chat rate limits
analytics/
  analytics.js          # Dashboard metrics, sessions, topics, unanswered questions
topic-detection/
  detect-topic.js       # Topic classification helper (not wired in)
public/
  widget.js             # Embed widget (static asset)
schema.sql              # Base schema
migrations/
  002_bots_system_prompt.sql
  003_users_default_spend_cap.sql
  004_embed_configs_unique_bot.sql
  005_catalog.sql       # pgvector + catalog tables (needs DB-owner rights)
  006_unique_tokens_and_running_imports.sql
test/                   # node:test suites; DB tests run on in-memory PGlite
client/
  src/
    main.jsx            # React entry
    App.jsx             # Router definition
    config/api.js       # API base URL
    config/signIn.js    # Login-code exchange
    context/AuthContext.jsx  # Auth state
    hooks/useApi.js, useBots.js
    components/         # Reusable UI components
    pages/              # Route pages
```

## Database
- Tables: `users`, `openai_tokens`, `bots`, `sessions`, `embed_configs`, `catalog_sources`, `catalog_products`, `catalog_info`, `unanswered_questions`
- Apply `schema.sql`, then `migrations/*.sql` in order
- OpenAI keys encrypted with AES-256-GCM (BYTEA + IV), one per user
- Bots soft-deleted via `deleted_at` column
- `sessions.messages` stored as JSONB
- `updated_at` triggers on `openai_tokens`, `catalog_sources`, `catalog_products`
- Every catalog query is scoped by `bot_id`

## Conventions
- Backend is **CommonJS** (`'use strict'`, `require`, `module.exports`); frontend is ES modules
- Route files export Express Router objects
- JWT in `Authorization: Bearer <token>` header via `auth/middleware.js`
- The frontend calls the API at `API_URL` (default `http://localhost:3000`); Vite also proxies `/api` and `/auth` (except `/auth/callback`)
- `require('dotenv').config()` at top of `server.js`
- Tests: `npm test` (Node ≥ 21 for the glob); write the failing test first
- Button: `bg-white text-black border border-gray-300 rounded-lg px-5 py-2.5 hover:bg-gray-50 transition-colors`
- Danger button: `bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors`
- Card: `bg-white rounded-2xl shadow-sm border border-gray-200 p-6`

## Key Environment Variables
```
DATABASE_URL
JWT_SECRET
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL
TOKEN_ENCRYPTION_KEY      # 64 hex chars
FRONTEND_URL
NODE_ENV / PORT
DEV_LOGIN                 # 'true' enables local dev sign-in (never in production)
```

## Key Commands
```bash
docker start botforge-postgres   # local Postgres + pgvector (port 5432)
node server.js                   # Start backend (port 3000)
npm run client                   # Start frontend dev (port 5173)
npm test                         # Backend test suite
npm run client:build             # Build frontend for production
```
