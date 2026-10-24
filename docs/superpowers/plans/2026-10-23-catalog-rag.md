# Catalog RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a bot owner import a product catalog (CSV/XLSX, PDF, or website), so the bot answers visitors from that catalog, with exact prices and stock, product cards in the widget, and a log of unanswered questions.

**Architecture:** A new `catalog/` backend module imports and embeds catalog data into pgvector tables scoped by `bot_id`. `chat/chat.js` gives the model two search tools (`search_products`, `search_info`) that run hybrid vector + keyword SQL, streams the answer, and emits a `products` event for widget cards. The dashboard gets a Catalog page, a Strict/Flexible setting, and an Unanswered questions panel.

**Tech Stack:** Node ≥ 18 (tests need ≥ 21 for `--test` globs; dev machine has 24), Express 4, `pg`, Postgres + pgvector, OpenAI HTTP API via `fetch`, `multer`, `exceljs`, `csv-parse`, `pdf-parse`, `cheerio`. React 18 + Vite + Tailwind for the dashboard. `node:test` + `@electric-sql/pglite` for tests.

**Spec:** `docs/superpowers/specs/2026-10-23-catalog-rag-design.md`. Read it alongside this plan. Section references below (§N) point into it.

## Global Constraints

- Backend files are **CommonJS** with `'use strict'`, `require`, `module.exports`, and Express `Router`. Match the existing files, not the AGENTS.md "ES modules" note.
- **Every catalog SQL statement filters on `bot_id = $1`**, and that bot ID is always resolved through ownership (dashboard) or the embed key (chat).
- OpenAI is called with `fetch`; no `openai` SDK. The owner's token comes from `getOwnerToken(userId)` (Task 1).
- Models and parameters:
  - extraction: `gpt-4o-mini`, `temperature: 0`, `response_format` JSON schema
  - embeddings: `text-embedding-3-small`, 1536 dims, ≤ 100 inputs per call
  - chat: `temperature: 0.3`, ≤ 2 tool rounds, ≤ 3 tool calls per round, then `tool_choice: 'none'`
- Limits:
  - upload: 10 MB; `.csv`, `.xlsx`, `.pdf` checked by extension **and** MIME type
  - crawl: same hostname, depth ≤ 2, ≤ 50 pages, 10 s per page, ≤ 2 MB per page, ≤ 5 redirects
  - per bot: 5,000 products and 2,000 info chunks
  - extraction windows: 12,000 chars
  - tool results: description truncated to 300 chars, info content to 800
  - search: 8 product rows, 4 info rows; cards ≤ 4
  - `fallback_message` ≤ 500 chars; dashboard polls every 3 s
- Search constants: `MIN_SIMILARITY = 0.25`, `VECTOR_WEIGHT = 0.7`, `KEYWORD_WEIGHT = 0.3`. Full-text config is `'simple'`.
- The prompt text in §5.2 and the default fallback text are exact copy. Use them verbatim.
- Frontend styling follows the existing pages (indigo/slate Tailwind classes), not the AGENTS.md button snippet.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test command: `npm test`, which is `node --test "test/**/*.test.js"`. Each test file runs in its own process.

## Review Focus

1. **A CSV exported from Excel with a UTF-8 BOM:** the first header (`﻿name`) must still map to `name`. Test in Task 4.
2. **Indian and rupee price formats:** `₹1,29,999` must parse to `129999` and `Rs. 499.50` to `499.5`, not `null`. Test in Task 4.
3. **The same SKU (or same name without SKU) twice in one import:** the rows are merged and the import succeeds, with no UNIQUE violation. Tests in Tasks 4 and 8.
4. **The model sends tool arguments with wrong types** (`max_price: "3000"`, `in_stock: "yes"`, `sort: "cheapest"`): values are coerced or ignored, never a SQL error. Test in Task 9.
5. **Tool-call arguments split across many stream chunks, with text before the tool call:** the arguments are reassembled correctly and the text is still forwarded. Test in Task 11.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `auth/token-crypto.js` | create | AES-GCM encrypt/decrypt, `getOwnerToken` |
| `auth/openai-oauth.js`, `auth/openai-project.js`, `chat/chat.js` | modify | Use `token-crypto` instead of local copies |
| `migrations/005_catalog.sql` | create | pgvector, catalog tables, bot columns |
| `bots/ownership.js` | create | `requireBotOwner` (moved), `loadOwnedBot` middleware |
| `bots/bots.js` | modify | Use `ownership.js`; accept `answer_mode`, `fallback_message` |
| `catalog/normalize.js` | create | Price/stock parsing, keys, hashes, dedupe |
| `catalog/parsers/spreadsheet.js` | create | CSV/XLSX → products |
| `catalog/parsers/pdf.js` | create | PDF → text |
| `catalog/parsers/website.js` | create | Guarded same-host crawl → pages |
| `catalog/url-guard.js` | create | Block private/metadata addresses |
| `catalog/openai-client.js` | create | `openaiJson(token, path, body)` |
| `catalog/extract.js` | create | Windowing + LLM extraction |
| `catalog/embed.js` | create | Batched embeddings, vector literal, embedding text |
| `catalog/ingest.js` | create | Import orchestration, diff, limits, recovery |
| `catalog/search.js` | create | Hybrid search, filter sanitising |
| `catalog/routes.js` | create | Owner API for sources/products |
| `catalog/tools.js` | create | Tool definitions, prompt section, tool dispatcher |
| `chat/chat.js` | modify | Tool loop, products event, unanswered logging |
| `analytics/analytics.js` | modify | Unanswered endpoints; session products map |
| `server.js` | modify | Mount catalog router; run import recovery on start |
| `public/widget.js` | modify | Product cards, `safeHttpUrl` |
| `client/src/hooks/useApi.js` | modify | No JSON content type for `FormData` |
| `client/src/pages/Catalog.jsx` | create | Catalog page |
| `client/src/App.jsx`, `client/src/components/DashboardLayout.jsx` | modify | Route + nav item |
| `client/src/pages/Settings.jsx`, `client/src/pages/Topics.jsx`, `client/src/components/SessionDrawer.jsx` | modify | Strict/Flexible toggle, Unanswered card, transcript cards |
| `client/src/components/ProductCard.jsx` | create | Shared dashboard product card |
| `test/helpers/db.js`, `test/helpers/openai-stub.js`, `test/helpers/http.js` | create | Test harness |
| `test/unit/*.test.js`, `test/integration/*.test.js` | create | Tests per task |
| `package.json`, `README.md` | modify | Deps, test script, migration 005 |

---

### Task 1: Test harness and shared token crypto

**Files:**
- Create: `auth/token-crypto.js`, `test/helpers/db.js`, `test/helpers/openai-stub.js`, `test/helpers/http.js`, `test/unit/token-crypto.test.js`, `test/integration/token-crypto.test.js`
- Modify: `package.json` (devDependency `@electric-sql/pglite@^0.3.4`, script `"test": "node --test \"test/**/*.test.js\""`), `auth/openai-oauth.js:20-42`, `auth/openai-project.js:47-103`, `chat/chat.js:53,77-107,202-218`

