'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const { setupTestDb, seedBot } = require('../helpers/db');

let db;
let pool;

const addSource = (botId, status) => pool.query(
  `INSERT INTO catalog_sources (bot_id, kind, name, status) VALUES ($1, 'spreadsheet', 'c.csv', $2)`,
  [botId, status],
);

test.before(async () => {
  ({ db, pool } = await setupTestDb());
});

test('allows only one OpenAI token row per user', async () => {
  const { userId } = await seedBot(pool); // seeds one token
  await assert.rejects(
    pool.query(`INSERT INTO openai_tokens (user_id, encrypted_token, iv) VALUES ($1, '\\x00', '\\x00')`, [userId]),
    /unique|duplicate/i,
  );
});

test('allows only one running import per bot', async () => {
  const { botId } = await seedBot(pool);
  await addSource(botId, 'processing');
  await assert.rejects(addSource(botId, 'pending'), /unique|duplicate/i);
  await addSource(botId, 'ready');
  await addSource(botId, 'failed');
});

test('running imports of different bots do not conflict', async () => {
  const a = await seedBot(pool);
  const b = await seedBot(pool);
  await addSource(a.botId, 'pending');
  await addSource(b.botId, 'pending');
});

test('is safe to re-run', async () => {
  await db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '006_unique_tokens_and_running_imports.sql'), 'utf8'));
});
