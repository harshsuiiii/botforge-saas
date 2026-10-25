'use strict';

const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt           = require('jsonwebtoken');
const pool          = require('./db');
const { issueLoginCode, redeemLoginCode } = require('./login-codes');

/** True when real Google OAuth credentials are set (not missing or .env.example placeholders). */
function isGoogleConfigured() {
  const id     = process.env.GOOGLE_CLIENT_ID ?? '';
  const secret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  return !!id && !!secret && !id.includes('your_google_client_id') && !secret.includes('your_google_client_secret');
}

/**
 * Google OAuth 2.0 Strategy
 * ─────────────────────────
 * Scopes: profile + email only.
 * On callback:
 *   1. Upsert user row by google_id (email may update if changed).
 *   2. Return the db user object; the route handler issues a login code.
 * Registered only when credentials are configured (the strategy throws without a client id).
 */
if (isGoogleConfigured()) passport.use(
  new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL, // e.g. https://yourdomain.com/auth/google/callback
      scope:        ['profile', 'email'],
    },
    async (_accessToken, _refreshToken, profile, done) => {
      const googleId = profile.id;
      const email    = profile.emails?.[0]?.value;

      if (!email) {
        return done(new Error('Google account did not return an email address.'));
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO users (google_id, email)
           VALUES ($1, $2)
           ON CONFLICT (google_id) DO UPDATE
             SET email = EXCLUDED.email
           RETURNING id, email, google_id, created_at`,
          [googleId, email],
        );

        return done(null, rows[0]);
      } catch (err) {
        return done(err);
      }
    },
  ),
);

// ── JWT helpers ──────────────────────────────────────────────

const JWT_SECRET  = process.env.JWT_SECRET;   // min 32 random bytes
const JWT_EXPIRY  = '7d';

/**
 * Issue a signed HS256 JWT containing { sub: user_id }.
 * @param {string} userId – UUID from the users table
 * @returns {string} signed JWT
 */
function issueToken(userId) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET env var is not set.');
  return jwt.sign({ sub: userId }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRY,
  });
}

// ── Route handlers ───────────────────────────────────────────

const express = require('express');
const router  = express.Router();

/**
 * GET /auth/google
 * Redirect the browser to Google's consent screen.
 */
router.get(
  '/google',
  (req, res, next) => {
    if (isGoogleConfigured()) return next();
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.redirect(`${frontend}/login?error=google_not_configured`);
  },
  passport.authenticate('google', { session: false, scope: ['profile', 'email'] }),
);

/**
 * Front-end callback URL carrying a single-use login code (never the JWT,
 * which would otherwise end up in browser history and logs).
 */
function callbackRedirectUrl(userId) {
  const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
  return `${frontend}/auth/callback?code=${issueLoginCode(userId)}`;
}

/**
 * GET /auth/google/callback
 * Google redirects here after the user grants consent.
 */
router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/auth/failure' }),
  (req, res) => res.redirect(callbackRedirectUrl(req.user.id)),
);

/**
 * POST /auth/exchange  { code } → { token, user }
 * Swap a login code from a sign-in redirect for a JWT. Codes work once, for 60 s.
 */
router.post('/exchange', async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  if (!code) return res.status(400).json({ error: 'code is required.' });

  const userId = redeemLoginCode(code);
  if (!userId) return res.status(401).json({ error: 'This sign-in link has expired. Please sign in again.' });

  try {
    const { rows } = await pool.query('SELECT id, email, google_id, created_at FROM users WHERE id = $1', [userId]);
    if (!rows.length) return res.status(401).json({ error: 'User not found.' });
    return res.json({ token: issueToken(userId), user: rows[0] });
  } catch (err) {
    console.error('[auth] exchange error:', err.message);
    return res.status(500).json({ error: 'Failed to complete sign-in.' });
  }
});

router.get('/failure', (_req, res) => {
  const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
  res.redirect(`${frontend}/login?error=auth_failed`);
});

router.get('/me', require('./middleware').authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, google_id, created_at
       FROM users WHERE id = $1`,
      [req.user.sub],
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    return res.json({ user: rows[0] });
  } catch (err) {
    console.error('[auth] GET /me error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

module.exports = { router, issueToken, callbackRedirectUrl, isGoogleConfigured };