**Interfaces:**
- Produces:
  - `auth/token-crypto.js`:
    - `encryptToken(plaintext: string) → { encrypted_token: Buffer, iv: Buffer }`
    - `decryptToken(encryptedToken: Buffer, iv: Buffer) → string`
    - `getOwnerToken(userId: string) → Promise<string | null>` (the latest row by `updated_at`; `null` when none)
  - `test/helpers/db.js`:
    - `setupTestDb() → Promise<{ db, pool, close() }>`. It sets `process.env.TOKEN_ENCRYPTION_KEY` (64 hex chars) and `JWT_SECRET`, creates PGlite with the `vector` extension (`await import('@electric-sql/pglite')` and `'@electric-sql/pglite/vector'`), and applies `schema.sql` then every `migrations/*.sql` in name order. Before applying, it strips `CREATE EXTENSION IF NOT EXISTS pgcrypto;` and replaces `encode(gen_random_bytes(24), 'base64')` with `md5(random()::text)`, because PGlite has no pgcrypto. It then installs `pool` into `require.cache[require.resolve('../../auth/db')]`. `pool` = `{ query(sql, params) → { rows, rowCount }, connect() → { query, release() } }`. **Each test file must call it before requiring any app module.**
    - `seedBot(pool, { email?, botFields?, withToken = true }) → Promise<{ userId, botId, embedKey, token: 'sk-test-owner' }>`. It inserts a user, a bot (`botFields` merged into the INSERT), an `embed_configs` row, and (if `withToken`) an encrypted owner token.
    - `authHeader(userId) → { Authorization: 'Bearer <jwt>' }`
  - `test/helpers/openai-stub.js`:
    - `fakeEmbedding(text) → number[1536]`: a bag of lowercase word tokens, each hashed to an index and incremented, then L2-normalised. Texts sharing words get positive cosine similarity.
    - `installOpenAIStub() → { requests: Array<{ path, body }>, queueChat(reply), failEmbeddings(on: boolean), restore() }`. While `failEmbeddings(true)` is set, `/v1/embeddings` replies `500`. It wraps `globalThis.fetch`. Non-`api.openai.com` URLs pass through. `/v1/embeddings` answers automatically with `fakeEmbedding` for each input. `/v1/chat/completions` dequeues `reply`, which is `{ json }` (a non-stream body) or `{ sse: string[] }` (`data:` payloads; the stub appends `data: [DONE]`). An empty queue makes the test fail with a clear error. `reply.status` (default 200) allows error replies.
    - `sse.text(str, parts = 1) → string[]` and `sse.toolCall(index, id, name, argsJson, parts = 1) → string[]` (argument JSON split into `parts` chunks; the last chunk carries `finish_reason: 'tool_calls'`), plus `sse.finish(reason = 'stop') → string`.
  - `test/helpers/http.js`: `startApp(mounts: Array<[path, router]>) → Promise<{ base, close() }>`. It builds an `express()` app with `express.json()` and the given mounts on port 0.

- [ ] **Step 1: Write the failing tests**

`test/unit/token-crypto.test.js`:
```js
test('round-trips a token', ...)                 // decryptToken(...encryptToken('sk-abc')) === 'sk-abc'
test('uses a fresh 12-byte IV each time', ...)   // two encryptions: iv.length === 12, ivs differ
test('rejects tampered ciphertext', ...)         // flip one byte → decryptToken throws
test('rejects a key that is not 64 hex chars', ...) // TOKEN_ENCRYPTION_KEY='abc' → encryptToken throws /64-character/
```
`test/integration/token-crypto.test.js` (uses `setupTestDb`, `seedBot`):
```js
test('getOwnerToken returns null without a token', ...)   // seedBot({ withToken: false }) → null
test('getOwnerToken returns the decrypted latest token', ...) // seedBot() → 'sk-test-owner'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../../auth/token-crypto'`.

- [ ] **Step 3: Implement `auth/token-crypto.js`, then switch the three callers to it**

Move the existing `getEncryptionKey`/`encryptToken`/`decryptToken` logic here unchanged (auth tag = last 16 bytes of `encrypted_token`). `openai-oauth.js` imports `encryptToken`. `openai-project.js` and `chat.js` use `decryptToken`/`getOwnerToken` and delete their local copies and `getEncryptedToken`. `openai-project.js` keeps exporting `decryptToken` (re-export) so its `module.exports` shape is unchanged.

- [ ] **Step 4: Run the tests and syntax checks**

Run: `npm test` and `node --check server.js`
Expected: all PASS; no output from `node --check`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json auth/ chat/chat.js test/
git commit -m "Add test harness and shared token crypto helper"
```

---

### Task 2: Migration 005 (catalog schema)

**Files:**
- Create: `migrations/005_catalog.sql`, `test/integration/migration-005.test.js`
- Modify: `README.md` (add `psql "$DATABASE_URL" -f migrations/005_catalog.sql` after 004, and a note that `CREATE EXTENSION vector` needs DB-owner rights)

**Interfaces:**
- Produces: the tables, columns and indexes in spec §3, exactly as named there. The migration is **re-runnable**: `CREATE ... IF NOT EXISTS` everywhere, and `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER` (`set_catalog_sources_updated_at`, `set_catalog_products_updated_at`, using `trigger_set_updated_at()`).
- Index names: `idx_catalog_sources_bot`, `idx_catalog_products_bot`, `idx_catalog_products_bot_price`, `idx_catalog_products_embedding` (HNSW `vector_cosine_ops`), `idx_catalog_products_tsv` (GIN), `idx_catalog_info_bot`, `idx_catalog_info_embedding`, `idx_catalog_info_tsv`, `idx_unanswered_open` (`(bot_id, created_at DESC) WHERE resolved_at IS NULL`).

- [ ] **Step 1: Write the failing test** (`setupTestDb` applies 005 automatically once the file exists)

```js
test('bots default to flexible answer mode', ...)        // seedBot → answer_mode === 'flexible', fallback_message === null
test('rejects an unknown answer_mode', ...)              // UPDATE bots SET answer_mode='loose' → rejects /check/
test('enforces one product per source + external_key', ...) // 2nd INSERT same (source_id, external_key) → rejects /unique/
test('generates search_tsv from product fields', ...)    // name 'Rain Jacket' → search_tsv @@ plainto_tsquery('simple','jacket') is true
test('deleting a bot cascades catalog rows', ...)        // DELETE bot → 0 rows in catalog_sources/products/info/unanswered_questions
test('creates the HNSW index', ...)                      // pg_indexes has idx_catalog_products_embedding, indexdef ILIKE '%hnsw%'
test('is safe to re-run', ...)                           // exec the file a second time → resolves
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/integration/migration-005.test.js`
Expected: FAIL (`column "answer_mode" does not exist`).

- [ ] **Step 3: Write `migrations/005_catalog.sql`** following spec §3 and the interface above.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/005_catalog.sql test/integration/migration-005.test.js README.md
git commit -m "Add catalog schema migration (pgvector, sources, products, info, unanswered)"
```

