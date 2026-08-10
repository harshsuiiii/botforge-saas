'use strict';

/**
 * bots.js
 * ───────
 * BotForge – Bot Configuration Router
 *
 * Routes
 * ──────
 *  POST   /api/bots                 – create bot
 *  GET    /api/bots/:id             – fetch bot (owner only)
 *  PUT    /api/bots/:id             – update bot fields (owner only)
 *  DELETE /api/bots/:id             – soft-delete (owner only)
 *  POST   /api/bots/:id/embed-key   – generate / rotate embed key (owner only)
 *
 * All routes require a valid BotForge JWT (set by authMiddleware).
 * req.user.sub  →  authenticated user UUID
 */

const express  = require('express');
const crypto   = require('crypto');
const { body, param, validationResult } = require('express-validator');

const pool                = require('../auth/db');
const { authMiddleware }  = require('../auth/middleware');
const { assembleSystemPrompt } = require('./system-prompt');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_PERSONALITIES = ['friendly', 'professional', 'concise', 'expert'];
const WIDGET_HOST         = process.env.WIDGET_HOST || process.env.FRONTEND_URL?.replace(':5173', ':3000') || 'http://localhost:3000';

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Express-validator chain for bot creation / update body fields.
 * All fields are optional on update, required checks are applied separately.
 */
const botBodyValidators = [
  body('name')
    .optional()
    .isString().withMessage('name must be a string.')
    .trim()
    .isLength({ min: 1, max: 120 }).withMessage('name must be 1–120 characters.'),

  body('personality')
    .optional()
    .isIn(VALID_PERSONALITIES)
    .withMessage(`personality must be one of: ${VALID_PERSONALITIES.join(', ')}.`),

  body('purpose')
    .optional()
    .isString().withMessage('purpose must be a string.')
    .trim()
    .isLength({ max: 2000 }).withMessage('purpose must be ≤ 2000 characters.'),

  body('instructions')
    .optional()
    .isString().withMessage('instructions must be a string.')
    .trim()
    .isLength({ max: 8000 }).withMessage('instructions must be ≤ 8000 characters.'),

  body('topic_allow_list')
    .optional()
    .isArray().withMessage('topic_allow_list must be an array.'),

  body('topic_allow_list.*')
    .optional()
    .isString().trim().isLength({ min: 1, max: 200 }),

  body('topic_block_list')
    .optional()
    .isArray().withMessage('topic_block_list must be an array.'),

  body('topic_block_list.*')
    .optional()
    .isString().trim().isLength({ min: 1, max: 200 }),

  body('spend_cap')
    .optional({ nullable: true })
    .isFloat({ min: 0 }).withMessage('spend_cap must be a non-negative number.'),
];

/**
 * Terminate the request early if any validators failed.
 * @type {import('express').RequestHandler}
 */
function rejectInvalid(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed.', details: errors.array() });
  }
  next();
}

// ─── Ownership guard ──────────────────────────────────────────────────────────

/**
 * Fetch a bot row and verify ownership.
 * Returns the row on success; writes the HTTP response and returns null on failure.
 *
 * @param {string} botId
 * @param {string} userId
 * @param {import('express').Response} res
 * @param {{ includeDeleted?: boolean }} opts
 * @returns {Promise<object | null>}
 */
async function requireBotOwner(botId, userId, res, { includeDeleted = false } = {}) {
  const deletedFilter = includeDeleted ? '' : 'AND deleted_at IS NULL';

  const { rows } = await pool.query(
    `SELECT * FROM bots WHERE id = $1 ${deletedFilter}`,
    [botId],
  );

  if (!rows.length) {
    res.status(404).json({ error: 'Bot not found.' });
    return null;
  }

  if (rows[0].user_id !== userId) {
    res.status(403).json({ error: 'Forbidden: you do not own this bot.' });
    return null;
  }

  return rows[0];
}

// ─── Embed snippet builder ────────────────────────────────────────────────────

/**
 * Generate the ready-to-paste HTML embed snippet for a given embed_key.
 * @param {string} embedKey
 * @returns {string}
 */
function buildEmbedSnippet(embedKey) {
  return `<script src="${WIDGET_HOST}/widget.js" data-bot="${embedKey}" async></script>`;
}

// ─── Route: GET /api/bots ─────────────────────────────────────────────────────

/**
 * List all active bots owned by the authenticated user.
 * Returns: { bots: [{ id, name, personality, created_at, ... }] }
 */
