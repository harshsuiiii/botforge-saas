'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot } = require('../helpers/db');
const { fakeEmbedding } = require('../helpers/openai-stub');

let pool;
let search;
let botA;
let botB;

async function seedCatalog(botId, rawProducts, info = []) {
  const { normalizeProduct, productHash, infoHash } = require('../../catalog/normalize');
  const { productEmbeddingText, infoEmbeddingText, toVectorLiteral } = require('../../catalog/embed');
  const { rows: [source] } = await pool.query(
    `INSERT INTO catalog_sources (bot_id, kind, name, status) VALUES ($1, 'spreadsheet', 'c.csv', 'ready') RETURNING id`,
    [botId],
  );
  for (const raw of rawProducts) {
    const p = normalizeProduct(raw);
    await pool.query(
      `INSERT INTO catalog_products
         (bot_id, source_id, external_key, name, category, description, price, currency, in_stock,
          url, image_url, attributes, content_hash, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::vector)`,
      [botId, source.id, p.external_key, p.name, p.category, p.description, p.price, p.currency,
       p.in_stock, p.url, p.image_url, JSON.stringify(p.attributes), productHash(p),
       toVectorLiteral(fakeEmbedding(productEmbeddingText(p)))],
    );
  }
  for (const item of info) {
    await pool.query(
      `INSERT INTO catalog_info (bot_id, source_id, title, content, content_hash, embedding)
       VALUES ($1,$2,$3,$4,$5,$6::vector)`,
      [botId, source.id, item.title, item.content, infoHash(item),
       toVectorLiteral(fakeEmbedding(infoEmbeddingText(item)))],
    );
  }
}

const find = (botId, filters) =>
  search.searchProducts(botId, filters, fakeEmbedding(filters.query));

test.before(async () => {
  ({ pool } = await setupTestDb());
  search = require('../../catalog/search');
  ({ botId: botA } = await seedBot(pool));
  ({ botId: botB } = await seedBot(pool));

  await seedCatalog(botA, [
    { name: 'Waterproof Rain Jacket', category: 'Jackets', price: '2999', in_stock: 'yes', sku: 'JK-1' },
    { name: 'Winter Down Jacket', category: 'Jackets', price: '5499', in_stock: 'yes' },
    { name: 'Cotton T-Shirt', category: 'Tops', price: '499', in_stock: 'no' },
    { name: 'Leather Wallet', category: 'Accessories', price: '1200' },
  ], Array.from({ length: 6 }, (_, i) => ({ title: `Shipping ${i}`, content: `Shipping option ${i} details` })));

  await seedCatalog(botB, [
    { name: 'Waterproof Rain Jacket', category: 'Jackets', price: '100', in_stock: 'yes' },
  ]);
});

test('ranks the semantically closest product first', async () => {
  const results = await find(botA, { query: 'waterproof jacket' });
  assert.equal(results[0].name, 'Waterproof Rain Jacket');
  assert.equal(results[0].price, 2999);
  assert.equal(typeof results[0].similarity, 'number');
  assert.deepEqual(Object.keys(results[0]).sort(), [
    'category', 'currency', 'description', 'id', 'image_url', 'in_stock', 'name', 'price', 'score', 'similarity', 'url',
  ]);
});

test("never returns another bot's products", async () => {
  const resultsA = await find(botA, { query: 'waterproof rain jacket' });
  assert.ok(resultsA.every((p) => p.price !== 100));
  const resultsB = await find(botB, { query: 'waterproof rain jacket' });
  assert.deepEqual(resultsB.map((p) => p.price), [100]);
});

test('applies max_price', async () => {
  const names = (await find(botA, { query: 'jacket', max_price: 3000 })).map((p) => p.name);
  assert.ok(names.includes('Waterproof Rain Jacket'));
  assert.ok(!names.includes('Winter Down Jacket'));
});

test('applies min_price', async () => {
  const names = (await find(botA, { query: 'jacket', min_price: 3000 })).map((p) => p.name);
  assert.deepEqual(names, ['Winter Down Jacket']);
});

test('applies in_stock', async () => {
  const names = (await find(botA, { query: 't-shirt', in_stock: true })).map((p) => p.name);
  assert.ok(!names.includes('Cotton T-Shirt'));
});

test('applies category with ILIKE', async () => {
  const results = await find(botA, { query: 'jacket', category: 'jack' });
  assert.ok(results.length > 0);
  assert.ok(results.every((p) => p.category === 'Jackets'));
});

test('sorts by price ascending and descending', async () => {
  const asc = (await find(botA, { query: 'jacket', sort: 'price_asc' })).map((p) => p.price);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const desc = (await find(botA, { query: 'jacket', sort: 'price_desc' })).map((p) => p.price);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
});

test('drops unrelated rows below the threshold', async () => {
  assert.deepEqual(await find(botA, { query: 'garden hose' }), []);
});

test('keeps an exact SKU keyword hit', async () => {
  const names = (await find(botA, { query: 'JK-1' })).map((p) => p.name);
  assert.ok(names.includes('Waterproof Rain Jacket'));
});

test('sanitizes model-supplied filter types', () => {
  assert.deepEqual(
    search.sanitizeFilters({ query: ' jacket ', max_price: '3000', in_stock: 'yes', sort: 'cheapest', min_price: -5 }),
    { query: 'jacket', min_price: null, max_price: 3000, category: null, in_stock: true, sort: 'relevance' },
  );
  assert.deepEqual(
    search.sanitizeFilters({ query: 42, max_price: 'abc', in_stock: 'maybe', category: '  ', sort: 'price_desc' }),
    { query: '42', min_price: null, max_price: null, category: null, in_stock: null, sort: 'price_desc' },
  );
  assert.equal(search.sanitizeFilters({ query: 'x'.repeat(500) }).query.length, 200);
  assert.equal(search.sanitizeFilters({ query: 'x', in_stock: 'false' }).in_stock, false);
});

test('tolerates unsanitized filters without SQL errors', async () => {
  const results = await search.searchProducts(
    botA,
    { query: 'jacket', max_price: '3000', in_stock: 'yes', sort: 'cheapest; DROP TABLE bots' },
    fakeEmbedding('jacket'),
  );
  assert.ok(results.every((p) => p.price <= 3000));
});

test('searchInfo returns at most 4 chunks for this bot', async () => {
  const results = await search.searchInfo(botA, 'shipping', fakeEmbedding('shipping'));
  assert.ok(results.length > 0 && results.length <= 4);
  assert.deepEqual(Object.keys(results[0]).sort(), ['content', 'id', 'score', 'similarity', 'title', 'url']);
  assert.deepEqual(await search.searchInfo(botB, 'shipping', fakeEmbedding('shipping')), []);
});

test('in_stock accepts common spellings from the model', () => {
  for (const v of ['Yes', 'TRUE', 'true', 1, '1', true]) assert.equal(search.sanitizeFilters({ query: 'x', in_stock: v }).in_stock, true, String(v));
  for (const v of ['No', 'FALSE', 0, '0', false]) assert.equal(search.sanitizeFilters({ query: 'x', in_stock: v }).in_stock, false, String(v));
  assert.equal(search.sanitizeFilters({ query: 'x', in_stock: 'maybe' }).in_stock, null);
});
