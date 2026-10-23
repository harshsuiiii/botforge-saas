# Catalog RAG — Design

**Date:** 2026-10-23
**Status:** Approved in conversation; awaiting written-spec review
**Branch:** `feat/catalog-rag` (based on `fix/core-flow-bugs`, which is not yet merged)

## 1. Goal

Make each BotForge bot specific to its business by letting the owner give the bot a **product catalog**. Website visitors then get answers built from that catalog: real products, exact prices and stock, and the business's own policies, instead of generic GPT answers.

**Done means:** an owner uploads a catalog. A visitor asks the widget "waterproof jacket under ₹3000?" and gets real matching products from that business, shown as product cards. If nothing matches, the bot says so, and the question is logged for the owner.

### Decisions (from the user)

| Topic | Decision |
|---|---|
| Catalog formats | CSV/Excel upload, PDF upload, and website URL crawl |
| Database | Hosted Postgres with the `pgvector` extension |
| Strictness | Per-bot setting: **Strict** answers only from the catalog; **Flexible** also answers general questions but never invents products, prices or stock |
| V1 extras | Product cards in the widget, an unanswered-questions log, and re-sync that only re-embeds changed products |
| Retrieval approach | **A.** The model calls search tools; the server runs filtered vector + keyword search in SQL |

### Assumptions (confirmed with the user)

- Embedding, extraction and chat costs are paid with the **bot owner's connected OpenAI key**, the same as chats today. Platform-supplied AI is a separate later project.
- Product facts (price, stock, URL) always come from the database, never from the model.
- **Every catalog read and write is filtered by `bot_id`.** One business's catalog must never appear in another business's bot.
- PDF and website text goes through an LLM extraction step that produces product records plus "info" text (policies, FAQ, about).
- Imports run in the background, in the server process, with their status kept in the database. No external job queue.

### Out of scope

Shopify/WooCommerce sync, platform-supplied AI and billing, WhatsApp, teams, the live inbox, and per-bot widget branding. Each is a later project.

## 2. Architecture

New backend module `catalog/`, following the existing router-per-feature layout (CommonJS, `'use strict'`, Express `Router`, express-validator):

| File | Responsibility | Depends on |
|---|---|---|
| `catalog/routes.js` | Owner-only REST API for sources, products preview | `auth/middleware`, `auth/db`, `catalog/ingest` |
| `catalog/ingest.js` | Run one import: parse → extract → diff → embed → save; status transitions | parsers, `extract`, `embed`, `auth/token-crypto` |
| `catalog/parsers/spreadsheet.js` | CSV/XLSX → product rows, with header aliasing | `exceljs`, `csv-parse` |
| `catalog/parsers/pdf.js` | PDF → plain text | `pdf-parse` |
| `catalog/parsers/website.js` | Same-domain crawl → page text, SSRF-guarded | `cheerio`, `catalog/url-guard` |
| `catalog/url-guard.js` | Reject localhost, private, link-local and metadata addresses (checked again on every redirect) | `dns`, `net` |
| `catalog/extract.js` | LLM structured extraction: text → `{ products, info }` | OpenAI HTTP API |
| `catalog/embed.js` | Batched embeddings (`text-embedding-3-small`, 1536 dims, ≤100 inputs/call) | OpenAI HTTP API |
| `catalog/search.js` | `searchProducts()` and `searchInfo()`: hybrid SQL search scoped by `bot_id` | `auth/db` |
| `catalog/tools.js` | OpenAI tool definitions and the dispatcher that runs tool calls | `catalog/search` |
| `auth/token-crypto.js` | Shared `encryptToken` / `decryptToken` / `getOwnerToken(userId)` | `crypto`, `auth/db` |

**Targeted refactor:** the AES-GCM helpers are currently copied in `auth/openai-oauth.js`, `auth/openai-project.js` and `chat/chat.js`. All three switch to `auth/token-crypto.js`.

The OpenAI calls use `fetch` directly, the same way `chat/chat.js` does today. No `openai` SDK dependency.