---

### Task 3: Bot ownership module and answer-mode settings

**Files:**
- Create: `bots/ownership.js`, `test/integration/bots-settings.test.js`
- Modify: `bots/bots.js:98-129` (remove `requireBotOwner`, import it), `bots/bots.js:41-84` (validators), `bots/bots.js:303-349` (merge and UPDATE)

**Interfaces:**
- Produces:
  - `bots/ownership.js`:
    - `requireBotOwner(botId, userId, res, { includeDeleted = false } = {}) → Promise<object | null>` (moved unchanged)
    - `loadOwnedBot(req, res, next)`: Express middleware. It validates that `req.params.id` is a UUID (`400` otherwise), calls `requireBotOwner(req.params.id, req.user.sub, res)`, and sets `req.bot`.
  - `PUT /api/bots/:id` accepts `answer_mode` (`'strict' | 'flexible'`) and `fallback_message` (string ≤ 500 chars, or `null`). Both are merged like the other fields and returned in `bot`.

- [ ] **Step 1: Write the failing test** (mount `require('../../bots/bots')` at `/api/bots` via `startApp`)

```js
test('PUT saves answer_mode and fallback_message', ...)  // {answer_mode:'strict', fallback_message:'Call 98xxxx'} → 200, both echoed
test('PUT keeps existing values when omitted', ...)      // then PUT {name:'X'} → answer_mode still 'strict'
test('PUT rejects an invalid answer_mode', ...)          // 'loose' → 400
test('PUT rejects a fallback_message over 500 chars', ...) // 'a'.repeat(501) → 400
test('another user cannot update the bot', ...)          // second user's token → 403
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/integration/bots-settings.test.js`
Expected: FAIL (`answer_mode` not saved).

- [ ] **Step 3: Implement `bots/ownership.js` and the `bots.js` changes**

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bots/ test/integration/bots-settings.test.js
git commit -m "Extract bot ownership guard and add answer mode settings"
```

---

### Task 4: Product normalisation and spreadsheet parser

**Files:**
- Create: `catalog/normalize.js`, `catalog/parsers/spreadsheet.js`, `test/unit/normalize.test.js`, `test/unit/spreadsheet.test.js`
- Modify: `package.json` (`exceljs@^4.4.0`, `csv-parse@^5.6.0`)

**Interfaces:**
- Produces:
  - `Product` = `{ external_key, name, category, description, price: number|null, currency: string, in_stock: boolean|null, url, image_url, attributes: object }` (nullable strings are `null`, never `''`)
  - `catalog/normalize.js`:
    - `parsePrice(value) → number | null`: strips currency symbols/words (`₹`, `Rs`, `Rs.`, `INR`, `$`) and commas, including lakh grouping.
    - `parseStock(value) → boolean | null`: following §4.2.
    - `normalizeProduct(raw: object) → Product | null`: `null` when there is no name after trimming. `external_key` = trimmed `sku` if present, else `name.toLowerCase()` with whitespace collapsed. `currency` defaults to `'INR'`, upper-cased.
    - `productHash(p: Product) → string` and `infoHash({ title, content }) → string`: SHA-256 hex of a canonical JSON with keys sorted.
    - `dedupeProducts(list: Product[]) → Product[]`: merges by `external_key` in first-seen order. Later non-null fields win, and `attributes` are shallow-merged.
  - `catalog/parsers/spreadsheet.js`:
    - `parseSpreadsheet(buffer: Buffer, filename: string) → Promise<{ products: Product[], skipped: number }>`. It uses `.xlsx` (exceljs, first worksheet) or `.csv` (csv-parse, `bom: true`, `columns: true`, `skip_empty_lines: true`). Header aliases are exactly those in §4.2, matched after lower-casing, trimming and stripping a BOM. Unknown columns go into `attributes`. The output passes through `dedupeProducts`.

- [ ] **Step 1: Write the failing tests**

`test/unit/normalize.test.js`:
```js
test('parses rupee and lakh formats', ...)  // '₹1,29,999'→129999, 'Rs. 499.50'→499.5, 'INR 2,999'→2999, '$12.00'→12, ''→null, 'call us'→null
test('parses stock values', ...)            // '5'→true, '0'→false, 'In Stock'→true, 'sold out'→false, 'yes'→true, 'maybe'→null
test('external_key prefers sku', ...)       // {name:'Rain  Jacket', sku:' JK-1 '}→'JK-1'; no sku→'rain jacket'
test('drops rows without a name', ...)      // normalizeProduct({price:'10'}) === null
test('hash is stable and field-order independent', ...) // same fields different key order → equal; price change → differs
test('dedupe merges same key, later non-null wins', ...) // [{key a, price 10, url x}, {key a, price null, url y}] → 1 item, price 10, url 'y'
```
`test/unit/spreadsheet.test.js`:
```js
test('maps aliased CSV headers', ...)        // 'Product Name,MRP,Qty,Colour\nRain Jacket,"₹2,999",3,Blue' → name, price 2999, in_stock true, attributes {colour:'Blue'}
test('handles a UTF-8 BOM header', ...)      // '﻿name,price\nCap,199' → products[0].name === 'Cap'
test('counts skipped rows without a name', ...) // one row with empty name → skipped === 1
test('merges duplicate SKUs in one file', ...)  // two rows sku JK-1 → products.length === 1
test('reads the first XLSX worksheet', ...)     // build a workbook with exceljs in the test → same mapping as CSV
test('rejects unsupported extensions', ...)     // 'catalog.txt' → rejects /Unsupported/
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/normalize.test.js test/unit/spreadsheet.test.js`
Expected: FAIL (`Cannot find module`).

- [ ] **Step 3: Implement `catalog/normalize.js` and `catalog/parsers/spreadsheet.js`**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog/normalize.js catalog/parsers/spreadsheet.js test/unit/normalize.test.js test/unit/spreadsheet.test.js package.json package-lock.json
git commit -m "Add product normalisation and CSV/XLSX catalog parser"
```

---

### Task 5: URL guard

**Files:**
- Create: `catalog/url-guard.js`, `test/unit/url-guard.test.js`

**Interfaces:**
- Produces:
  - `isBlockedAddress(ip: string) → boolean`: covers the ranges in §9, including IPv4-mapped IPv6 (`::ffff:a.b.c.d`).
  - `assertPublicUrl(url: string, { lookup = dns.promises.lookup } = {}) → Promise<URL>`. It throws an `Error` with `code = 'URL_INVALID'` (not parseable, or not `http:`/`https:`) or `code = 'URL_BLOCKED'` (any address from `lookup(host, { all: true })` is blocked, or the host is `localhost`). IP-literal hosts are checked without a lookup.

