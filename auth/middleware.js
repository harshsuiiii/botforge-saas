'use strict';

/**
 * middleware.js
 * ─────────────
 * BotForge – JWT Auth Middleware
 *
 * Verifies the HS256 JWT issued at Google OAuth callback.
 * On success, attaches `req.user` = decoded payload { sub: uuid, iat, exp }.
 * On failure, returns 401 with a machine-readable error code.
 */

const jwt = require('jsonwebtoken');

/**
 * Typed error codes returned in 401 responses so clients can act accordingly.
 */
const AUTH_ERRORS = {
  MISSING_TOKEN : 'AUTH_TOKEN_MISSING',
  INVALID_TOKEN : 'AUTH_TOKEN_INVALID',
  EXPIRED_TOKEN : 'AUTH_TOKEN_EXPIRED',
};

/**
 * authMiddleware
 * ──────────────
 * Drop-in Express middleware. Attach to any route that requires authentication.
 *
 * Expected request header:
 *   Authorization: Bearer <jwt>
 *
 * On success:
 *   Sets req.user = { sub: <user_uuid>, iat: <number>, exp: <number> }
 *   Calls next().
 *
 * On failure:
 *   Returns HTTP 401 JSON with { error, code }.
 *
 * @type {import('express').RequestHandler}
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] ?? '';
  const parts      = authHeader.split(' ');

  // Header must be exactly "Bearer <token>"
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
    return res.status(401).json({
      error: 'Authorization header missing or malformed. Expected: Bearer <token>',
      code : AUTH_ERRORS.MISSING_TOKEN,
    });
  }

  const token     = parts[1];
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    // Misconfigured server — log loudly but don't leak internals
    console.error('[auth] FATAL: JWT_SECRET env var is not set.');
    return res.status(500).json({ error: 'Server authentication is misconfigured.' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    req.user = payload;   // { sub: uuid, iat, exp }
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        error: 'Token has expired. Please log in again.',
        code : AUTH_ERRORS.EXPIRED_TOKEN,
      });
    }

    // JsonWebTokenError, NotBeforeError, etc.
    return res.status(401).json({
      error: 'Invalid token.',
      code : AUTH_ERRORS.INVALID_TOKEN,
    });
  }
}

/**
 * optionalAuthMiddleware
 * ──────────────────────
 * Same as authMiddleware but never blocks the request.
 * Sets req.user if a valid token is present; leaves it undefined otherwise.
 * Useful for routes that behave differently for authenticated vs anonymous users.
 *
 * @type {import('express').RequestHandler}
 */
function optionalAuthMiddleware(req, _res, next) {
  const authHeader = req.headers['authorization'] ?? '';
  const parts      = authHeader.split(' ');

  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer' && parts[1]) {
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret) {
      try {
        req.user = jwt.verify(parts[1], jwtSecret, { algorithms: ['HS256'] });
      } catch {
        // silently ignore — req.user remains undefined
      }
    }
  }

  return next();
}

module.exports = { authMiddleware, optionalAuthMiddleware, AUTH_ERRORS };