## 3. Data model — `migrations/005_catalog.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS answer_mode TEXT NOT NULL DEFAULT 'flexible'
      CHECK (answer_mode IN ('strict', 'flexible')),
  ADD COLUMN IF NOT EXISTS fallback_message TEXT;

CREATE TABLE catalog_sources (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id         UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('spreadsheet', 'pdf', 'url')),
  name           TEXT NOT NULL,                 -- file name or URL
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error          TEXT,
  item_count     INTEGER NOT NULL DEFAULT 0,    -- products + info chunks
  last_synced_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE catalog_products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
  external_key  TEXT NOT NULL,                  -- SKU, else normalized name
  name          TEXT NOT NULL,
  category      TEXT,
  description   TEXT,
  price         NUMERIC(12, 2),
  currency      TEXT NOT NULL DEFAULT 'INR',
  in_stock      BOOLEAN,                        -- NULL = unknown
  url           TEXT,
  image_url     TEXT,
  attributes    JSONB NOT NULL DEFAULT '{}',
  content_hash  TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple',
                    coalesce(name, '') || ' ' || coalesce(category, '') || ' ' ||
                    coalesce(description, '') || ' ' || external_key)
                ) STORED,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, external_key)
);

CREATE TABLE catalog_info (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  url           TEXT,
  content_hash  TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple', title || ' ' || content)
                ) STORED,
  UNIQUE (source_id, content_hash)
);

CREATE TABLE unanswered_questions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id       UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  session_id   UUID,
  question     TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('no_results', 'fallback')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);
