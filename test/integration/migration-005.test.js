'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const { setupTestDb, seedBot } = require('../helpers/db');
const { fakeEmbedding } = require('../helpers/openai-stub');

let db;
let pool;

const vec = (text) => JSON.stringify(fakeEmbedding(text));

async function insertSource(botId) {
  const { rows: [s] } = await pool.query(
    `INSERT INTO catalog_sources (bot_id, kind, name) VALUES ($1, 'spreadsheet', 'c.csv') RETURNING id`,
    [botId],
  );
  return s.id;
}

async function insertProduct(botId, sourceId, key, name) {
  await pool.query(
    `INSERT INTO catalog_products (bot_id, source_id, external_key, name, content_hash, embedding)
     VALUES ($1, $2, $3, $4, 'h', $5::vector)`,
    [botId, sourceId, key, name, vec(name)],
  );
}

test.before(async () => {
  ({ db, pool } = await setupTestDb());
});

test('bots default to flexible answer mode', async () => {
  const { botId } = await seedBot(pool);
  const { rows: [bot] } = await pool.query('SELECT answer_mode, fallback_message FROM bots WHERE id = $1', [botId]);
  assert.equal(bot.answer_mode, 'flexible');
  assert.equal(bot.fallback_message, null);
});

test('rejects an unknown answer_mode', async () => {
  const { botId } = await seedBot(pool);
  await assert.rejects(
    pool.query(`UPDATE bots SET answer_mode = 'loose' WHERE id = $1`, [botId]),
    /check/i,
  );
});

test('enforces one product per source + external_key', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId);
  await insertProduct(botId, sourceId, 'jk-1', 'Rain Jacket');
  await assert.rejects(insertProduct(botId, sourceId, 'jk-1', 'Rain Jacket'), /unique/i);
});

test('generates search_tsv from product fields', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId);
  await insertProduct(botId, sourceId, 'rain jacket', 'Rain Jacket');
  const { rows: [r] } = await pool.query(
    `SELECT search_tsv @@ plainto_tsquery('simple', 'jacket') AS hit FROM catalog_products WHERE source_id = $1`,
    [sourceId],
  );
  assert.equal(r.hit, true);
});

test('deleting a bot cascades catalog rows', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId);
  await insertProduct(botId, sourceId, 'cap', 'Cap');
  await pool.query(
    `INSERT INTO catalog_info (bot_id, source_id, title, content, content_hash, embedding)
     VALUES ($1, $2, 'Returns', '7 days', 'h1', $3::vector)`,
    [botId, sourceId, vec('Returns 7 days')],
  );
  await pool.query(
    `INSERT INTO unanswered_questions (bot_id, question, reason) VALUES ($1, 'Goa?', 'no_results')`,
    [botId],
  );

  await pool.query('DELETE FROM bots WHERE id = $1', [botId]);

  for (const table of ['catalog_sources', 'catalog_products', 'catalog_info', 'unanswered_questions']) {
    const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE bot_id = $1`, [botId]);
    assert.equal(c.n, 0, `${table} should be empty`);
  }
});

test('creates the HNSW index', async () => {
  const { rows } = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_catalog_products_embedding'`,
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].indexdef, /hnsw/i);
});

test('is safe to re-run', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '005_catalog.sql'), 'utf8');
  await db.exec(sql);
});