- [ ] **Step 1: Write the failing test**

```js
test('blocks private, loopback, link-local and metadata ranges', ...)
  // true: 127.0.0.1, 10.1.2.3, 172.16.0.1, 172.31.255.255, 192.168.1.1, 169.254.169.254, 0.0.0.0, ::1, fc00::1, fe80::1, ::ffff:127.0.0.1
  // false: 8.8.8.8, 172.32.0.1, 2606:4700::1111
test('rejects non-http schemes', ...)      // 'ftp://x.com', 'javascript:alert(1)' → code URL_INVALID
test('rejects localhost by name', ...)     // 'http://localhost:3000' → URL_BLOCKED
test('rejects hosts resolving to private IPs', ...) // lookup stub → [{address:'10.0.0.5'}] → URL_BLOCKED
test('rejects if any resolved address is private', ...) // [{8.8.8.8},{192.168.0.2}] → URL_BLOCKED
test('allows public hosts', ...)           // lookup → [{address:'93.184.216.34'}] → resolves to URL with hostname
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unit/url-guard.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `catalog/url-guard.js`** using `net.isIP` and `net.BlockList` for the range checks.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog/url-guard.js test/unit/url-guard.test.js
git commit -m "Add SSRF guard for catalog URL imports"
```

---

### Task 6: PDF parser and website crawler

**Files:**
- Create: `catalog/parsers/pdf.js`, `catalog/parsers/website.js`, `test/unit/website.test.js`, `test/unit/pdf.test.js`, `test/fixtures/make-pdf.js`
- Modify: `package.json` (`pdf-parse@^1.1.1`, `cheerio@^1.0.0`)

**Interfaces:**
- Consumes: `assertPublicUrl` (Task 5).
- Produces:
  - `parsePdf(buffer: Buffer) → Promise<string>`. Require `'pdf-parse/lib/pdf-parse.js'`, not the package root, whose index runs a debug self-test.
  - `crawlSite(startUrl: string, opts = {}) → Promise<Array<{ url: string, text: string }>>`. Options and defaults: `guard = assertPublicUrl`, `fetchImpl = fetch`, `maxPages = 50`, `maxDepth = 2`, `timeoutMs = 10000`, `maxBytes = 2 * 1024 * 1024`, `maxRedirects = 5`.
    - Breadth-first crawl on the start URL's hostname only. URLs are normalised by dropping the hash.
    - Redirects are handled manually (`redirect: 'manual'`): `guard` runs on the start URL and on every hop, and more than `maxRedirects` hops skips the page.
    - Only `text/html` is kept. Bodies over `maxBytes` are skipped.
    - Text is cheerio `body` text with `script, style, noscript, nav, footer` removed and whitespace collapsed.
    - A page that fails (guard, timeout, status ≥ 400) is skipped, not thrown. If the **start** URL fails the guard, the error is rethrown.
  - `test/fixtures/make-pdf.js`: `makePdf(text: string) → Buffer`, a minimal single-page PDF (Helvetica, ASCII text) written by hand.

- [ ] **Step 1: Write the failing tests** (website tests start a local `http` server and pass `guard: async (u) => { if (new URL(u).hostname === 'blocked.test') throw Object.assign(new Error('blocked'), { code: 'URL_BLOCKED' }); return new URL(u); }`)

```js
test('crawls same-host links up to maxDepth', ...)   // / → /a → /b → /c ; maxDepth 2 → urls are /, /a, /b
test('ignores other hosts', ...)                     // link to http://other.test/x → not fetched
test('respects maxPages', ...)                       // 10 linked pages, maxPages 3 → 3 results
test('strips script, style, nav and footer text', ...) // text excludes 'NAVTEXT','SCRIPTTEXT'; includes 'Rain Jacket'
test('skips non-HTML responses', ...)                // /file.json content-type application/json → not in results
test('checks the guard on redirects', ...)           // /go 302 → http://blocked.test/ → page skipped, guard called with blocked URL
test('rethrows when the start URL is blocked', ...)  // crawlSite('http://blocked.test/') → rejects code URL_BLOCKED
```
`test/unit/pdf.test.js`:
```js
test('extracts text from a PDF', ...)                // parsePdf(makePdf('Rain Jacket Rs 2999')) includes 'Rain Jacket'
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/website.test.js test/unit/pdf.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement both parsers and the PDF fixture helper**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog/parsers/ test/unit/website.test.js test/unit/pdf.test.js test/fixtures/ package.json package-lock.json
git commit -m "Add PDF text parser and guarded same-host website crawler"
```

---

### Task 7: OpenAI client, extraction and embeddings

**Files:**
- Create: `catalog/openai-client.js`, `catalog/extract.js`, `catalog/embed.js`, `test/unit/extract.test.js`, `test/unit/embed.test.js`

**Interfaces:**
- Consumes: `normalizeProduct`, `dedupeProducts` (Task 4); `installOpenAIStub`, `fakeEmbedding` (Task 1).
- Produces:
  - `openaiJson(token, path, body) → Promise<object>`. It POSTs to `https://api.openai.com/v1${path}` with a Bearer token. On a non-2xx response it throws an `Error` with `.status` and `.openai` (the parsed body).
  - `catalog/embed.js`:
    - constants `EMBEDDING_MODEL = 'text-embedding-3-small'`, `EMBEDDING_DIMS = 1536`, `EMBED_BATCH = 100`
    - `embedTexts(token, texts: string[]) → Promise<number[][]>` (input order preserved; `[]` for no texts, with no request)
    - `toVectorLiteral(vec: number[]) → string` (`'[0.1,0.2,...]'`)
    - `productEmbeddingText(p: Product) → string`: `name · category · description · k: v; k: v · price currency`, skipping nulls
    - `infoEmbeddingText({ title, content }) → string`: `title\ncontent`
  - `catalog/extract.js`:
    - `WINDOW_CHARS = 12000`
    - `splitIntoWindows(text, maxChars = WINDOW_CHARS) → string[]`: splits on blank lines, packs paragraphs greedily, and hard-splits any single paragraph longer than `maxChars`.
    - `extractCatalog(token, pages: Array<{ url: string|null, text: string }>) → Promise<{ products: Product[], info: Array<{ title, content, url }> }>`. One `/chat/completions` call per window with `model: 'gpt-4o-mini'`, `temperature: 0`, and `response_format: { type: 'json_schema', json_schema: { name: 'catalog_extraction', strict: true, schema } }`, where the schema is the §4.3 shape with nullable fields. Products default `url` to the page URL, are normalised, then deduped. Info items take the page URL. Empty titles or content are dropped.

- [ ] **Step 1: Write the failing tests**