```

Indexes: `catalog_sources(bot_id)`; `catalog_products(bot_id)`, `(bot_id, price)`, HNSW on `embedding vector_cosine_ops`, GIN on `search_tsv`; `catalog_info(bot_id)`, HNSW on `embedding`, GIN on `search_tsv`; `unanswered_questions(bot_id, created_at DESC) WHERE resolved_at IS NULL`. `updated_at` triggers on `catalog_sources` and `catalog_products` reuse `trigger_set_updated_at()` from `schema.sql`.

The language config is `'simple'` rather than `'english'`, because catalogs mix English, Hinglish and SKUs, and stemming would mangle product names.

## 4. Import pipeline

### 4.1 Starting and status
- `POST /api/bots/:id/catalog/sources` accepts either a multipart `file` (`multer` memory storage, 10 MB limit; `.csv`, `.xlsx`, `.pdf` by extension **and** MIME type) or JSON `{ url }` (http/https only, passing `url-guard`).
- It rejects with `409` if the owner has no OpenAI token, and with `429` if this bot already has an import that is `pending` or `processing`.
- It inserts a `catalog_sources` row with status `pending`, responds `202 { source }`, then starts `ingest.run(sourceId, payload)` with `setImmediate`. The uploaded file stays in memory only until parsing ends; it is never written to disk or the database.
- `ingest.run` moves status from `pending` to `processing`, then to `ready` (setting `item_count` and `last_synced_at`) or `failed` (with a readable `error`). An import that fails **does not delete** the source's previous data.
- On server start, `UPDATE catalog_sources SET status = 'failed', error = 'Interrupted by server restart' WHERE status IN ('pending', 'processing')`.

### 4.2 Parsing
- **Spreadsheet:** XLSX via `exceljs` (first worksheet), CSV via `csv-parse`. Headers are lower-cased and trimmed, then aliased:
  - `name` ← name, title, product, product name, item
  - `price` ← price, mrp, cost, selling price, amount
  - `in_stock` ← stock, qty, quantity, availability, in stock
  - `category`, `description`, `sku`, `url` ← url, link, product url; `image_url` ← image, image url, photo
  - `currency` (optional column; defaults to `INR`)
  - Any other column goes into `attributes`.
  - Price parsing strips currency symbols and thousands separators. Stock maps numbers > 0 or yes/true/in stock/available to `true`, and 0 or no/false/out of stock/sold out to `false`; anything else is `NULL`.
  - Rows without a name are skipped and counted, and the count appears in the source's status message.
  - No LLM is involved for spreadsheets.
- **PDF:** `pdf-parse` text, then extraction (4.3).
- **Website:** BFS crawl from the given URL. Same hostname only, depth ≤ 2, ≤ 50 pages, 10 s timeout per page, HTML responses ≤ 2 MB. `url-guard` validates the resolved IP before every request and after every redirect (manual redirect handling, ≤ 5 hops). Visible text comes from `cheerio`, with `script`, `style`, `nav` and `footer` removed. Each page's URL is kept so info chunks and products can link back to it. Then extraction (4.3).

### 4.3 Extraction (PDF and website)
- The text is split into ~3,000-token windows (approximated as 12,000 characters) on paragraph boundaries.
- Each window goes to `gpt-4o-mini` with a JSON-schema `response_format` (structured outputs), `temperature: 0`. The schema returns `{ products: [{ name, category, description, price, currency, in_stock, sku, url, image_url, attributes }], info: [{ title, content }] }`.
- The prompt says to extract only what is explicitly in the text, to never guess prices, and to set unknown fields to null.
- Products from different windows that share an `external_key` are merged, with later non-null fields winning.

### 4.4 Diff, embed and save
- `external_key` = `sku` if present, else the lower-cased name with whitespace collapsed.
- `content_hash` = SHA-256 of a canonical JSON of the product fields (or of info `title` + `content`).
- Inside one transaction per source:
  - **New** products, and products whose hash changed, are embedded and upserted.
  - **Unchanged** products are left alone (no embedding call).
  - Products of this source that are missing from the new import are deleted. Info chunks follow the same rules, keyed by `content_hash`.
- Embedding text for a product is `name · category · description · key: value attributes · price currency`. For info it is `title\ncontent`.
- **Limits:** if an import would bring the bot over 5,000 products or 2,000 info chunks in total, the import fails with a clear error before any embedding call.

### 4.5 Re-sync
- `POST /api/bots/:id/catalog/sources/:sid/resync`. URL sources re-crawl. File sources require a new multipart `file` of the same kind in the same request.
- Re-sync runs the same pipeline, so only changed rows are re-embedded.

## 5. Chat flow

### 5.1 When tools are active
`chat.js` loads `answer_mode`, `fallback_message`, and whether the bot has at least one `ready` source. With no ready source, the current behaviour is unchanged: no tools, the same prompt.

### 5.2 Prompt additions
A catalog section is appended to the bot's stored `system_prompt` at request time. The stored prompt is not changed.
- **Strict:** "Answer only using results returned by `search_products` and `search_info`. Always search before answering a question about the business. If the results contain nothing relevant, reply exactly with: {fallback_message}". If `fallback_message` is empty, a default is used: "I'm sorry, I couldn't find that in our catalog. Please contact us for help."
- **Flexible:** "Use `search_products` for anything about products, prices or stock, and `search_info` for policies or business details. Never state a product, price or stock level that a tool did not return. You may answer general questions from your own knowledge."
- **Both modes:** "Prices and stock in tool results are authoritative. Do not list more than 4 products; the user will see product cards for the products you were given."

### 5.3 Tools
```text
search_products({ query: string, min_price?: number, max_price?: number,
                  category?: string, in_stock?: boolean,
                  sort?: 'relevance' | 'price_asc' | 'price_desc' })
