'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot } = require('../helpers/db');
const { installOpenAIStub } = require('../helpers/openai-stub');

let pool;
let stub;
let runIngest;
let recoverInterruptedImports;
let normalizeProduct;

const csv = (text) => Buffer.from(text, 'utf8');
const embedInputs = () => stub.requests
  .filter((r) => r.path === '/v1/embeddings')
  .reduce((n, r) => n + r.body.input.length, 0);

async function insertSource(botId, kind = 'spreadsheet', name = 'catalog.csv', status = 'pending') {
  const { rows: [s] } = await pool.query(
    'INSERT INTO catalog_sources (bot_id, kind, name, status) VALUES ($1, $2, $3, $4) RETURNING id',
    [botId, kind, name, status],
  );
  return s.id;
}

const getSource = async (id) =>
  (await pool.query('SELECT * FROM catalog_sources WHERE id = $1', [id])).rows[0];
const getProducts = async (sourceId) =>
  (await pool.query('SELECT * FROM catalog_products WHERE source_id = $1 ORDER BY name', [sourceId])).rows;

test.before(async () => {
  ({ pool } = await setupTestDb());
  ({ runIngest, recoverInterruptedImports } = require('../../catalog/ingest'));
  ({ normalizeProduct } = require('../../catalog/normalize'));
  stub = installOpenAIStub();
});

test.after(() => stub.restore());

test("bills catalog OpenAI calls to the bot's OpenAI project", async () => {
  const { botId } = await seedBot(pool, { botFields: { openai_project_id: 'proj_shop' } });
  const sourceId = await insertSource(botId);
  const before = stub.requests.length;
  await runIngest(sourceId, { buffer: csv('name,price\nCap,199\n'), filename: 'c.csv' });
  const calls = stub.requests.slice(before).filter((r) => r.path === '/v1/embeddings');
  assert.ok(calls.length > 0);
  assert.ok(calls.every((r) => r.headers['OpenAI-Project'] === 'proj_shop'));
});

test('imports a spreadsheet and marks it ready', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId);
  await runIngest(sourceId, {
    buffer  : csv('name,price,stock\nRain Jacket,2999,3\nCap,199,0\nWallet,1200,\n'),
    filename: 'catalog.csv',
  });

  const source = await getSource(sourceId);
  assert.equal(source.status, 'ready');
  assert.equal(source.error, null);
  assert.equal(source.item_count, 3);
  assert.ok(source.last_synced_at);
  const products = await getProducts(sourceId);
  assert.equal(products.length, 3);
  assert.ok(products.every((p) => p.embedding && p.bot_id === botId));
});

test('re-sync embeds only changed rows and deletes missing ones', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId);
  await runIngest(sourceId, { buffer: csv('name,price\nAlpha,100\nBeta,200\nGamma,300\n'), filename: 'c.csv' });

  const before = embedInputs();
  await runIngest(sourceId, { buffer: csv('name,price\nAlpha,150\nBeta,200\n'), filename: 'c.csv' });

  assert.equal(embedInputs() - before, 1);
  const products = await getProducts(sourceId);
  assert.deepEqual(products.map((p) => [p.name, Number(p.price)]), [['Alpha', 150], ['Beta', 200]]);
  assert.equal((await getSource(sourceId)).item_count, 2);
});

test('duplicate SKUs in one file import as one product', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId);
  await runIngest(sourceId, { buffer: csv('name,sku,price\nJacket,JK-1,2999\nJacket Blue,JK-1,\n'), filename: 'c.csv' });
  assert.equal((await getSource(sourceId)).status, 'ready');
  assert.equal((await getProducts(sourceId)).length, 1);
});

test('reports skipped rows but stays ready', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId);
  await runIngest(sourceId, { buffer: csv('name,price\n,10\nCap,20\n'), filename: 'c.csv' });
  const source = await getSource(sourceId);
  assert.equal(source.status, 'ready');
  assert.equal(source.error, 'Skipped 1 rows without a name.');
});

test('a failed import keeps previous products', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId, 'spreadsheet', 'c.xlsx');
  await runIngest(sourceId, { buffer: csv('name,price\nCap,20\n'), filename: 'c.csv' });

  await runIngest(sourceId, { buffer: Buffer.from('this is not a workbook'), filename: 'c.xlsx' });

  const source = await getSource(sourceId);
  assert.equal(source.status, 'failed');
  assert.ok(source.error);
  assert.equal((await getProducts(sourceId)).length, 1);
});

test('fails before embedding when over the product limit', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId);
  const many = Array.from({ length: 5001 }, (_, i) => normalizeProduct({ name: `Item ${i}` }));
  const before = embedInputs();

  await runIngest(sourceId, { buffer: csv(''), filename: 'c.csv' }, {
    parseSpreadsheet: async () => ({ products: many, skipped: 0 }),
  });

  const source = await getSource(sourceId);
  assert.equal(source.status, 'failed');
  assert.match(source.error, /5000/);
  assert.equal(embedInputs(), before);
});

test('fails without an owner token', async () => {
  const { botId } = await seedBot(pool, { withToken: false });
  const sourceId = await insertSource(botId);
  await runIngest(sourceId, { buffer: csv('name\nCap\n'), filename: 'c.csv' });
  const source = await getSource(sourceId);
  assert.equal(source.status, 'failed');
  assert.equal(source.error, 'Connect OpenAI before importing a catalog.');
});

test('imports a URL source through crawl and extraction', async () => {
  const { botId } = await seedBot(pool);
  const sourceId = await insertSource(botId, 'url', 'https://shop.test/');
  stub.queueChat({
    json: {
      choices: [{
        message: {
          content: JSON.stringify({
            products: [{
              name: 'Rain Jacket', category: null, description: null, price: 2999, currency: 'INR',
              in_stock: true, sku: null, url: null, image_url: null, attributes: [],
            }],
            info: [{ title: 'Returns', content: 'Returns accepted within 7 days.' }],
          }),
        },
      }],
    },
  });

  await runIngest(sourceId, { url: 'https://shop.test/' }, {
    crawlSite: async () => [{ url: 'https://shop.test/p', text: 'Rain Jacket ₹2,999. Returns within 7 days.' }],
  });

  const source = await getSource(sourceId);
  assert.equal(source.status, 'ready');
  assert.equal(source.item_count, 2);
  const [product] = await getProducts(sourceId);
  assert.equal(product.url, 'https://shop.test/p');
  const { rows: info } = await pool.query('SELECT * FROM catalog_info WHERE source_id = $1', [sourceId]);
  assert.equal(info.length, 1);
  assert.equal(info[0].url, 'https://shop.test/p');
});

test('recovers interrupted imports', async () => {
  const { botId } = await seedBot(pool);
  const { botId: otherBot } = await seedBot(pool); // one running import per bot
  await pool.query(`UPDATE catalog_sources SET status = 'ready' WHERE status IN ('pending', 'processing')`);
  const a = await insertSource(botId, 'spreadsheet', 'a.csv', 'pending');
  const b = await insertSource(otherBot, 'spreadsheet', 'b.csv', 'processing');
  const c = await insertSource(botId, 'spreadsheet', 'c.csv', 'ready');

  assert.equal(await recoverInterruptedImports(), 2);
  for (const id of [a, b]) {
    const s = await getSource(id);
    assert.equal(s.status, 'failed');
    assert.equal(s.error, 'Interrupted by server restart');
  }
  assert.equal((await getSource(c)).status, 'ready');
});