`test/unit/embed.test.js`:
```js
test('batches 250 texts into 100/100/50 and keeps order', ...) // stub.requests embeddings inputs lengths [100,100,50]; result[i] deepEqual fakeEmbedding(texts[i])
test('no request for an empty list', ...)                      // embedTexts(t, []) → [] and requests.length === 0
test('formats a vector literal', ...)                          // toVectorLiteral([1,0.5]) === '[1,0.5]'
test('builds product embedding text', ...)                     // includes 'Rain Jacket', 'colour: Blue', '2999 INR'; no 'null'
test('throws with status on API errors', ...)                  // stub replies status 401 → rejects with err.status === 401
```
`test/unit/extract.test.js`:
```js
test('splits on paragraph boundaries', ...)       // 3 paragraphs of 5000 chars, max 12000 → 2 windows, none > 12000
test('hard-splits an oversized paragraph', ...)   // one 30000-char paragraph → every window ≤ 12000, joined length preserved
test('sends gpt-4o-mini with a strict JSON schema at temperature 0', ...) // request body checks
test('merges products across windows and keeps page URLs', ...)
  // two windows each return 'Rain Jacket' (one with price 2999, one with image) → 1 product with both; url === page url
test('collects info with the page URL', ...)      // info [{title:'Returns',content:'7 days'}] → url === page url
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/embed.test.js test/unit/extract.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the three modules**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog/openai-client.js catalog/extract.js catalog/embed.js test/unit/extract.test.js test/unit/embed.test.js
git commit -m "Add catalog extraction and batched embeddings"
```

---

### Task 8: Ingest pipeline

**Files:**
- Create: `catalog/ingest.js`, `test/integration/ingest.test.js`

