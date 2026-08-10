# BotForge -- SaaS Chatbot Platform

## Stack
- **Backend**: Node.js, Express 4.21, PostgreSQL 15+ (pg 8.13)
- **Frontend**: React 18, Vite 5, Tailwind CSS 3, react-router-dom 6
- **Auth**: Passport Google OAuth2 + JWT, OpenAI OAuth for API keys
- **AI**: OpenAI GPT via proxy routes

## Project Structure
```
server.js               # Express entry point (port 3000)
auth/
  db.js                 # PG connection pool (single export)
  google.js             # Google OAuth + /auth/google routes
  middleware.js         # JWT verify middleware
  openai-oauth.js       # OpenAI OAuth code flow
  openai-project.js     # OpenAI API proxy (/openai/*)
bots/
  bots.js               # Bot CRUD routes (/api/bots)
  system-prompt.js      # Assembles GPT system prompt from bot fields
chat/
  chat.js               # Chat endpoint (/chat)
analytics/
  analytics.js          # Dashboard metrics (/api/analytics)
topic-detection/
  detect-topic.js       # Topic classification middleware
public/
  widget.js             # Embed widget (static asset)
migrations/
  002_bots_system_prompt.sql
  003_users_default_spend_cap.sql
client/
  src/
    main.jsx            # React entry
    App.jsx             # Router definition
    config/api.js       # Axios/fetch wrapper
    context/AuthContext.jsx  # Auth state
    hooks/useApi.js     # API hook
    components/         # Reusable UI components
    pages/              # Route pages
```

## Database
- 6 tables: `users`, `openai_tokens`, `bots`, `sessions`, `embed_configs`, `migrations`
- OpenAI tokens encrypted with AES-256-GCM (BYTEA + IV)
- Bots soft-deleted via `deleted_at` column
- `sessions.messages` stored as JSONB
- `updated_at` auto-update trigger on all tables

## Conventions
- ES modules (`import`/`export`) on backend and frontend
- Route files export Express Router objects
- JWT in `Authorization: Bearer <token>` header via `auth/middleware.js`
- Frontend proxies `/api` and `/auth` to backend via Vite config
- Use `dotenv/config` at top of `server.js`
- Button: `bg-white text-black border border-gray-300 rounded-lg px-5 py-2.5 hover:bg-gray-50 transition-colors`
- Danger button: `bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors`
- Card: `bg-white rounded-2xl shadow-sm border border-gray-200 p-6`

## Key Environment Variables
```
DATABASE_URL
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
JWT_SECRET
OPENAI_OAUTH_CLIENT_ID / OPENAI_OAUTH_CLIENT_SECRET
FRONTEND_URL
SESSION_ENCRYPTION_KEY
```

## Key Commands
```bash
node server.js              # Start backend (port 3000)
cd client && npm run dev    # Start frontend dev (port 5173)
cd client && npm run build  # Build frontend for production
```
