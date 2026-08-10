# BotForge

BotForge is a multi-tenant SaaS platform for creating, embedding, and monitoring AI chatbots. It combines a React dashboard, an Express API, PostgreSQL persistence, Google sign-in, OpenAI account connection, and an embeddable streaming chat widget.

## What it does

- Creates and manages chatbot configurations, including behavior, allowed topics, blocked topics, model, and budget settings.
- Authenticates dashboard users with Google OAuth and JWTs.
- Connects an OpenAI account and encrypts stored access tokens with AES-256-GCM.
- Serves a copy-paste widget that streams chatbot responses over Server-Sent Events (SSE).
- Records sessions, detected topics, outcomes, and turn counts for dashboard analytics.

## Architecture

```text
React dashboard ──JWT──> Express API ──> PostgreSQL
Embeddable widget ─────> /chat (SSE) ─> OpenAI
                                  └──> session analytics
```

The backend modules are organized as follows:

| Path | Responsibility |
| --- | --- |
| `server.js` | Express application, CORS, route registration, static widget hosting |
| `auth/` | Google OAuth, OpenAI OAuth, JWT verification, PostgreSQL pool |
| `bots/` | Authenticated chatbot CRUD and embed-key management |
| `chat/` | Public widget chat endpoint, topic checks, OpenAI streaming, sessions |
| `analytics/` | Authenticated dashboard metrics and session-log APIs |
| `public/widget.js` | Standalone browser widget loaded by customer sites |
| `client/` | React/Vite dashboard |
| `schema.sql`, `migrations/` | PostgreSQL schema and incremental database changes |

## Prerequisites

- Node.js 18 or later
- PostgreSQL 15 or later
- Google OAuth credentials
- OpenAI OAuth credentials and an OpenAI account/API authorization suitable for the configured model

## Local setup

1. Install backend dependencies:

   ```bash
   npm install
   ```

2. Install frontend dependencies:

   ```bash
   npm install --prefix client
   ```

3. Create a database and apply the base schema, then migrations in numeric order:

   ```bash
   psql "$DATABASE_URL" -f schema.sql
   psql "$DATABASE_URL" -f migrations/002_bots_system_prompt.sql
   psql "$DATABASE_URL" -f migrations/003_users_default_spend_cap.sql
   ```

4. Copy `.env.example` to `.env` and replace every placeholder. Do not commit `.env`.

5. Configure OAuth redirect URIs to match your local values:

   - Google: `http://localhost:3000/auth/google/callback`
   - OpenAI: `http://localhost:3000/auth/openai/callback`

6. Start the API and dashboard in separate terminals:

   ```bash
   npm run dev
   npm run client
   ```

   The API runs on `http://localhost:3000`; Vite serves the dashboard at `http://localhost:5173`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used to sign dashboard JWTs |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google OAuth configuration |
| `OPENAI_CLIENT_ID`, `OPENAI_CLIENT_SECRET`, `OPENAI_CALLBACK_URL` | OpenAI OAuth configuration |
| `TOKEN_ENCRYPTION_KEY` | 64-character hexadecimal AES-256-GCM encryption key |
| `FRONTEND_URL` | Dashboard origin for CORS and OAuth redirects |
| `NODE_ENV`, `PORT` | Runtime environment and API port |

Use `openssl rand -hex 32` or Node's `crypto.randomBytes(32).toString('hex')` to generate `TOKEN_ENCRYPTION_KEY`.

## Production readiness

This project is a strong MVP foundation, but the following should be completed before public production traffic:

- Add rate limiting, bot/tenant quotas, abuse controls, and strict origin allowlist enforcement to `/chat`.
- Enforce per-bot spend limits before calling OpenAI; the database field alone does not stop usage.
- Replace JWT-in-URL OAuth flow with short-lived, server-side, single-use OAuth state; avoid storing long-lived browser tokens in `localStorage`.
- Establish transcript retention/deletion policies and cap conversation history sent to the model.
- Add TLS/reverse-proxy configuration, security headers, structured observability, backups with restore tests, CI, and automated tests.

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Start the API |
| `npm run dev` | Run the API with Node watch mode |
| `npm run client` | Run the Vite dashboard |
| `npm run client:build` | Build the dashboard for production |

## Security notes

OpenAI tokens are encrypted at rest with AES-256-GCM. Keep `TOKEN_ENCRYPTION_KEY`, OAuth secrets, database credentials, and `JWT_SECRET` in a managed secret store in production. Rotate embed keys and credentials if they are exposed.

## License

No license has been added yet. Add one before distributing the project publicly.
