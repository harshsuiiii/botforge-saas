'use strict';

/**
 * In-memory Postgres (PGlite + pgvector) standing in for auth/db.js.
 * Call setupTestDb() before requiring any app module that loads auth/db.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..', '..');

process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-test-jwt-secret-1234';

// PGlite has no pgcrypto; gen_random_uuid() is core, so only the embed_key default needs a stand-in
function prepareSql(sql) {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/g, '')
    .replace(/encode\(gen_random_bytes\(24\), 'base64'\)/g, 'md5(random()::text)');
}

async function setupTestDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');
  const db = new PGlite({ extensions: { vector } });

  await db.exec(prepareSql(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8')));
  const migrationsDir = path.join(ROOT, 'migrations');
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(prepareSql(fs.readFileSync(path.join(migrationsDir, file), 'utf8')));
  }

  const query = async (sql, params) => {
    const result = await db.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
    on() {},
    end: async () => {},
  };

  const dbPath = require.resolve(path.join(ROOT, 'auth', 'db.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };

  return { db, pool, close: () => db.close() };
}

async function seedBot(pool, { email, botFields = {}, withToken = true } = {}) {
  const { rows: [user] } = await pool.query(
    'INSERT INTO users (email) VALUES ($1) RETURNING id',
    [email ?? `owner-${crypto.randomBytes(4).toString('hex')}@test.io`],
  );

  const fields = { name: 'Test Bot', system_prompt: 'You are a test bot.', ...botFields };
  const columns = Object.keys(fields);
  const { rows: [bot] } = await pool.query(
    `INSERT INTO bots (user_id, ${columns.join(', ')})
     VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
     RETURNING id`,
    [user.id, ...columns.map((c) => fields[c])],
  );

  const embedKey = crypto.randomBytes(16).toString('hex');
  await pool.query('INSERT INTO embed_configs (bot_id, embed_key) VALUES ($1, $2)', [bot.id, embedKey]);

  const token = 'sk-test-owner';
  if (withToken) {
    const { encryptToken } = require('../../auth/token-crypto');
    const { encrypted_token, iv } = encryptToken(token);
    await pool.query(
      'INSERT INTO openai_tokens (user_id, encrypted_token, iv) VALUES ($1, $2, $3)',
      [user.id, encrypted_token, iv],
    );
  }

  return { userId: user.id, botId: bot.id, embedKey, token };
}

function authHeader(userId) {
  return { Authorization: `Bearer ${jwt.sign({ sub: userId }, process.env.JWT_SECRET)}` };
}

module.exports = { setupTestDb, seedBot, authHeader };
