'use strict';

/**
 * detect-topic.js
 * ───────────────
 * BotForge – Topic Detection Module
 *
 * Two-stage pipeline:
 *
 *   Stage 1 ── Fast keyword scan  (zero-cost, no API call)
 *               Check user message against topic_block_list.
 *               On match → return { blocked: true, matched_topic, topic: null }.
 *
 *   Stage 2 ── GPT-4o-mini classification  (only when not blocked)
 *               Classify message into exactly one allow-list topic.
 *               On error → graceful fallback, never throws.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration in the Phase 5 proxy  (chat/chat.js)
 * ─────────────────────────────────────────────────
 *
 * Call site (after loading session history, before building messages array):
 *
 *   // openaiToken is already decrypted by the proxy — passed straight through.
 *   const detection = await detectTopic(userMessage, bot, openaiToken);
 *
 *   // Map return value → session log fields:
 *   //   detection.blocked        → sessions.blocked
 *   //   [detection.matched_topic
 *   //    ?? detection.topic]     → sessions.topics_detected  (as a 1-element array)
 *   //                              (or merged with other detected topics if you
 *   //                               accumulate across turns)
 *
 *   if (detection.blocked) {
 *     // short-circuit: persist session with blocked=true, outcome='blocked'
 *     // return polite refusal to client — skip OpenAI chat call entirely
 *     return res.json({ blocked: true, reply: REFUSAL_MESSAGE, session_id });
 *   }
 *
 *   // Non-blocked: session.topics_detected gets detection.topic
 *   const topicsDetected = detection.topic ? [detection.topic] : [];
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * @module detect-topic
 */

const OpenAI = require('openai');

// ─── Constants ────────────────────────────────────────────────────────────────

const SHORT_MESSAGE_MIN_LENGTH = 3;
const FALLBACK_TOPIC_GPT_ERROR = 'unknown';
const FALLBACK_TOPIC_NO_LISTS  = 'general';
const FALLBACK_TOPIC_SHORT_MSG = 'other';
const FALLBACK_TOPIC_NO_MATCH  = 'other';
const CLASSIFIER_MODEL         = 'gpt-4o-mini';
const CLASSIFIER_MAX_TOKENS    = 10;
const CLASSIFIER_TEMPERATURE   = 0;

// ─── Stage 1 – Fast keyword matching ─────────────────────────────────────────

/**
 * Build a case-insensitive regex for a topic phrase.
 *
 * Matching strategy: "partial word boundary"
 *   – The phrase is matched wherever it appears, but must begin and end at a
 *     word boundary (\b) so single-letter substrings don't create false positives.
 *   – Multi-word phrases (e.g. "credit card") are matched as a contiguous sequence
 *     with flexible inner whitespace.
 *   – Regex metacharacters inside the phrase are escaped.
 *
 * Examples:
 *   phrase "violence"  matches "violence", "VIOLENCE", "extreme violence"
 *   phrase "card"      matches "card" but NOT "cardiovascular"
 *   phrase "credit card" matches "credit  card" (extra space)
 *
 * @param {string} phrase
 * @returns {RegExp}
 */
function buildBlockRegex(phrase) {
  const escaped  = phrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape metacharacters
    .replace(/\s+/g, '\\s+');                // flexible inner whitespace
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/**
 * Stage 1: scan `message` against every phrase in `blockList`.
 * Returns the first matched phrase, or null if none match.
 *
 * @param {string}   message
 * @param {string[]} blockList
 * @returns {string | null}  matched phrase, or null
 */
function findBlockedKeyword(message, blockList) {
  if (!blockList?.length) return null;

  for (const phrase of blockList) {
    if (!phrase?.trim()) continue;
    if (buildBlockRegex(phrase).test(message)) {
      return phrase.trim();
    }
  }
  return null;
}

// ─── Stage 2 – GPT-4o-mini classification ────────────────────────────────────

/**
 * Build the classifier system prompt.
 *
 * Full prompt sent to gpt-4o-mini:
 * ─────────────────────────────────
 *   You are a topic classifier. Classify the user message into exactly one of
 *   these topics: <topic1>, <topic2>, ...
 *   If none apply, return "other".
 *   Respond with only the topic name, lowercase, no punctuation.
 *
 * @param {string[]} allowList
 * @returns {string}
 */
function buildClassifierSystemPrompt(allowList) {
  const joined = allowList.map((t) => t.trim().toLowerCase()).join(', ');
  return (
    `You are a topic classifier. Classify the user message into exactly one of ` +
    `these topics: ${joined}.\n` +
    `If none apply, return "other".\n` +
    `Respond with only the topic name, lowercase, no punctuation.`
  );
}

/**
 * Normalise the raw string returned by the model.
 * Strips surrounding whitespace, quotes, and punctuation; lowercases.
 *
 * @param {string} raw
 * @returns {string}
 */
function normaliseClassifierOutput(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '')   // strip wrapping quotes
    .replace(/[.,!?;:]$/g, '')     // strip trailing punctuation
    .trim();
}

