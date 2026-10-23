'use strict';

/**
 * ownership.js
 * ────────────
 * BotForge – bot ownership guard shared by the bots and catalog routers.
 */

const pool = require('../auth/db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Express middleware: validates req.params.id, checks ownership against
 * req.user.sub (set by authMiddleware) and attaches the row as req.bot.
 *
 * @type {import('express').RequestHandler}
 */
async function loadOwnedBot(req, res, next) {
  if (!UUID_RE.test(req.params.id ?? '')) {
    return res.status(400).json({ error: 'id must be a valid UUID.' });
  }

  try {
    const bot = await requireBotOwner(req.params.id, req.user.sub, res);
    if (!bot) return; // response already sent
    req.bot = bot;
    return next();
  } catch (err) {
    console.error('[ownership] bot lookup failed:', err.message);
    return res.status(500).json({ error: 'Failed to load bot.' });
  }
}

module.exports = { requireBotOwner, loadOwnedBot, UUID_RE };
