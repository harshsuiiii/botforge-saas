'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot, authHeader } = require('../helpers/db');
const { seedCatalog } = require('../helpers/catalog');
const { startApp } = require('../helpers/http');

let pool;
let app;

const get = (userId, path) => fetch(`${app.base}/api/analytics/${path}`, { headers: authHeader(userId) });
const resolve = (userId, id) => fetch(`${app.base}/api/analytics/unanswered/${id}/resolve`, {
  method: 'POST', headers: authHeader(userId),
});

async function addQuestion(botId, question, { resolved = false } = {}) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO unanswered_questions (bot_id, question, reason, resolved_at)
     VALUES ($1, $2, 'no_results', $3) RETURNING id`,
    [botId, question, resolved ? new Date() : null],
  );
  return row.id;
}

test.before(async () => {
  ({ pool } = await setupTestDb());
  app = await startApp([['/api/analytics', require('../../analytics/analytics')]]);
});

test.after(() => app.close());

test('groups unanswered questions by normalised text', async () => {
  const { botId, userId } = await seedBot(pool);
  await addQuestion(botId, 'Do you ship to Goa?');
  await addQuestion(botId, '  do you  ship to goa? ');
  await addQuestion(botId, 'Gift wrapping?');

  const res = await get(userId, `unanswered?bot_id=${botId}&range=30`);
  assert.equal(res.status, 200);
  const { questions } = await res.json();
  assert.equal(questions.length, 2);
  assert.equal(questions[0].count, 2);
  assert.equal(questions[0].question, '  do you  ship to goa? ');
  assert.equal(questions[0].ids.length, 2);
  assert.ok(questions[0].last_asked);
  assert.equal(questions[1].count, 1);
});

test("hides resolved and other users' questions", async () => {
  const { botId, userId } = await seedBot(pool);
  const { botId: otherBot } = await seedBot(pool);
  await addQuestion(botId, 'Resolved one?', { resolved: true });
  await addQuestion(otherBot, 'Someone else?');

  const { questions } = await (await get(userId, 'unanswered')).json();
  assert.deepEqual(questions, []);
});

test('resolve marks the whole group resolved', async () => {
  const { botId, userId } = await seedBot(pool);
  const id = await addQuestion(botId, 'Do you ship to Goa?');
  await addQuestion(botId, 'do you ship to goa?');

  const res = await resolve(userId, id);
  assert.equal(res.status, 204);
  const { questions } = await (await get(userId, `unanswered?bot_id=${botId}`)).json();
  assert.deepEqual(questions, []);
});

test("resolve 404s for another user's question", async () => {
  const { botId } = await seedBot(pool);
  const { userId: other } = await seedBot(pool);
  const id = await addQuestion(botId, 'Mine?');
  assert.equal((await resolve(other, id)).status, 404);
});

test('rejects an invalid range', async () => {
  const { userId } = await seedBot(pool);
  assert.equal((await get(userId, 'unanswered?range=12')).status, 400);
});

test('session transcript includes existing product cards', async () => {
  const { botId, userId } = await seedBot(pool);
  const { products: [jacket] } = await seedCatalog(pool, botId, [
    { name: 'Rain Jacket', price: '2999', in_stock: 'yes', url: 'https://shop.test/j' },
  ]);
  const { botId: otherBot } = await seedBot(pool);
  const { products: [foreign] } = await seedCatalog(pool, otherBot, [{ name: 'Other Bot Item', price: '1' }]);
  const deletedId = '11111111-1111-1111-1111-111111111111';

  const { rows: [session] } = await pool.query(
    `INSERT INTO sessions (bot_id, user_fingerprint, messages)
     VALUES ($1, 'fp', $2::jsonb) RETURNING session_id`,
    [botId, JSON.stringify([
      { role: 'user', content: 'jacket?', ts: new Date().toISOString() },
      { role: 'assistant', content: 'Here.', ts: new Date().toISOString(), product_ids: [jacket.id, deletedId, foreign.id] },
    ])],
  );

  const res = await get(userId, `sessions/${session.session_id}`);
  assert.equal(res.status, 200);
  const { session: body } = await res.json();
  assert.deepEqual(Object.keys(body.products), [jacket.id]);
  assert.deepEqual(body.products[jacket.id], {
    id: jacket.id, name: 'Rain Jacket', price: 2999, currency: 'INR', in_stock: true,
    url: 'https://shop.test/j', image_url: null,
  });
});

test('session transcript without products has an empty map', async () => {
  const { botId, userId } = await seedBot(pool);
  const { rows: [session] } = await pool.query(
    `INSERT INTO sessions (bot_id, user_fingerprint, messages)
     VALUES ($1, 'fp', '[{"role":"user","content":"hi"}]'::jsonb) RETURNING session_id`,
    [botId],
  );
  const { session: body } = await (await get(userId, `sessions/${session.session_id}`)).json();
  assert.deepEqual(body.products, {});
});
