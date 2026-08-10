'use strict';

const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt           = require('jsonwebtoken');
const pool          = require('./db');

/**
 * Google OAuth 2.0 Strategy
 * ─────────────────────────
 * Scopes: profile + email only.
 * On callback:
 *   1. Upsert user row by google_id (email may update if changed).
 *   2. Return the db user object; the route handler issues the JWT.
 */
passport.use(
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
  passport.authenticate('google', { session: false, scope: ['profile', 'email'] }),
);

/**
 * GET /auth/google/callback
 * Google redirects here after the user grants consent.
 * Issues a JWT and returns it (as JSON or a redirect with the token in the URL,
 * depending on your front-end architecture).
 */
router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/auth/failure' }),
  (req, res) => {
    const token = issueToken(req.user.id);
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    const email = encodeURIComponent(req.user.email ?? '');
    res.redirect(`${frontend}/auth/callback?token=${token}&email=${email}`);
  },
);

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

module.exports = { router, issueToken };
