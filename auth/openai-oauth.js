'use strict';

/**
 * OpenAI OAuth 2.0 flow for connecting a user's OpenAI account.
 *
 * Routes:
 *   GET  /auth/openai           – redirect to OpenAI consent screen
 *   GET  /auth/openai/callback  – exchange code, encrypt & store token
 *   GET  /auth/openai/status    – { connected: boolean }
 *   POST /auth/openai/spend-cap – persist default monthly spend cap on user
 */

const crypto  = require('crypto');
const express = require('express');
const pool    = require('./db');
const { authMiddleware } = require('./middleware');

const router = express.Router();

const ENCRYPTION_ALGO = 'aes-256-gcm';
const OPENAI_AUTH_URL   = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL  = 'https://auth.openai.com/oauth/token';

function getEncryptionKey() {
  const hexKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string.');
  }
  return Buffer.from(hexKey, 'hex');
}

function encryptToken(plaintext) {
  const key = getEncryptionKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted_token: Buffer.concat([encrypted, authTag]),
    iv,
  };
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id    : process.env.OPENAI_CLIENT_ID,
    redirect_uri : process.env.OPENAI_CALLBACK_URL,
    response_type: 'code',
    scope        : 'openid profile email offline_access',
    state,
  });
  return `${OPENAI_AUTH_URL}?${params}`;
}

router.get('/openai', (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).json({ error: 'Missing token query param. Pass your BotForge JWT.' });
  }

  const state = Buffer.from(JSON.stringify({ bf_token: token })).toString('base64url');
  return res.redirect(buildAuthorizeUrl(state));
});

router.get('/openai/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (error) {
    return res.redirect(`${frontend}/onboarding?openai=error`);
  }

  if (!code || !state) {
    return res.redirect(`${frontend}/onboarding?openai=error`);
  }

  let bfToken;
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    bfToken = parsed.bf_token;
  } catch {
    return res.redirect(`${frontend}/onboarding?openai=error`);
  }

  let userId;
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(bfToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    userId = payload.sub;
  } catch {
    return res.redirect(`${frontend}/onboarding?openai=error`);
  }

  try {
    const tokenRes = await fetch(OPENAI_TOKEN_URL, {
      method : 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body   : new URLSearchParams({
        grant_type   : 'authorization_code',
        code,
        redirect_uri : process.env.OPENAI_CALLBACK_URL,
        client_id    : process.env.OPENAI_CLIENT_ID,
        client_secret: process.env.OPENAI_CLIENT_SECRET,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[openai-oauth] token exchange failed:', tokenData);
      return res.redirect(`${frontend}/onboarding?openai=error`);
    }

    const apiKey = tokenData.access_token;
    const { encrypted_token, iv } = encryptToken(apiKey);

    const { rows: existing } = await pool.query(
      `SELECT id FROM openai_tokens WHERE user_id = $1 LIMIT 1`,
      [userId],
    );

    if (existing.length) {
      await pool.query(
        `UPDATE openai_tokens
         SET encrypted_token = $2, iv = $3, updated_at = NOW()
         WHERE user_id = $1`,
        [userId, encrypted_token, iv],
      );
    } else {
      await pool.query(
        `INSERT INTO openai_tokens (user_id, encrypted_token, iv)
         VALUES ($1, $2, $3)`,
        [userId, encrypted_token, iv],
      );
    }

    return res.redirect(`${frontend}/onboarding?openai=connected`);
  } catch (err) {
    console.error('[openai-oauth] callback error:', err.message);
    return res.redirect(`${frontend}/onboarding?openai=error`);
  }
});

router.get('/openai/status', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM openai_tokens WHERE user_id = $1 LIMIT 1`,
      [req.user.sub],
    );
    return res.json({ connected: rows.length > 0 });
  } catch (err) {
    console.error('[openai-oauth] status error:', err.message);
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
    console.warn('[openai-oauth] spend-cap column unavailable:', err.message);
  }
  return res.json({ success: true, spend_cap: Number(spendCap) });
});

module.exports = router;
