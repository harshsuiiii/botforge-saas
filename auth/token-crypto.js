'use strict';

/**
 * token-crypto.js
 * ───────────────
 * BotForge – shared AES-256-GCM helpers for stored OpenAI tokens.
 *
 * Storage convention (openai_tokens table):
 *   encrypted_token = ciphertext || 16-byte GCM auth tag
 *   iv              = 12-byte random nonce
 */

const crypto = require('crypto');
const pool   = require('./db');

const ENCRYPTION_ALGO = 'aes-256-gcm';

/**
 * Return the 32-byte AES key from the TOKEN_ENCRYPTION_KEY env var.
 * Throws at call time rather than at module load so the error is traceable.
 */
function getEncryptionKey() {
  const hexKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * @param {string} plaintext
 * @returns {{ encrypted_token: Buffer, iv: Buffer }}
 */
function encryptToken(plaintext) {
  const key       = getEncryptionKey();
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encrypted_token: Buffer.concat([encrypted, cipher.getAuthTag()]),
    iv,
  };
}

/**
 * @param {Buffer} encryptedToken – ciphertext || auth tag (last 16 bytes)
 * @param {Buffer} iv
 * @returns {string} plaintext token
 */
function decryptToken(encryptedToken, iv) {
  const key        = getEncryptionKey();
  const buf        = Buffer.from(encryptedToken);
  const authTag    = buf.subarray(-16);
  const ciphertext = buf.subarray(0, -16);

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, key, Buffer.from(iv));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Fetch and decrypt the most recent OpenAI token for a user.
 *
 * @param {string} userId
 * @returns {Promise<string | null>} null when the user has not connected OpenAI
 */
async function getOwnerToken(userId) {
  const { rows } = await pool.query(
    `SELECT encrypted_token, iv
     FROM   openai_tokens
     WHERE  user_id = $1
     ORDER  BY updated_at DESC
     LIMIT  1`,
    [userId],
  );
  if (!rows.length) return null;
  return decryptToken(rows[0].encrypted_token, rows[0].iv);
}

module.exports = { encryptToken, decryptToken, getOwnerToken };
