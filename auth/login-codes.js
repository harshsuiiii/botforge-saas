'use strict';

/**
 * login-codes.js
 * ──────────────
 * BotForge – short-lived, single-use login codes.
 *
 * Sign-in redirects carry one of these instead of the JWT, so the JWT never
 * appears in a URL (browser history, server logs, Referer headers). The
 * dashboard swaps the code for the JWT with POST /auth/exchange.
 *
 * Codes live in process memory: fine for a single API instance; a
 * multi-instance deployment would need a shared store.
 */

const crypto = require('crypto');

const CODE_TTL_MS = 60 * 1000;
const codes = new Map(); // code → { userId, expiresAt }

function purgeExpired(now) {
  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) codes.delete(code);
  }
}

/** @returns {string} 64-char hex code, valid once for 60 seconds */
function issueLoginCode(userId, now = Date.now()) {
  purgeExpired(now);
  const code = crypto.randomBytes(32).toString('hex');
  codes.set(code, { userId, expiresAt: now + CODE_TTL_MS });
  return code;
}

/** @returns {string|null} the user id, or null when unknown, used or expired */
function redeemLoginCode(code, now = Date.now()) {
  const entry = codes.get(code);
  codes.delete(code);
  if (!entry || entry.expiresAt <= now) return null;
  return entry.userId;
}

module.exports = { CODE_TTL_MS, issueLoginCode, redeemLoginCode };