search_info({ query: string })
```

### 5.4 Streaming loop
1. **Call 1:** `stream: true`, `tools`, `tool_choice: 'auto'`, temperature 0.3. Content deltas are forwarded to the widget as `{ delta }`, as today. `tool_calls` deltas are collected by index (id, name, argument pieces).
2. If the stream finishes with `finish_reason: 'tool_calls'`:
   - parse the arguments (invalid JSON becomes a tool result of `{ error: 'invalid arguments' }`)
   - run up to 3 calls in parallel
   - append the assistant `tool_calls` message and the `tool` result messages
   - run **call 2** the same way
3. After at most **2 tool rounds**, the next call is made with `tool_choice: 'none'`, which forces a text answer.
4. Tool results sent back to the model contain product `id, name, category, price, currency, in_stock, description` (truncated to 300 characters) and `url`, or info `title, content` (truncated to 800 characters) and `url`.

### 5.5 Search (`catalog/search.js`)
```sql
-- searchProducts(botId, { query, min_price, max_price, category, in_stock, sort }, queryEmbedding)
WITH scored AS (
  SELECT p.*,
         1 - (p.embedding <=> $2)                                    AS similarity,
         ts_rank(p.search_tsv, plainto_tsquery('simple', $3))        AS keyword_rank,
         p.search_tsv @@ plainto_tsquery('simple', $3)               AS keyword_hit
  FROM catalog_products p
  WHERE p.bot_id = $1
    AND ($4::numeric IS NULL OR p.price >= $4)
    AND ($5::numeric IS NULL OR p.price <= $5)
    AND ($6::text    IS NULL OR p.category ILIKE '%' || $6 || '%')
    AND ($7::boolean IS NULL OR p.in_stock = $7)
)
SELECT *, 0.7 * similarity + 0.3 * LEAST(keyword_rank, 1) AS score
FROM scored
WHERE similarity >= 0.25 OR keyword_hit
ORDER BY <score DESC | price ASC NULLS LAST | price DESC NULLS LAST>
LIMIT 8;
```
- `ORDER BY` is chosen from a fixed whitelist on `sort`. It is never built from user text.
- `searchInfo` runs the same pattern on `catalog_info`, with no filters, `LIMIT 4`.
- The similarity threshold (0.25) and weights (0.7/0.3) are named constants in `search.js`, to be tuned with real data.

### 5.6 Product cards
- Before `[DONE]`, the server sends one SSE event `{ products: [...] }`: unique products from this turn's `search_products` results, in result order, at most 4. Each card has `id, name, price, currency, in_stock, url, image_url`.
- No event is sent if there were no product results.
- The saved assistant message in `sessions.messages` gets an extra `product_ids` array. `loadSessionHistory` still sends only `{ role, content }` to OpenAI.

### 5.7 Unanswered questions
A row is inserted (async, best effort, never blocking the stream) when either:
- **`no_results`:** at least one search ran in the turn and every search returned zero rows, or
- **`fallback`:** in Strict mode, the final reply text contains the fallback message.

### 5.8 Errors
- A failure in a search (embedding or DB) returns `{ error: 'search unavailable' }` as the tool result, and the model apologises. The stream never crashes.
- A failure in call 2 after streaming has started writes a short error delta, then `[DONE]`.
- The existing pre-stream error responses (502/503) are unchanged.

## 6. API

All routes use `authMiddleware` and the bot-ownership check (`requireBotOwner` moves from `bots/bots.js` into `bots/ownership.js` so `catalog/routes.js` can reuse it). Params are validated as UUIDs.

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/bots/:id/catalog/sources` | — | `{ sources: [...] }` |
| `POST /api/bots/:id/catalog/sources` | multipart `file` or `{ url }` | `202 { source }` |
| `POST /api/bots/:id/catalog/sources/:sid/resync` | multipart `file` (file sources only) | `202 { source }` |
| `DELETE /api/bots/:id/catalog/sources/:sid` | — | `204` |
| `GET /api/bots/:id/catalog/products` | `search`, `page`, `limit≤100` | `{ products, pagination }` |
| `GET /api/analytics/unanswered` | `bot_id`, `range` | `{ questions: [{ question, count, last_asked, ids }] }`, grouped by normalized question text |
| `POST /api/analytics/unanswered/:id/resolve` | — | `204`; resolves every unresolved row with the same normalized text for that bot |
| `GET /api/analytics/sessions/:session_id` *(changed)* | — | Also returns `products: { [id]: card }` for every `product_ids` entry in the transcript that still exists |

`PUT /api/bots/:id` also accepts `answer_mode` (`strict` or `flexible`) and `fallback_message` (≤ 500 chars).