router.get(
  '/',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.sub;

    try {
      const { rows } = await pool.query(
        `SELECT id, name, personality, purpose, model, spend_cap, created_at
         FROM   bots
         WHERE  user_id = $1 AND deleted_at IS NULL
         ORDER  BY created_at DESC`,
        [userId],
      );

      return res.json({ bots: rows });
    } catch (err) {
      console.error('[bots] GET /api/bots error:', err.message);
      return res.status(500).json({ error: 'Failed to list bots.' });
    }
  },
);

// ─── Route: POST /api/bots ────────────────────────────────────────────────────

/**
 * Create a new bot for the authenticated user.
 *
 * Body (all optional except `name`):
 *   name, personality, purpose, instructions,
 *   topic_allow_list[], topic_block_list[], spend_cap
 *
 * Returns: created bot row including assembled system_prompt.
 */
router.post(
  '/',
  authMiddleware,
  [body('name').notEmpty().withMessage('name is required.'), ...botBodyValidators],
  rejectInvalid,
  async (req, res) => {
    const userId = req.user.sub;
    const {
      name,
      personality       = 'friendly',
      purpose           = '',
      instructions      = '',
      topic_allow_list  = [],
      topic_block_list  = [],
      spend_cap         = null,
    } = req.body;

    const systemPrompt = assembleSystemPrompt({
      personality,
      purpose,
      instructions,
      topic_allow_list,
      topic_block_list,
    });

    try {
      const { rows } = await pool.query(
        `INSERT INTO bots
           (user_id, name, personality, purpose, instructions,
            topic_allow_list, topic_block_list, spend_cap, system_prompt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          userId,
          name,
          personality,
          purpose,
          instructions,
          topic_allow_list,
          topic_block_list,
          spend_cap,
          systemPrompt,
        ],
      );

      return res.status(201).json({ bot: rows[0] });
    } catch (err) {
      console.error('[bots] POST /api/bots error:', err.message);
      return res.status(500).json({ error: 'Failed to create bot.' });
    }
  },
);

// ─── Route: GET /api/bots/:id ─────────────────────────────────────────────────

/**
 * Fetch a single bot config for the authenticated owner.
 * Includes system_prompt and embed_key if one exists in embed_configs.
 */
router.get(
  '/:id',
  authMiddleware,
  param('id').isUUID().withMessage('id must be a valid UUID.'),
  rejectInvalid,
  async (req, res) => {
    const userId = req.user.sub;
    const botId  = req.params.id;

    try {
      const bot = await requireBotOwner(botId, userId, res);
      if (!bot) return; // response already sent

      // Fetch embed_key and domain_allowlist if provisioned
      const { rows: embedRows } = await pool.query(
        `SELECT embed_key, domain_allowlist
         FROM   embed_configs
         WHERE  bot_id = $1
         LIMIT  1`,
        [botId],
      );

      const embedConfig = embedRows[0] ?? null;

      return res.json({
        bot: {
          ...bot,
          embed_key        : embedConfig?.embed_key        ?? null,
          domain_allowlist : embedConfig?.domain_allowlist ?? null,
          embed_snippet    : embedConfig
            ? buildEmbedSnippet(embedConfig.embed_key)
            : null,
        },
      });
    } catch (err) {
      console.error('[bots] GET /api/bots/:id error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch bot.' });
    }
  },
);

// ─── Route: PUT /api/bots/:id ─────────────────────────────────────────────────

/**
 * Update any bot config field.
 * system_prompt is always re-generated from the merged (existing + new) values.
 * Only the owning user may update.
 */
router.put(
  '/:id',
  authMiddleware,
  [param('id').isUUID().withMessage('id must be a valid UUID.'), ...botBodyValidators],
  rejectInvalid,
  async (req, res) => {
    const userId = req.user.sub;
    const botId  = req.params.id;

    try {
      const existing = await requireBotOwner(botId, userId, res);
      if (!existing) return;

      // Merge incoming fields over existing values so callers may send partial updates
      const merged = {
        name             : req.body.name             ?? existing.name,
        personality      : req.body.personality      ?? existing.personality,
        purpose          : req.body.purpose          ?? existing.purpose,
        instructions     : req.body.instructions     ?? existing.instructions,
        topic_allow_list : req.body.topic_allow_list ?? existing.topic_allow_list,
        topic_block_list : req.body.topic_block_list ?? existing.topic_block_list,
        spend_cap        : req.body.spend_cap        !== undefined
          ? req.body.spend_cap
          : existing.spend_cap,
        model            : req.body.model            ?? existing.model,
      };

      // Re-assemble prompt from merged config
      const systemPrompt = assembleSystemPrompt({
        personality      : merged.personality,
        purpose          : merged.purpose,
        instructions     : merged.instructions,
        topic_allow_list : merged.topic_allow_list,
        topic_block_list : merged.topic_block_list,
      });

      const { rows } = await pool.query(
        `UPDATE bots SET
           name             = $1,
           personality      = $2,
           purpose          = $3,
           instructions     = $4,
           topic_allow_list = $5,
           topic_block_list = $6,
           spend_cap        = $7,
           model            = $8,
           system_prompt    = $9
         WHERE id = $10
         RETURNING *`,
        [
          merged.name,
          merged.personality,
          merged.purpose,
          merged.instructions,
          merged.topic_allow_list,
          merged.topic_block_list,
          merged.spend_cap,
          merged.model,
          systemPrompt,
          botId,
        ],
      );

      return res.json({ bot: rows[0] });
    } catch (err) {
      console.error('[bots] PUT /api/bots/:id error:', err.message);
      return res.status(500).json({ error: 'Failed to update bot.' });
    }
  },
);

// ─── Route: DELETE /api/bots/:id ─────────────────────────────────────────────

/**
 * Soft-delete a bot by setting deleted_at = NOW().
 * All session history is preserved because no rows are physically removed.
 * Returns 204 No Content on success.
 */
router.delete(
  '/:id',
  authMiddleware,
  param('id').isUUID().withMessage('id must be a valid UUID.'),
  rejectInvalid,
  async (req, res) => {
    const userId = req.user.sub;
    const botId  = req.params.id;

    try {
      const bot = await requireBotOwner(botId, userId, res);
      if (!bot) return;

      await pool.query(
        `UPDATE bots SET deleted_at = NOW() WHERE id = $1`,
        [botId],
      );

      return res.status(204).send();
    } catch (err) {
      console.error('[bots] DELETE /api/bots/:id error:', err.message);
      return res.status(500).json({ error: 'Failed to delete bot.' });
    }
  },
);

// ─── Route: POST /api/bots/:id/embed-key ─────────────────────────────────────

/**
 * Generate (or rotate) a secure embed key for the bot.
 * Uses crypto.randomBytes(16) → 32-char lowercase hex string.
 * Upserts a row in embed_configs keyed on bot_id.
 *
 * Body (optional):
 *   domain_allowlist: string[]  – list of allowed embedding origins
 *
 * Returns:
 *   { embed_key, embed_snippet, domain_allowlist }
 */
router.post(
  '/:id/embed-key',
  authMiddleware,
  [
    param('id').isUUID().withMessage('id must be a valid UUID.'),
    body('domain_allowlist')
      .optional()
      .isArray().withMessage('domain_allowlist must be an array of strings.'),
    body('domain_allowlist.*')
      .optional()
      .isString().trim().isURL({ require_tld: true })
      .withMessage('Each domain_allowlist entry must be a valid URL.'),
  ],
  rejectInvalid,
  async (req, res) => {
    const userId = req.user.sub;
    const botId  = req.params.id;

    try {
      const bot = await requireBotOwner(botId, userId, res);
      if (!bot) return;

      // 16 random bytes → 32-char hex string
      const embedKey       = crypto.randomBytes(16).toString('hex');
      const domainAllowlist = req.body.domain_allowlist ?? [];

      // Upsert: if a config already exists for this bot_id, rotate the key
      const { rows } = await pool.query(
        `INSERT INTO embed_configs (bot_id, embed_key, domain_allowlist)
         VALUES ($1, $2, $3)
         ON CONFLICT (bot_id) DO UPDATE
           SET embed_key        = EXCLUDED.embed_key,
               domain_allowlist = EXCLUDED.domain_allowlist
         RETURNING embed_key, domain_allowlist`,
        [botId, embedKey, domainAllowlist],
      );

      const { embed_key, domain_allowlist: savedAllowlist } = rows[0];
      const embedSnippet = buildEmbedSnippet(embed_key);

      return res.status(201).json({
        embed_key       : embed_key,
        embed_snippet   : embedSnippet,
        domain_allowlist: savedAllowlist,
      });
    } catch (err) {
      console.error('[bots] POST /api/bots/:id/embed-key error:', err.message);
      return res.status(500).json({ error: 'Failed to generate embed key.' });
    }
  },
);

module.exports = router;