/**
 * Stage 2: call gpt-4o-mini to classify `message` into one of `allowList`.
 *
 * @param {string}   message
 * @param {string[]} allowList
 * @param {string}   openaiToken  – plaintext API key (already decrypted by proxy)
 * @returns {Promise<string>}     – normalised topic string, never throws
 */
async function classifyWithGPT(message, allowList, openaiToken) {
  try {
    const client = new OpenAI({ apiKey: openaiToken });

    const response = await client.chat.completions.create({
      model      : CLASSIFIER_MODEL,
      max_tokens : CLASSIFIER_MAX_TOKENS,
      temperature: CLASSIFIER_TEMPERATURE,
      messages   : [
        {
          role   : 'system',
          content: buildClassifierSystemPrompt(allowList),
        },
        {
          role   : 'user',
          content: message,
        },
      ],
    });

    const raw = response.choices?.[0]?.message?.content ?? '';
    if (!raw.trim()) return FALLBACK_TOPIC_GPT_ERROR;

    const normalised = normaliseClassifierOutput(raw);

    // Sanity-check: if the model hallucinated a topic not in the list, return 'other'
    const validTopics = new Set([
      ...allowList.map((t) => t.trim().toLowerCase()),
      'other',
    ]);

    return validTopics.has(normalised) ? normalised : FALLBACK_TOPIC_NO_MATCH;
  } catch (err) {
    // Never let a GPT error crash the proxy — log and return safe fallback
    console.warn('[detect-topic] GPT classification error:', err?.message ?? err);
    return FALLBACK_TOPIC_GPT_ERROR;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * detectTopic
 * ───────────
 * Main export. Called by the /chat proxy before building the OpenAI chat request.
 *
 * @param {string} message       – raw user message string
 * @param {{
 *   topic_allow_list?: string[],
 *   topic_block_list?: string[],
 * }} botConfig                  – bot configuration (lists may be undefined/empty)
 * @param {string} openaiToken   – plaintext OpenAI API key (decrypted upstream)
 *
 * @returns {Promise<{
 *   blocked       : boolean,
 *   matched_topic : string | null,
 *   topic         : string | null,
 * }>}
 *
 * Return value mapping to session log fields:
 *   blocked         → sessions.blocked
 *   matched_topic   → sessions.topics_detected[0]  (when blocked)
 *   topic           → sessions.topics_detected[0]  (when not blocked)
 */
async function detectTopic(message, botConfig, openaiToken) {
  const allowList = botConfig?.topic_allow_list ?? [];
  const blockList = botConfig?.topic_block_list ?? [];

  // ── Edge case: message too short to meaningfully classify ────────────────
  if (!message || message.trim().length < SHORT_MESSAGE_MIN_LENGTH) {
    return { blocked: false, matched_topic: null, topic: FALLBACK_TOPIC_SHORT_MSG };
  }

  const trimmedMessage = message.trim();

  // ── Stage 1: Fast keyword block check ───────────────────────────────────
  // O(n) scan — no API cost. Returns immediately on first match.
  if (blockList.length > 0) {
    const matchedPhrase = findBlockedKeyword(trimmedMessage, blockList);
    if (matchedPhrase !== null) {
      return { blocked: true, matched_topic: matchedPhrase, topic: null };
    }
  }

  // ── Edge case: no allow-list defined — skip GPT call ────────────────────
  // Return a generic "general" topic so sessions.topics_detected is never empty.
  if (allowList.length === 0) {
    return { blocked: false, matched_topic: null, topic: FALLBACK_TOPIC_NO_LISTS };
  }

  // ── Stage 2: GPT-4o-mini classification ─────────────────────────────────
  // Only reached when: message is long enough, not blocked, allow-list exists.
  const topic = await classifyWithGPT(trimmedMessage, allowList, openaiToken);

  return { blocked: false, matched_topic: null, topic };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  detectTopic,
  // Named exports for unit testing internal helpers
  findBlockedKeyword,
  buildClassifierSystemPrompt,
  normaliseClassifierOutput,
};
