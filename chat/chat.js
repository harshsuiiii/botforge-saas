'use strict';

/**
 * chat.js
 * ───────
 * BotForge – Chat Proxy Route
 *
 * POST /chat
 * ──────────
 * Public endpoint called by the embedded widget.
 * No BotForge JWT is required — identity is established via embed_key.
 *
 * Request body:
 *   {
 *     embed_key  : string          – widget identifier (from embed_configs)
 *     message    : string          – user's plaintext message
 *     session_id : string | null   – UUID of existing session (optional)
 *   }
 *
 * Response (on success):
 *   Content-Type: text/event-stream
 *   First chunk:          data: {"session_id":"..."}\n\n
 *   Streaming SSE chunks: data: {"delta":"..."}\n\n
 *   Product cards:        data: {"products":[...]}\n\n   (catalog bots, when products matched)
 *   Final chunk:          data: [DONE]\n\n
 *
 * Response (on block):
 *   Content-Type: application/json
 *   { blocked: true, reply: "..." }
 *
 * Pipeline
 * ────────
 *  1. Look up embed_key → bot_id
 *  2. Fetch bot config (system_prompt, topic lists, model, openai_project_id, user_id)
 *  3. Load session history (if session_id supplied)
 *  4. Topic-block detection against user message
 *  5. Decrypt owner's OpenAI token (AES-256-GCM)
 *  6. Build messages array: [system (+ catalog section), ...history, user]
 *  7. Call OpenAI /v1/chat/completions with stream:true (catalog bots also get
 *     search_products / search_info tools; up to 2 tool rounds)
 *  8. Pipe SSE chunks to client, then product cards for matched products
 *  9. On stream end: log unanswered questions; upsert session (turn_count,
 *     messages incl. product_ids, topics_detected, outcome)
 */

const express = require('express');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');

const pool = require('../auth/db');
const { getOwnerToken } = require('../auth/token-crypto');
const {
  TOOL_DEFINITIONS, DEFAULT_FALLBACK_MESSAGE, buildCatalogPrompt, runToolCall,
} = require('../catalog/tools');
const { createRateLimiter } = require('./rate-limit');

const router = express.Router();

// ─── Abuse limits (public endpoint; each message spends the owner's OpenAI credit) ─

const visitorLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });        // per embed key + IP
const botLimiter     = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 600 });  // per embed key
const RATE_LIMIT_MESSAGE = 'Too many messages. Please wait a moment and try again.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hostname of an allowlist entry ('https://shop.com', 'shop.com'), or null if unparseable. */
function allowlistHost(entry) {
  try {
    const text = String(entry).trim();
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * With an empty allowlist every origin (or none) is allowed. With entries,
 * the request must carry an Origin whose hostname matches an entry or one
 * of its subdomains.
 */
function isOriginAllowed(origin, allowlist) {
  if (!allowlist?.length) return true;
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false; // missing, 'null' or malformed
  }
  return allowlist.map(allowlistHost).filter(Boolean)
    .some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Reuse the visitor's session id only when it is a UUID that is new or
 * already belongs to this bot; otherwise start a fresh session.
 */
async function resolveSessionId(requested, botId) {
  const candidate = typeof requested === 'string' ? requested.trim() : '';
  if (!UUID_RE.test(candidate)) return uuidv4();
  const { rows } = await pool.query('SELECT bot_id FROM sessions WHERE session_id = $1', [candidate]);
  return rows.length && rows[0].bot_id !== botId ? uuidv4() : candidate;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_CHAT_URL  = 'https://api.openai.com/v1/chat/completions';
const CATALOG_TEMPERATURE      = 0.3;
const MAX_TOOL_ROUNDS          = 2;
const MAX_TOOL_CALLS_PER_ROUND = 3;
const MAX_PRODUCT_CARDS        = 4;
const STREAM_ERROR_TEXT        = '\n\nSorry, something went wrong.';
const REFUSAL_MESSAGE  =
  "I'm sorry, but I'm not able to discuss that topic. " +
  'Is there something else I can help you with?';

// ─── CORS middleware (widget can be embedded on any origin) ───────────────────

/**
 * Apply permissive CORS headers so the widget script can POST from any domain.
 * For production you may tighten this by checking against embed_config.domain_allowlist
 * after the embed_key has been resolved (done inside the route handler below).
 */
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Derive an anonymous, non-reversible visitor fingerprint from IP + User-Agent.
 * Never stored as PII — only used to group a visitor's sessions.
 *
 * @param {import('express').Request} req
 * @returns {string} 64-char hex SHA-256 digest
 */
function buildFingerprint(req) {
  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ??
    req.socket?.remoteAddress ??
    'unknown'
  );
  const ua = req.headers['user-agent'] ?? 'unknown';

  return crypto
    .createHash('sha256')
    .update(`${ip}|${ua}`)
    .digest('hex');
}

// ─── Topic detection ──────────────────────────────────────────────────────────

/**
 * Normalise a topic string into a regex-ready keyword.
 * Trims whitespace and escapes regex metacharacters.
 *
 * @param {string} topic
 * @returns {RegExp}
 */
function topicToRegex(topic) {
  const escaped = topic.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/**
 * detectTopics
 * ────────────
 * Scan `text` for occurrences of each topic in `topicList`.
 * Returns an array of matched topic strings (may be empty).
 *
 * @param {string}   text
 * @param {string[]} topicList
 * @returns {string[]}
 */
function detectTopics(text, topicList) {
  if (!topicList?.length) return [];
  return topicList.filter((topic) => topicToRegex(topic).test(text));
}

/**
 * isMessageBlocked
 * ────────────────
 * Returns true if the user message matches any entry in the bot's block list.
 *
 * @param {string}   message
 * @param {string[]} blockList
 * @returns {boolean}
 */
function isMessageBlocked(message, blockList) {
  return detectTopics(message, blockList).length > 0;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve embed_key → bot row (including owner user_id).
 * Returns null if the key doesn't exist.
 *
 * @param {string} embedKey
 * @returns {Promise<object|null>}
 */
async function resolveBotByEmbedKey(embedKey) {
  const { rows } = await pool.query(
    `SELECT b.id,
            b.user_id,
            b.system_prompt,
            b.topic_allow_list,
            b.topic_block_list,
            b.model,
            b.openai_project_id,
            b.deleted_at,
            b.answer_mode,
            b.fallback_message,
            -- Stored catalog data, not source status: a running or failed
            -- re-sync keeps the previous import's rows, so chat keeps using them.
            (EXISTS (SELECT 1 FROM catalog_products cp WHERE cp.bot_id = b.id)
             OR EXISTS (SELECT 1 FROM catalog_info ci WHERE ci.bot_id = b.id)) AS has_catalog,
            ec.domain_allowlist
     FROM   embed_configs ec
     JOIN   bots b ON b.id = ec.bot_id
     WHERE  ec.embed_key = $1`,
    [embedKey],
  );
  return rows[0] ?? null;
}

/**
 * Load the stored messages of an existing session, unchanged
 * ({role, content, ts, product_ids?}) so they can be persisted again as-is.
 * Returns [] if no session found with the given id + bot_id pair.
 *
 * @param {string} sessionId
 * @param {string} botId
 * @returns {Promise<Array<{role:string, content:string, ts?:string, product_ids?:string[]}>>}
 */
async function loadSessionHistory(sessionId, botId) {
  const { rows } = await pool.query(
    `SELECT messages FROM sessions WHERE session_id = $1 AND bot_id = $2`,
    [sessionId, botId],
  );

  if (!rows.length) return [];
  return rows[0].messages ?? [];
}

/**
 * Upsert the session row after a turn completes.
 *
 * @param {{
 *   sessionId:       string,
 *   botId:           string,
 *   fingerprint:     string,
 *   messages:        Array<{role:string, content:string, ts:string}>,
 *   topicsDetected:  string[],
 *   blocked:         boolean,
 *   outcome:         'resolved'|'blocked',
 *   turnCount:       number,
 * }} params
 */
async function upsertSession({
  sessionId,
  botId,
  fingerprint,
  messages,
  topicsDetected,
  blocked,
  outcome,
  turnCount,
}) {
  await pool.query(
    `INSERT INTO sessions
       (session_id, bot_id, user_fingerprint, messages,
        topics_detected, blocked, outcome, turn_count, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       messages        = EXCLUDED.messages,
       topics_detected = EXCLUDED.topics_detected,
       blocked         = EXCLUDED.blocked,
       outcome         = EXCLUDED.outcome,
       turn_count      = EXCLUDED.turn_count,
       ended_at        = NOW()`,
    [
      sessionId,
      botId,
      fingerprint,
      JSON.stringify(messages),
      topicsDetected,
      blocked,
      outcome,
      turnCount,
    ],
  );
}

/**
 * Record a visitor question the catalog could not answer. Best effort.
 */
async function logUnanswered(botId, sessionId, question, reason) {
  try {
    await pool.query(
      `INSERT INTO unanswered_questions (bot_id, session_id, question, reason)
       VALUES ($1, $2, $3, $4)`,
      [botId, sessionId, question, reason],
    );
  } catch (err) {
    console.error('[chat] Failed to log unanswered question:', err.message);
  }
}

// ─── OpenAI streaming ─────────────────────────────────────────────────────────

/**
 * POST to OpenAI chat completions with stream:true.
 * Returns the raw fetch Response (body is a ReadableStream of SSE bytes).
 *
 * @param {string} token – decrypted OpenAI API key
 * @param {{ model: string, messages: Array, projectId: string|null,
 *           tools?: Array, toolChoice?: string }} opts
 *   tools/toolChoice (and the catalog temperature) are sent only when tools is given.
 * @returns {Promise<Response>}
 */
async function openChatStream(token, { model, messages, projectId, tools, toolChoice }) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type' : 'application/json',
  };

  if (projectId) {
    headers['OpenAI-Project'] = projectId;
  }

  const body = {
    model,
    messages,
    stream        : true,
    stream_options: { include_usage: false },
  };
  if (tools) {
    body.tools       = tools;
    body.tool_choice = toolChoice ?? 'auto';
    body.temperature = CATALOG_TEMPERATURE;
  }

  return fetch(OPENAI_CHAT_URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

/**
 * Read an OpenAI SSE stream: forward content deltas to the client as
 * { delta } and collect tool_calls deltas by index.
 *
 * @returns {Promise<{ text: string, toolCalls: Array<{ id, name, arguments }>, finishReason: string|null }>}
 */
async function readCompletion(res, openaiResponse) {
  const reader  = openaiResponse.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const calls   = new Map();
  let text         = '';
  let buffer       = '';
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE lines are delimited by \n — process each complete line
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete tail for next iteration

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const raw = trimmed.slice('data:'.length).trim();
      if (raw === '[DONE]') continue; // we emit our own [DONE]

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // malformed chunk — skip
      }

      const choice = parsed?.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        sseWrite(res, { delta });
      }

      for (const part of choice?.delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: null, name: '', arguments: '' };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
    }
  }

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  return { text, toolCalls, finishReason };
}