## 7. Frontend

- **Sidebar:** a new "Catalog" item (`/dashboard/catalog`) between Topics and Settings.
- **`pages/Catalog.jsx`:**
  - a `BotSelector`
  - an upload dropzone for CSV/XLSX/PDF, plus an "Add website" URL field
  - a sources table with name, kind, status badge, items, last synced, error, and Re-sync / Delete buttons. It polls `GET sources` every 3 s while any source is pending or processing.
  - a searchable, paginated product preview table
- **`pages/Settings.jsx`:** a Strict/Flexible segmented toggle and a fallback message textarea, saved with the existing form.
- **`pages/Topics.jsx`:** an "Unanswered questions" card listing the question, count and last asked time, with a "Mark resolved" button.
- **`components/SessionDrawer.jsx`:** shows product cards for assistant messages that have `product_ids`. The session endpoint returns the matching product rows that still exist.
- **`useApi`:** `apiFetch` must not set `Content-Type` for `FormData` bodies. Today it sets JSON whenever there is a body.

## 8. Widget (`public/widget.js`)

- It handles a `{ products }` SSE event by rendering up to 4 cards under the current bot bubble, as a horizontal scroll row on narrow screens.
- Each card shows the image (lazy, hidden if it fails to load), the name, the price formatted with `Intl.NumberFormat(undefined, { style: 'currency', currency })`, an "Out of stock" badge when `in_stock === false`, and a **View** link (`target="_blank" rel="noopener noreferrer"`).
- It uses DOM APIs and `textContent` only, never `innerHTML` for card data.
- `url` and `image_url` are used only if `new URL(x).protocol` is `http:` or `https:`. Otherwise the link or image is omitted.
- Styles use the `bf-` prefix, matching the existing widget theme.

## 9. Security and isolation

- Every catalog query has `bot_id = $1`, with the bot resolved through ownership (dashboard) or the embed key (chat). There is no cross-bot search path.
- SSRF: `url-guard` blocks `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (cloud metadata), `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped forms of these. It checks every DNS-resolved address before connecting and on each redirect.
- Upload limits: 10 MB, an extension and MIME type allowlist, in memory only.
- The SQL `ORDER BY` comes from a whitelist. All values are parameterized.
- Product URLs and images are filtered to http(s) in both the widget and the dashboard.

## 10. Testing

Uses Node's built-in test runner. `package.json` gets `"test": "node --test test/"`.

**Unit tests:**
- spreadsheet header aliasing, plus price and stock parsing
- `external_key` and `content_hash` stability
- `url-guard` (private, metadata and IPv6 cases, and a redirect to a private address)
- the window splitter
- the widget URL filter (extracted as a small pure function and tested by loading `widget.js` in `node:vm`)

**Integration tests:** PGlite with the `vector` extension, and an OpenAI `fetch` stub that returns fixed embeddings and fixed chat streams. They cover:
1. a spreadsheet import, then a re-sync with one changed price, which embeds only that row
2. `searchProducts` price, stock and category filters, plus isolation: a second bot's products are never returned
3. a `/chat` turn where call 1 returns a `search_products` tool call and call 2 streams text, with the SSE output containing `delta` events, then one `products` event, then `[DONE]`
4. Strict mode with no results, which streams the fallback and inserts an `unanswered_questions` row
5. a failed import, which keeps the previous products

**Frontend:** `npm run client:build` must pass, plus a manual check in the browser: the Catalog page, polling, the Settings toggle, the Unanswered card, and widget cards.

## 11. New dependencies

- **Runtime:** `multer`, `exceljs`, `csv-parse`, `pdf-parse`, `cheerio`
- **Dev:** `@electric-sql/pglite`

## 12. Rollout

1. Run `CREATE EXTENSION vector` on the hosted DB (this needs DB-owner rights), then `migrations/005_catalog.sql`.
2. Add migration 005 to the README's migration list.
3. Existing bots are unaffected until they add a catalog source. Their default `answer_mode` is `flexible`.
