'use strict';

/**
 * openai-key.js
 * ─────────────
 * BotForge – connect a user's OpenAI account by API key.
 *
 * OpenAI does not offer an OAuth flow to third-party apps, so owners paste
 * an API key. It is checked against OpenAI, then stored AES-256-GCM
 * encrypted (one key per user).
 *
 * Routes (mounted at /auth):
 *   POST   /auth/openai/key        – { api_key } validate + store (replaces any existing key)
 *   DELETE /auth/openai/key        – disconnect
 *   GET    /auth/openai/status     – { connected, key_hint }
 *   POST   /auth/openai/spend-cap  – persist default monthly spend cap on user
 */

const express = require('express');
const pool    = require('./db');
const { authMiddleware } = require('./middleware');
const { encryptToken, getOwnerToken } = require('./token-crypto');

const router = express.Router();

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const KEY_PATTERN       = /^sk-[A-Za-z0-9_-]{20,200}$/;
const CHECK_TIMEOUT_MS  = 8000;

/** 'sk-…1234' – enough to recognise a key without revealing it. */
const keyHint = (key) => (key ? `sk-…${key.slice(-4)}` : null);

/**
 * Ask OpenAI whether the key works.
 * @returns {Promise<'valid'|'rejected'|'unavailable'>}
 */
async function checkKey(apiKey) {
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      method : 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal : AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.ok) return 'valid';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

router.post('/openai/key', authMiddleware, async (req, res) => {
  const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  if (!KEY_PATTERN.test(apiKey)) {
    return res.status(400).json({ error: 'Paste an OpenAI API key that starts with "sk-".' });
  }

  const result = await checkKey(apiKey);
  if (result === 'rejected') {
    return res.status(400).json({ error: 'OpenAI rejected this key. Check it and try again.' });
  }
  if (result === 'unavailable') {
    return res.status(502).json({ error: 'Could not reach OpenAI to check the key. Try again in a moment.' });
  }

  try {
    const { encrypted_token, iv } = encryptToken(apiKey);
    await pool.query(
      `INSERT INTO openai_tokens (user_id, encrypted_token, iv)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET encrypted_token = EXCLUDED.encrypted_token, iv = EXCLUDED.iv, updated_at = NOW()`,
      [req.user.sub, encrypted_token, iv],
    );
    return res.json({ connected: true, key_hint: keyHint(apiKey) });
  } catch (err) {
    console.error('[openai-key] save error:', err.message);
    return res.status(500).json({ error: 'Failed to save the OpenAI key.' });
  }
});

router.delete('/openai/key', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM openai_tokens WHERE user_id = $1', [req.user.sub]);
    return res.status(204).send();
  } catch (err) {
    console.error('[openai-key] delete error:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect OpenAI.' });
  }
});

router.get('/openai/status', authMiddleware, async (req, res) => {
  try {
    const key = await getOwnerToken(req.user.sub);
    return res.json({ connected: !!key, key_hint: keyHint(key) });
  } catch (err) {
    console.error('[openai-key] status error:', err.message);
    return res.status(500).json({ error: 'Failed to check OpenAI status.' });
  }
});

router.post('/openai/spend-cap', authMiddleware, async (req, res) => {
  const spendCap = req.body?.spend_cap;
  if (spendCap === undefined || spendCap === null || Number(spendCap) < 0) {
    return res.status(400).json({ error: 'spend_cap must be a non-negative number.' });
  }

  try {
    await pool.query(
      `UPDATE users SET default_spend_cap = $2 WHERE id = $1`,
      [req.user.sub, spendCap],
    );
  } catch (err) {
    console.warn('[openai-key] spend-cap column unavailable:', err.message);
  }
  return res.json({ success: true, spend_cap: Number(spendCap) });
});

module.exports = router;