/**
 * One OpenAI call after the SSE stream has started: open it, then stream it.
 * @throws {Error} on a non-2xx response
 */
async function streamCompletion(res, token, opts) {
  const openaiResponse = await openChatStream(token, opts);
  if (!openaiResponse.ok) {
    await openaiResponse.body?.cancel();
    throw new Error(`OpenAI responded ${openaiResponse.status}`);
  }
  return readCompletion(res, openaiResponse);
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

/**
 * Set response headers for a Server-Sent Events stream.
 * @param {import('express').Response} res
 */
function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx proxy buffering
  res.flushHeaders();
}

/**
 * Write one SSE data frame to the response.
 * @param {import('express').Response} res
 * @param {object|string} payload
 */
function sseWrite(res, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.write(`data: ${data}\n\n`);
}

// ─── Route: POST /chat ────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { embed_key, message, session_id } = req.body ?? {};

  // ── Input validation ────────────────────────────────────────────────────────
  if (!embed_key || typeof embed_key !== 'string') {
    return res.status(400).json({ error: 'embed_key is required.' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message must be a non-empty string.' });
  }

  const userMessage   = message.trim().slice(0, 4096); // hard cap
  const fingerprint   = buildFingerprint(req);

  // ── Rate limits (checked before any database or OpenAI work) ──────────────
  const perBot     = botLimiter.hit(embed_key);
  const perVisitor = visitorLimiter.hit(`${embed_key}|${req.socket?.remoteAddress ?? 'unknown'}`);
  if (!perBot.allowed || !perVisitor.allowed) {
    res.setHeader('Retry-After', String(Math.max(perBot.allowed ? 0 : perBot.retryAfterSec,
      perVisitor.allowed ? 0 : perVisitor.retryAfterSec)));
    return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }

  // ── Step 1: resolve embed_key → bot ────────────────────────────────────────
  let bot;
  try {
    bot = await resolveBotByEmbedKey(embed_key);
  } catch (err) {
    console.error('[chat] embed_key lookup failed:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }

  if (!bot) {
    return res.status(404).json({ error: 'Unknown embed_key.' });
  }

  if (bot.deleted_at) {
    return res.status(410).json({ error: 'This bot is no longer available.' });
  }

  // Enforce domain_allowlist (requests without an Origin are refused when one is set)
  if (!isOriginAllowed(req.headers.origin, bot.domain_allowlist)) {
    return res.status(403).json({ error: 'Origin not allowed for this bot.' });
  }

  let sessionId;
  try {
    sessionId = await resolveSessionId(session_id, bot.id);
  } catch (err) {
    console.warn('[chat] Could not check session id:', err.message);
    sessionId = uuidv4();
  }

  // ── Step 2: load existing session history ───────────────────────────────────
  let storedMessages = [];
  try {
    storedMessages = await loadSessionHistory(sessionId, bot.id);
  } catch (err) {
    console.warn('[chat] Could not load session history:', err.message);
    // Non-fatal — proceed without history
  }
  // OpenAI only sees {role, content}; stored messages keep ts and product_ids
  const history = storedMessages.map(({ role, content }) => ({ role, content }));

  // ── Step 3: topic detection ─────────────────────────────────────────────────
  const detectedAllowed = detectTopics(userMessage, bot.topic_allow_list ?? []);
  const detectedBlocked = detectTopics(userMessage, bot.topic_block_list ?? []);
  const allDetected     = [...new Set([...detectedAllowed, ...detectedBlocked])];

  const isBlocked = isMessageBlocked(userMessage, bot.topic_block_list ?? []);

  if (isBlocked) {
    // Persist blocked session turn before responding
    const blockedMessages = [
      ...storedMessages,
      { role: 'user',      content: userMessage,    ts: new Date().toISOString() },
      { role: 'assistant', content: REFUSAL_MESSAGE, ts: new Date().toISOString() },
    ];

    try {
      await upsertSession({
        sessionId,
        botId       : bot.id,
        fingerprint,
        messages    : blockedMessages,
        topicsDetected: detectedBlocked,
        blocked     : true,
        outcome     : 'blocked',
        turnCount   : Math.floor(blockedMessages.length / 2),
      });
    } catch (err) {
      console.error('[chat] Failed to persist blocked session:', err.message);
    }

    return res.status(200).json({
      session_id : sessionId,
      blocked    : true,
      reply      : REFUSAL_MESSAGE,
    });
  }

  // ── Step 4: decrypt OpenAI token ────────────────────────────────────────────
  let openaiToken;
  try {
    openaiToken = await getOwnerToken(bot.user_id);
    if (!openaiToken) {
      return res.status(503).json({ error: 'Bot is not connected to OpenAI.' });
    }
  } catch (err) {
    console.error('[chat] Token decryption error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }

  // ── Step 5: build messages array ────────────────────────────────────────────
  // Bots with a ready catalog get the search tools and the catalog prompt section.
  const useCatalog = !!bot.has_catalog;
  const systemContent = useCatalog
    ? `${bot.system_prompt}\n\n${buildCatalogPrompt(bot)}`
    : bot.system_prompt;
  const openaiMessages = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: userMessage },
  ];
  const callOptions = (toolChoice) => ({
    model     : bot.model ?? 'gpt-4o-mini',
    messages  : openaiMessages,
    projectId : bot.openai_project_id ?? null,
    tools     : useCatalog ? TOOL_DEFINITIONS : undefined,
    toolChoice: useCatalog ? toolChoice : undefined,
  });

  // ── Step 6: first OpenAI call (errors here are still plain JSON) ────────────
  let openaiResponse;
  try {
    openaiResponse = await openChatStream(openaiToken, callOptions('auto'));
  } catch (err) {
    console.error('[chat] OpenAI fetch error:', err.message);
    return res.status(502).json({ error: 'Failed to reach OpenAI.' });
  }

  if (!openaiResponse.ok) {
    const errBody = await openaiResponse.json().catch(() => ({}));
    console.error('[chat] OpenAI error response:', openaiResponse.status, errBody);
    return res.status(502).json({
      error  : 'OpenAI API error.',
      detail : errBody?.error?.message ?? null,
    });
  }

  // Begin SSE stream to client
  initSSE(res);
  sseWrite(res, { session_id: sessionId }); // send session_id as first event

  // ── Step 7: stream, running catalog tool rounds when the model asks ─────────
  let assistantReply = '';
  const cards        = new Map();
  const searchCounts = [];

  try {
    let result = await readCompletion(res, openaiResponse);
    assistantReply += result.text;

    // Hard cap: never more than MAX_TOOL_ROUNDS, even if the model ignores tool_choice 'none'
    for (let round = 1;
      useCatalog && round <= MAX_TOOL_ROUNDS && result.finishReason === 'tool_calls' && result.toolCalls.length;
      round++) {
      const calls = result.toolCalls;
      openaiMessages.push({
        role      : 'assistant',
        content   : result.text || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });

      const outcomes = await Promise.all(calls.map((call, i) => (i < MAX_TOOL_CALLS_PER_ROUND
        ? runToolCall(bot.id, openaiToken, call, { projectId: bot.openai_project_id ?? null })
        : { content: JSON.stringify({ error: 'too many calls' }), cards: [], searched: false, resultCount: 0 })));

      outcomes.forEach((outcome, i) => {
        openaiMessages.push({ role: 'tool', tool_call_id: calls[i].id, content: outcome.content });
        if (outcome.searched) searchCounts.push(outcome.resultCount);
        // the same product imported from two sources shows once
        for (const card of outcome.cards) {
          const key = `${String(card.name).toLowerCase()}|${card.price}`;
          if (!cards.has(key)) cards.set(key, card);
        }
      });

      result = await streamCompletion(res, openaiToken, callOptions(round >= MAX_TOOL_ROUNDS ? 'none' : 'auto'));
      assistantReply += result.text;
    }
  } catch (streamErr) {
    console.error('[chat] Stream error:', streamErr.message);
    sseWrite(res, { delta: STREAM_ERROR_TEXT });
  }

  // A strict "not in our catalog" reply must not show loosely matching products
  const fallback = bot.fallback_message || DEFAULT_FALLBACK_MESSAGE;
  const isStrictFallback = useCatalog && bot.answer_mode === 'strict' && assistantReply.includes(fallback);

  const productCards = isStrictFallback ? [] : [...cards.values()].slice(0, MAX_PRODUCT_CARDS);
  if (productCards.length) sseWrite(res, { products: productCards });

  // Send terminal event
  sseWrite(res, '[DONE]');
  res.end();

  // ── Step 8: log unanswered questions, upsert session after stream ends ──────
  if (useCatalog) {
    if (searchCounts.length && searchCounts.every((n) => n === 0)) {
      logUnanswered(bot.id, sessionId, userMessage, 'no_results');
    } else if (isStrictFallback) {
      logUnanswered(bot.id, sessionId, userMessage, 'fallback');
    }
  }

  const now = new Date().toISOString();
  const assistantEntry = { role: 'assistant', content: assistantReply, ts: now };
  if (productCards.length) assistantEntry.product_ids = productCards.map((c) => c.id);
  const updatedMessages = [
    ...storedMessages,
    { role: 'user', content: userMessage, ts: now },
    assistantEntry,
  ];

  setImmediate(async () => {
    try {
      await upsertSession({
        sessionId,
        botId          : bot.id,
        fingerprint,
        messages       : updatedMessages,
        topicsDetected : allDetected,
        blocked        : false,
        outcome        : 'resolved',
        turnCount      : Math.floor(updatedMessages.length / 2),
      });
    } catch (err) {
      console.error('[chat] Session upsert failed:', err.message);
    }
  });
});

/** Test hook: clear rate-limit windows between test cases. */
router.resetRateLimits = () => {
  visitorLimiter.reset();
  botLimiter.reset();
};
router.isOriginAllowed = isOriginAllowed;

module.exports = router;
