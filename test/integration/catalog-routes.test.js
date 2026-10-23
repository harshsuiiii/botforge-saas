'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot, authHeader } = require('../helpers/db');
const { installOpenAIStub } = require('../helpers/openai-stub');
const { startApp } = require('../helpers/http');

let pool;
let app;
let stub;

const CSV = 'name,price,stock\nRain Jacket,2999,3\nCap,199,0\n';

function upload(botId, userId, { content = CSV, filename = 'catalog.csv', type = 'text/csv', path = 'sources' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  return fetch(`${app.base}/api/bots/${botId}/catalog/${path}`, {
    method : 'POST',
    headers: authHeader(userId),
    body   : form,
  });
}

function postJson(botId, userId, path, body) {
  return fetch(`${app.base}/api/bots/${botId}/catalog/${path}`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(userId) },
    body   : JSON.stringify(body),
  });
}

const get = (botId, userId, path) =>
  fetch(`${app.base}/api/bots/${botId}/catalog/${path}`, { headers: authHeader(userId) });

async function waitForSource(botId, userId, sourceId) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { sources } = await (await get(botId, userId, 'sources')).json();
    const source = sources.find((s) => s.id === sourceId);
    if (source && !['pending', 'processing'].includes(source.status)) return source;
    if (Date.now() > deadline) throw new Error(`source still ${source?.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function importCsv(botId, userId, content = CSV) {
  const res = await upload(botId, userId, { content });
  assert.equal(res.status, 202);
  const { source } = await res.json();
  return waitForSource(botId, userId, source.id);
}

test.before(async () => {
  ({ pool } = await setupTestDb());
  stub = installOpenAIStub();
  app = await startApp([['/api/bots/:id/catalog', require('../../catalog/routes')]]);
});

test.after(async () => {
  await app.close();
  stub.restore();
});

test('uploads a CSV and reaches ready', async () => {
  const { botId, userId } = await seedBot(pool);
  const res = await upload(botId, userId);
  assert.equal(res.status, 202);
  const { source } = await res.json();
  assert.equal(source.status, 'pending');
  assert.equal(source.kind, 'spreadsheet');
  assert.equal(source.name, 'catalog.csv');

  const done = await waitForSource(botId, userId, source.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.item_count, 2);
});

test('lists sources for the bot only', async () => {
  const a = await seedBot(pool);
  const b = await seedBot(pool);
  await importCsv(a.botId, a.userId);
  const other = await importCsv(b.botId, b.userId);

  const { sources } = await (await get(a.botId, a.userId, 'sources')).json();
  assert.equal(sources.length, 1);
  assert.ok(!sources.some((s) => s.id === other.id));
});

test('rejects unsupported files', async () => {
  const { botId, userId } = await seedBot(pool);
  const res = await upload(botId, userId, { filename: 'notes.txt', type: 'text/plain' });
  assert.equal(res.status, 400);
});

test('rejects a file whose MIME type does not match', async () => {
  const { botId, userId } = await seedBot(pool);
  const res = await upload(botId, userId, { filename: 'catalog.pdf', type: 'text/html' });
  assert.equal(res.status, 400);
});

test('rejects files over 10 MB', async () => {
  const { botId, userId } = await seedBot(pool);
  const res = await upload(botId, userId, { content: 'a'.repeat(10 * 1024 * 1024 + 1) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'File is larger than 10 MB.');
});

test('rejects a request with neither file nor url', async () => {
  const { botId, userId } = await seedBot(pool);
  const res = await postJson(botId, userId, 'sources', {});
  assert.equal(res.status, 400);
});

test('rejects private URLs', async () => {
  const { botId, userId } = await seedBot(pool);
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest', 'file:///etc/passwd']) {
    const res = await postJson(botId, userId, 'sources', { url });
    assert.equal(res.status, 400, url);
    assert.equal((await res.json()).error, 'That URL cannot be imported.');
  }
});

test('requires a connected OpenAI token', async () => {
  const { botId, userId } = await seedBot(pool, { withToken: false });
  const res = await upload(botId, userId);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'Connect OpenAI before importing a catalog.');
});

test('refuses a second import while one is running', async () => {
  const { botId, userId } = await seedBot(pool);
  await pool.query(
    `INSERT INTO catalog_sources (bot_id, kind, name, status) VALUES ($1, 'spreadsheet', 'x.csv', 'processing')`,
    [botId],
  );
  const res = await upload(botId, userId);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'An import is already running for this bot.');
});

test('forbids other users', async () => {
  const { botId } = await seedBot(pool);
  const { userId: other } = await seedBot(pool);
  assert.equal((await upload(botId, other)).status, 403);
  assert.equal((await get(botId, other, 'sources')).status, 403);
});

test('requires authentication', async () => {
  const { botId } = await seedBot(pool);
  const res = await fetch(`${app.base}/api/bots/${botId}/catalog/sources`);
  assert.equal(res.status, 401);
});

test('re-sync of a file source requires a file', async () => {
  const { botId, userId } = await seedBot(pool);
  const source = await importCsv(botId, userId);
  const res = await postJson(botId, userId, `sources/${source.id}/resync`, {});
  assert.equal(res.status, 400);
});

test('re-sync of a file source rejects a different kind', async () => {
  const { botId, userId } = await seedBot(pool);
  const source = await importCsv(botId, userId);
  const res = await upload(botId, userId, {
    path: `sources/${source.id}/resync`, filename: 'c.pdf', type: 'application/pdf',
  });
  assert.equal(res.status, 400);
});

test('re-sync of a file source with a new file updates products', async () => {
  const { botId, userId } = await seedBot(pool);
  const source = await importCsv(botId, userId);
  const res = await upload(botId, userId, {
    path: `sources/${source.id}/resync`, content: 'name,price\nRain Jacket,2499\n',
  });
  assert.equal(res.status, 202);
  const done = await waitForSource(botId, userId, source.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.item_count, 1);
});

test('re-sync of another bot\'s source is not found', async () => {
  const a = await seedBot(pool);
  const b = await seedBot(pool);
  const source = await importCsv(b.botId, b.userId);
  const res = await upload(a.botId, a.userId, { path: `sources/${source.id}/resync` });
  assert.equal(res.status, 404);
});

test('deletes a source and its products', async () => {
  const { botId, userId } = await seedBot(pool);
  const source = await importCsv(botId, userId);
  const res = await fetch(`${app.base}/api/bots/${botId}/catalog/sources/${source.id}`, {
    method: 'DELETE', headers: authHeader(userId),
  });
  assert.equal(res.status, 204);
  const { rows: [c] } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM catalog_products WHERE source_id = $1', [source.id],
  );
  assert.equal(c.n, 0);
});

test('previews products with search and paging', async () => {
  const { botId, userId } = await seedBot(pool);
  await importCsv(botId, userId, 'name,price\nRain Jacket,2999\nDown Jacket,5499\nCap,199\n');

  const res = await get(botId, userId, 'products?search=jack&limit=1&page=2');
  assert.equal(res.status, 200);
  const { products, pagination } = await res.json();
  assert.equal(products.length, 1);
  assert.deepEqual(pagination, { page: 2, limit: 1, total: 2, total_pages: 2 });
  assert.ok(!('embedding' in products[0]));
  assert.equal(typeof products[0].price, 'number');
});
