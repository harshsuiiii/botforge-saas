'use strict';

/**
 * dev-login.js
 * ────────────
 * BotForge – local-only "sign in as dev user", for using the dashboard
 * before Google OAuth credentials exist.
 *
 * Enabled only when ALL of these hold:
 *   – NODE_ENV is not 'production'
 *   – DEV_LOGIN=true
 *   – the request comes from a loopback address
 * Otherwise POST answers 404, exactly as if the route did not exist.
 *
 * Routes (mounted at /auth):
 *   GET  /auth/dev-login  – { enabled }
 *   POST /auth/dev-login  – { code } for POST /auth/exchange
 */

const express = require('express');
const pool    = require('./db');
const { issueLoginCode } = require('./login-codes');

const router = express.Router();

const DEV_EMAIL = 'dev@botforge.local';
const LOOPBACK  = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackAddress(ip) {
  return LOOPBACK.has(ip);
}

function isDevLoginEnabled(req) {
  return process.env.NODE_ENV !== 'production'
    && process.env.DEV_LOGIN === 'true'
    && isLoopbackAddress(req.socket?.remoteAddress);
}

router.get('/dev-login', (req, res) => res.json({ enabled: isDevLoginEnabled(req) }));

router.post('/dev-login', async (req, res) => {
  if (!isDevLoginEnabled(req)) return res.status(404).json({ error: 'Not found.' });

  try {
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [DEV_EMAIL],
    );
    return res.json({ code: issueLoginCode(user.id) });
  } catch (err) {
    console.error('[dev-login] error:', err.message);
    return res.status(500).json({ error: 'Dev sign-in failed.' });
  }
});

module.exports = { router, isDevLoginEnabled, isLoopbackAddress, DEV_EMAIL };