**Interfaces:**
- Consumes: `getOwnerToken` (Task 1); `parseSpreadsheet` (Task 4); `parsePdf`, `crawlSite` (Task 6); `extractCatalog`, `embedTexts`, `toVectorLiteral`, `productEmbeddingText`, `infoEmbeddingText` (Task 7); `productHash`, `infoHash` (Task 4).
- Produces:
  - constants `MAX_PRODUCTS_PER_BOT = 5000`, `MAX_INFO_PER_BOT = 2000`
  - `runIngest(sourceId: string, payload: { buffer?: Buffer, filename?: string, url?: string }, deps = { parseSpreadsheet, parsePdf, crawlSite, extractCatalog }) → Promise<void>`. It **never throws**. Steps:
    1. Load the source (with the bot's `user_id`) and set it to `processing`.
    2. Get the owner token (none → `failed`, error `'Connect OpenAI before importing a catalog.'`).
    3. Load items by `kind`: spreadsheet (no LLM); pdf → `[{ url: null, text }]` → extract; url → crawl → extract.
    4. Check limits: count this bot's products/info in **other** sources plus the new totals. Over the limit → `failed` with an error naming the limit, before any embedding request.
    5. Diff against existing rows of this source by `external_key`/`content_hash`, and embed only new or changed items.
    6. In one transaction (`pool.connect()`): upsert changed products (`ON CONFLICT (source_id, external_key) DO UPDATE`), insert new info, delete this source's products whose keys are absent and info whose hashes are absent.
    7. Set `ready` with `item_count`, `last_synced_at = NOW()`, and `error = null` (or `'Skipped N rows without a name.'` when `skipped > 0`, status still `ready`).
    - Any thrown error rolls back and sets `failed` with `err.message`. Rows from earlier imports stay untouched.
  - `recoverInterruptedImports() → Promise<number>`: runs the §4.1 UPDATE and returns `rowCount`.

- [ ] **Step 1: Write the failing test** (insert `catalog_sources` rows directly; OpenAI stub installed; CSV built as a string)

```js
test('imports a spreadsheet and marks it ready', ...)
  // 3 rows → status 'ready', item_count 3, 3 catalog_products with non-null embedding, last_synced_at set
test('re-sync embeds only changed rows and deletes missing ones', ...)
  // second run: row A price changed, row B unchanged, row C removed → that run's embeddings inputs length === 1; C gone; A price updated
test('duplicate SKUs in one file import as one product', ...) // 2 rows sku JK-1 → 1 row, status ready
test('reports skipped rows but stays ready', ...)            // a row without name → status 'ready', error 'Skipped 1 rows without a name.'
test('a failed import keeps previous products', ...)         // successful import, then runIngest with buffer of garbage .xlsx → status 'failed', product count unchanged
test('fails before embedding when over the product limit', ...) // deps.parseSpreadsheet stub returns 5001 products → failed, error mentions 5000, 0 embedding requests
test('fails without an owner token', ...)                    // seedBot({withToken:false}) → failed, error 'Connect OpenAI before importing a catalog.'
test('imports a URL source through crawl and extraction', ...)
  // deps.crawlSite stub → [{url:'https://shop.test/p',text:'...'}]; queueChat json extraction → 1 product url 'https://shop.test/p', 1 info row
test('recovers interrupted imports', ...)                    // rows pending + processing + ready → returns 2; both failed with 'Interrupted by server restart'
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/integration/ingest.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `catalog/ingest.js`**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog/ingest.js test/integration/ingest.test.js
git commit -m "Add catalog ingest pipeline with change detection and limits"
```

---

### Task 9: Hybrid search

**Files:**
- Create: `catalog/search.js`, `test/integration/search.test.js`

**Interfaces:**
- Consumes: `toVectorLiteral` (Task 7).
- Produces:
  - constants `MIN_SIMILARITY = 0.25`, `VECTOR_WEIGHT = 0.7`, `KEYWORD_WEIGHT = 0.3`, `MAX_PRODUCT_RESULTS = 8`, `MAX_INFO_RESULTS = 4`
  - `sanitizeFilters(raw: object) → { query: string, min_price: number|null, max_price: number|null, category: string|null, in_stock: boolean|null, sort: 'relevance'|'price_asc'|'price_desc' }`. Numeric strings are coerced. Negative, `NaN` or non-numeric values become `null`. `'true'/'yes'/true` → `true`, `'false'/'no'/false` → `false`, anything else → `null`. An unknown `sort` becomes `'relevance'`. `query` is trimmed to ≤ 200 chars. `category` is trimmed (≤ 100 chars) or `null`.
  - `searchProducts(botId, filters, queryEmbedding: number[]) → Promise<Array<{ id, name, category, description, price: number|null, currency, in_stock, url, image_url, similarity, score }>>`: the SQL in §5.5. `ORDER BY` comes from a fixed map keyed by `sort`. `price` is returned as a JS number.
  - `searchInfo(botId, query, queryEmbedding) → Promise<Array<{ id, title, content, url, similarity, score }>>`

- [ ] **Step 1: Write the failing test** (seed products with `fakeEmbedding(productEmbeddingText(p))`, query with `fakeEmbedding(query)`)

Seed bot A: Waterproof Rain Jacket ₹2,999 in stock (category Jackets, sku JK-1); Winter Down Jacket ₹5,499 in stock; Cotton T-Shirt ₹499 out of stock; Leather Wallet ₹1,200 (in_stock null). Seed bot B: Waterproof Rain Jacket ₹100.
```js
test('ranks the semantically closest product first', ...)  // query 'waterproof jacket' → [0].name === 'Waterproof Rain Jacket' (bot A's, price 2999)
test('never returns another bot\'s products', ...)          // every result has price !== 100; results for bot B contain only its row
test('applies max_price', ...)                             // 'jacket', max_price 3000 → no 'Winter Down Jacket'
test('applies in_stock', ...)                              // 't-shirt', in_stock true → no 'Cotton T-Shirt'
test('applies category with ILIKE', ...)                   // category 'jack' → only Jackets
test('sorts by price ascending', ...)                      // 'jacket', sort price_asc → prices non-decreasing
test('drops unrelated rows below the threshold', ...)      // 'garden hose' → []
test('keeps an exact SKU keyword hit', ...)                // query 'JK-1' → includes Rain Jacket
test('sanitizes model-supplied filter types', ...)
  // sanitizeFilters({query:' jacket ', max_price:'3000', in_stock:'yes', sort:'cheapest', min_price:-5})
  //   → {query:'jacket', max_price:3000, in_stock:true, sort:'relevance', min_price:null, category:null}
test('searchInfo returns at most 4 chunks for this bot', ...) // 6 info rows → length ≤ 4, all bot A
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/integration/search.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `catalog/search.js`**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog/search.js test/integration/search.test.js
git commit -m "Add hybrid vector and keyword catalog search"
```

---

### Task 10: Catalog API routes and server wiring

**Files:**
- Create: `catalog/routes.js`, `test/integration/catalog-routes.test.js`
- Modify: `server.js` (mount `app.use('/api/bots/:id/catalog', catalogRouter)` **before** `app.use('/api/bots', botsRouter)`; in the `listen` callback call `recoverInterruptedImports().catch(err => console.error(...))`), `package.json` (`multer@^2.0.2`)

**Interfaces:**
- Consumes: `authMiddleware`; `loadOwnedBot` (Task 3); `getOwnerToken` (Task 1); `assertPublicUrl` (Task 5); `runIngest`, `recoverInterruptedImports` (Task 8).
- Produces: `catalog/routes.js` exports an `express.Router({ mergeParams: true })` implementing the §6 catalog rows:
  - Every route runs `authMiddleware, loadOwnedBot`.
  - Uploads: `multer({ storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('file')`.
  - Extension → kind map: `.csv`/`.xlsx` → `spreadsheet`, `.pdf` → `pdf`. Allowed MIME types: `text/csv`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/pdf`.
  - Error responses: multer `LIMIT_FILE_SIZE` → `413 { error: 'File is larger than 10 MB.' }`; bad extension/MIME → `400`; `URL_INVALID`/`URL_BLOCKED` → `400 { error: 'That URL cannot be imported.' }`; no owner token → `409 { error: 'Connect OpenAI before importing a catalog.' }`; a pending/processing source for this bot → `429 { error: 'An import is already running for this bot.' }`.
  - Success: insert the source → `202 { source }`, then `setImmediate(() => runIngest(source.id, payload))`.
  - Re-sync: a file source without a file, or a file of a different kind → `400`. A URL source re-uses `source.name` as the URL.
  - `GET /products`: `search` matches `name ILIKE`; `page` ≥ 1; `limit` 1–100 (default 20); response `{ products, pagination: { page, limit, total, total_pages } }`; no `embedding` column in the output.

- [ ] **Step 1: Write the failing test** (`startApp([['/api/bots/:id/catalog', catalogRouter]])`; uploads use global `FormData` + `Blob`; poll `GET sources` until not pending/processing, max 5 s)

```js
test('uploads a CSV and reaches ready', ...)          // 202, source.status 'pending' → later 'ready', item_count 2
test('lists sources for the bot only', ...)           // another bot's source not included
test('rejects unsupported files', ...)                // 'notes.txt' text/plain → 400
test('rejects files over 10 MB', ...)                 // 10 MB + 1 byte .csv → 413
test('rejects private URLs', ...)                     // {url:'http://127.0.0.1/'} → 400 'That URL cannot be imported.'
test('requires a connected OpenAI token', ...)        // seedBot({withToken:false}) → 409
test('refuses a second import while one is running', ...) // insert a processing source, POST again → 429
test('forbids other users', ...)                      // other user's JWT → 403
test('re-sync of a file source requires a file', ...) // POST .../resync without file → 400
test('deletes a source and its products', ...)        // DELETE → 204; catalog_products for source → 0
test('previews products with search and paging', ...) // ?search=jack&limit=1 → products.length 1, total 1, no 'embedding' key
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/integration/catalog-routes.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `catalog/routes.js` and the `server.js` changes**

- [ ] **Step 4: Run the tests and start the server once**

Run: `npm test`, then `PORT=3998 node server.js` (stop it after the "listening" line).
Expected: tests PASS. The server logs the listening line, and any recovery error (no DB locally) is logged, not thrown.

- [ ] **Step 5: Commit**

```bash
git add catalog/routes.js server.js test/integration/catalog-routes.test.js package.json package-lock.json
git commit -m "Add catalog source API and wire it into the server"
```

---

### Task 11: Search tools in chat

**Files:**
- Create: `catalog/tools.js`, `test/unit/tools.test.js`, `test/integration/chat-catalog.test.js`
- Modify: `chat/chat.js` (`resolveBotByEmbedKey` 183-200, `callOpenAIStream` 304-326, the streaming section 487-536, session saving 538-561)

**Interfaces:**
- Consumes: `searchProducts`, `searchInfo`, `sanitizeFilters` (Task 9); `embedTexts` (Task 7); `getOwnerToken` (Task 1).
- Produces:
  - `catalog/tools.js`:
    - `DEFAULT_FALLBACK_MESSAGE = "I'm sorry, I couldn't find that in our catalog. Please contact us for help."`
    - `TOOL_DEFINITIONS`: the two OpenAI function tools from §5.3, with a JSON-schema `parameters` each (`query` required).
    - `buildCatalogPrompt({ answer_mode, fallback_message }) → string`: the §5.2 text verbatim for the mode, then the "Both modes" text, with `fallback_message || DEFAULT_FALLBACK_MESSAGE` substituted.
    - `runToolCall(botId, token, { name, arguments: string }) → Promise<{ content: string, cards: ProductCard[], searched: boolean, resultCount: number }>`:
      - invalid JSON or an unknown name → `content` `{"error":"invalid arguments"}`, `searched: false`
      - a thrown search or embedding error → `{"error":"search unavailable"}`, `searched: true`, `resultCount: 0`
      - otherwise `content` is JSON `{ results: [...] }` with the §5.4 fields and truncation
    - `ProductCard = { id, name, price, currency, in_stock, url, image_url }`
  - `chat/chat.js`:
    - `resolveBotByEmbedKey` also selects `b.answer_mode`, `b.fallback_message`, and `EXISTS (SELECT 1 FROM catalog_sources cs WHERE cs.bot_id = b.id AND cs.status = 'ready') AS has_catalog`.
    - `streamCompletion(res, { token, model, messages, projectId, tools, toolChoice }) → Promise<{ text: string, toolCalls: Array<{ id, name, arguments }>, finishReason: string }>`: one OpenAI call, forwarding content deltas as `{ delta }` and collecting `tool_calls` deltas by `index`. `temperature: 0.3`; `tools`/`tool_choice` only when `tools` is given.
    - The turn loop (only when `has_catalog`):
      - system content = `bot.system_prompt + '\n\n' + buildCatalogPrompt(bot)`
      - rounds 1–2 use `tool_choice: 'auto'`, and after 2 rounds the call uses `'none'`
      - each round runs ≤ 3 tool calls with `Promise.all`; calls beyond 3 get `{"error":"too many calls"}`
      - assistant `tool_calls` and `tool` messages are appended between calls
    - Without a catalog: one `streamCompletion` without tools, which is today's behaviour.
    - After the loop: if any cards, send `sseWrite(res, { products: first4UniqueCards })`, then `[DONE]`.
    - The saved assistant message gets `product_ids` (card IDs) when there are cards.
    - Unanswered rows (async, errors logged only):
      - `reason 'no_results'` if ≥ 1 search ran and every `resultCount === 0`
      - otherwise `reason 'fallback'` if `answer_mode === 'strict'` and the reply includes `fallback_message || DEFAULT_FALLBACK_MESSAGE`
      - `question = userMessage`, `session_id = sessionId`
    - A thrown error after `initSSE` writes `{ delta: '\n\nSorry, something went wrong.' }`, then `[DONE]`.

- [ ] **Step 1: Write the failing tests**

`test/unit/tools.test.js`:
```js
test('strict prompt uses the fallback message verbatim', ...) // includes 'reply exactly with: Call us on 98xxxx'
test('strict prompt falls back to the default text', ...)     // fallback null → includes DEFAULT_FALLBACK_MESSAGE
test('flexible prompt allows general knowledge', ...)         // includes 'You may answer general questions from your own knowledge.'
test('both prompts state prices are authoritative', ...)      // includes 'Prices and stock in tool results are authoritative.'
test('defines search_products and search_info', ...)          // names, required ['query']
```
`test/integration/chat-catalog.test.js` (`startApp([['/chat', chatRouter]])`; seed a bot with a `ready` source and products; parse the SSE body into events):
```js
test('streams text, runs the tool, then sends product cards', ...)
  // call1 sse: sse.text('Let me check. ') + sse.toolCall(0,'call_1','search_products','{"query":"waterproof jacket","max_price":3000}', 4)
  // call2 sse: sse.text('We have the Waterproof Rain Jacket for ₹2,999.', 3)
  // events: {session_id} first; deltas join to 'Let me check. We have the Waterproof Rain Jacket for ₹2,999.';
  //         one {products} event, ≤4 cards, cards[0] keys exactly id,name,price,currency,in_stock,url,image_url; last event '[DONE]'
  // stub.requests[chat #2].body.messages contains {role:'tool', tool_call_id:'call_1'} and an assistant message with tool_calls
  // saved session assistant message has product_ids including the jacket id
test('sends no tools when the bot has no ready catalog', ...)  // source status 'failed' → chat request body has no 'tools'
test('strict mode with no results logs no_results', ...)
  // tool call query 'garden hose'; call2 replies with the fallback text → unanswered_questions row reason 'no_results'
test('strict fallback without a search logs fallback', ...)    // call1 replies fallback text directly → reason 'fallback'
test('caps tool rounds at two', ...)                           // call1, call2 both tool calls; call3 request has tool_choice 'none'
test('a failing search returns search unavailable', ...)       // stub.failEmbeddings(true) before the turn → tool message content '{"error":"search unavailable"}', stream still ends [DONE]
test('truncates descriptions in tool results to 300 chars', ...) // product with 1000-char description → tool content result description length ≤ 300
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/tools.test.js test/integration/chat-catalog.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `catalog/tools.js` and the `chat/chat.js` changes**

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog/tools.js chat/chat.js test/unit/tools.test.js test/integration/chat-catalog.test.js
git commit -m "Answer chat from the catalog via search tools and send product cards"
```

---

### Task 12: Unanswered questions API and transcript products

**Files:**
- Create: `test/integration/analytics-catalog.test.js`
- Modify: `analytics/analytics.js` (new routes before `module.exports`; the session route at 457-511)

**Interfaces:**
- Consumes: `qv`/`param` validators and `rangeToInterval` already in the file; the `ProductCard` shape `{ id, name, price, currency, in_stock, url, image_url }` (Task 11).
- Produces:
  - `GET /api/analytics/unanswered?bot_id=&range=` → `{ questions: [{ question, count, last_asked, ids: string[] }] }`, ordered by `count DESC, last_asked DESC`, at most 50.
    - Groups unresolved rows by `lower(regexp_replace(trim(question), '\s+', ' ', 'g'))`. `question` is the most recent original text.
    - Owner filter `JOIN bots b ... WHERE b.user_id = $1 AND b.deleted_at IS NULL`.
  - `POST /api/analytics/unanswered/:id/resolve` → `204`. It sets `resolved_at = NOW()` on every unresolved row of the same bot with the same normalised text. If the row isn't found or isn't owned → `404`.
  - `GET /api/analytics/sessions/:session_id` → the response gains `session.products: { [id]: ProductCard }` for IDs in `messages[*].product_ids` that still exist in `catalog_products` **for that session's bot**.

- [ ] **Step 1: Write the failing test**

```js
test('groups unanswered questions by normalised text', ...) // 'Do you ship to Goa?' + '  do you  ship to goa? ' → one entry count 2
test('hides resolved and other users\' questions', ...)     // resolved row + other user's row → not listed
test('resolve marks the whole group resolved', ...)         // POST resolve on one id → 204; GET → []
test('resolve 404s for another user\'s question', ...)      // other user → 404
test('session transcript includes existing product cards', ...)
  // messages with product_ids [p1, deletedId] → session.products has p1 only, with card keys
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/integration/analytics-catalog.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the analytics changes**

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add analytics/analytics.js test/integration/analytics-catalog.test.js
git commit -m "Add unanswered questions API and product cards in transcripts"
```

---

### Task 13: Widget product cards

**Files:**
- Create: `test/unit/widget.test.js`
- Modify: `public/widget.js` (helpers near the top of the IIFE; CSS block; `streamChat` event handling at the `parsed.delta` branch)

**Interfaces:**
- Produces, inside the widget IIFE:
  - `safeHttpUrl(value) → string | null`: `new URL(value).href` if the protocol is `http:` or `https:`, else `null` (and `null` on parse errors).
  - `formatPrice(price, currency) → string`: `Intl.NumberFormat(undefined, { style: 'currency', currency })`. It falls back to `` `${currency} ${price}` `` if the currency code is invalid, and returns `''` for a null price.
  - `renderProductCards(products, afterEl)`: inserts a `.bf-cards` row after the bot message row, with at most 4 `.bf-card` elements. Text is set only via `textContent`. The image is shown only if `safeHttpUrl(image_url)`, with `loading="lazy"` and removal on `error`. An "Out of stock" badge appears when `in_stock === false`. The **View** link appears only if `safeHttpUrl(url)`, with `target="_blank"` and `rel="noopener noreferrer"`.
  - Test hook: helpers are defined **before** the `EMBED_KEY` early return, and `if (window.__BF_TEST__ === true) window.__BF_TEST__ = { safeHttpUrl, formatPrice };`.
  - On a `parsed.products` event: `renderProductCards(parsed.products, targetBubble.parentElement)`.
  - CSS (`bf-` prefix, dark theme like the existing panel): cards 140 px wide, row `overflow-x: auto`.

- [ ] **Step 1: Write the failing test** (load `public/widget.js` source into `vm.runInNewContext` with a stub `window = { __BF_TEST__: true }`, `document = { currentScript: null, getElementsByTagName: () => [] }`, `console`, and `URL`/`Intl` from the host)

```js
test('safeHttpUrl allows only http(s)', ...)
  // 'https://shop.test/p' → 'https://shop.test/p'; 'javascript:alert(1)' → null; 'data:text/html,x' → null; 'not a url' → null; null → null
test('formatPrice formats currency and survives bad codes', ...)
  // formatPrice(2999,'INR') includes '2,999'; formatPrice(5,'XYZ1') === 'XYZ1 5'; formatPrice(null,'INR') === ''
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unit/widget.test.js`
Expected: FAIL (`window.__BF_TEST__.safeHttpUrl` is undefined).

- [ ] **Step 3: Implement the widget changes**

- [ ] **Step 4: Run the tests and check syntax**

Run: `npm test` and `node --check public/widget.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/widget.js test/unit/widget.test.js
git commit -m "Show product cards in the chat widget"
```

---

### Task 14: Dashboard Catalog page

**Files:**
- Create: `client/src/pages/Catalog.jsx`, `client/src/components/ProductCard.jsx`
- Modify: `client/src/hooks/useApi.js:11-15`, `client/src/App.jsx:36-40`, `client/src/components/DashboardLayout.jsx:4-9`

**Interfaces:**
- Consumes: the §6 catalog endpoints (Task 10); `BotSelector` (`selectedBotId`, `onBotChange`, `showAllOption={false}`); `useApi().apiJson`.
- Produces:
  - `useApi`: `Content-Type: application/json` is set only when `options.body` is not a `FormData`.
  - Route `/dashboard/catalog` → `<Catalog />`. Nav item `{ to: '/dashboard/catalog', label: 'Catalog' }` between Topics and Settings.
  - `ProductCard({ product })`: image (only `http(s)` URLs), name, price formatted with `Intl.NumberFormat`, "Out of stock" badge, "View" link (`target="_blank" rel="noopener noreferrer"`, only `http(s)`).
  - `Catalog` page sections: the bot selector (defaults to the first bot, like Settings), an upload area (`<input type="file" accept=".csv,.xlsx,.pdf">` plus drag-and-drop), an "Add website" URL form, and a sources table (name, kind, status badge, items, last synced, error, Re-sync, Delete with `window.confirm`). The source list is polled every 3000 ms while any source is `pending`/`processing`, with the interval cleared on unmount or bot change. Below that, a product preview table with a search box (300 ms debounce) and Previous/Next paging. API errors (`409`, `413`, `429`, `400`) show their `error` text in a dismissible banner.

- [ ] **Step 1: Implement the changes above**

- [ ] **Step 2: Build the client**

Run: `npm run client:build`
Expected: `✓ built in`, no errors.

- [ ] **Step 3: Check it in the browser**

Start the backend (`node server.js`, against a `DATABASE_URL` with migrations 004–005 applied) and `npm run client`. Then, in the browser:
1. Sign in and open **Catalog**.
2. Upload a 3-row CSV: the status goes pending → processing → ready without refreshing, and the products appear in the preview.
3. Re-sync the file; then delete the source after confirming.
4. Upload a `.txt` file: an error banner appears.

If no DB with pgvector is reachable, record "browser check not run: no pgvector DB" in the task notes and continue. The integration tests already cover the API.

- [ ] **Step 4: Commit**

```bash
git add client/src/
git commit -m "Add Catalog page to the dashboard"
```

---

### Task 15: Settings toggle, Unanswered panel, transcript cards, final verification

**Files:**
- Modify: `client/src/pages/Settings.jsx` (state, load, save payload, new form section), `client/src/pages/Topics.jsx`, `client/src/components/SessionDrawer.jsx:58-78`

**Interfaces:**
- Consumes: `PUT /api/bots/:id` fields (Task 3); unanswered endpoints and `session.products` (Task 12); `ProductCard` (Task 14).
- Produces:
  - **Settings:** an "Answer mode" segmented control with **Flexible** and **Strict**. Helper text: Flexible = "Answers general questions too, but never invents products or prices."; Strict = "Only answers from your catalog." A "Fallback message" textarea (`maxLength={500}`, shown in both modes, placeholder = the default fallback text) is saved in the existing PUT.
  - **Topics:** an "Unanswered questions" card under the charts, using the page's `botId`/`range`. Each row shows the question, a count badge, `last_asked` (locale string) and a "Mark resolved" button (POST, then refetch). Empty state: "No unanswered questions in this period."
  - **SessionDrawer:** under each assistant bubble with `product_ids`, render `ProductCard` for each ID present in `session.products`.

- [ ] **Step 1: Implement the changes above**

- [ ] **Step 2: Build the client and run the whole suite**

Run: `npm run client:build` and `npm test`
Expected: build succeeds; all tests PASS.

- [ ] **Step 3: Check the whole flow in the browser**

With the same setup as Task 14 Step 3:
1. Set the bot to **Strict** with a custom fallback message and save; reload, and it's still Strict.
2. Embed the widget on a test page and ask "waterproof jacket under 3000": a streamed answer appears, followed by product cards.
3. Ask something the catalog doesn't cover: the fallback message appears, and the question shows in **Topics → Unanswered questions**. Mark it resolved and it disappears.
4. Open the session in **Chat Logs**: product cards appear under the assistant message.

If this can't be run (no pgvector DB or no OpenAI key), say so explicitly in the final report.

- [ ] **Step 4: Commit**

```bash
git add client/src/
git commit -m "Add answer mode setting, unanswered questions panel and transcript product cards"
```
