'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePrice, parseStock, normalizeProduct, productHash, infoHash, dedupeProducts,
} = require('../../catalog/normalize');

test('parses rupee and lakh formats', () => {
  assert.equal(parsePrice('₹1,29,999'), 129999);
  assert.equal(parsePrice('Rs. 499.50'), 499.5);
  assert.equal(parsePrice('INR 2,999'), 2999);
  assert.equal(parsePrice('$12.00'), 12);
  assert.equal(parsePrice(349), 349);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('call us'), null);
  assert.equal(parsePrice(null), null);
});

test('parses "/-", unspaced and MRP-prefixed rupee prices', () => {
  assert.equal(parsePrice('₹1,299/-'), 1299);
  assert.equal(parsePrice('Rs.1,299/-'), 1299);
  assert.equal(parsePrice('INR2,999'), 2999);
  assert.equal(parsePrice('MRP ₹999'), 999);
  assert.equal(parsePrice('MRP: Rs 1,499'), 1499);
  assert.equal(parsePrice('2,999 INR'), 2999);
});

test('parses stock values', () => {
  assert.equal(parseStock('5'), true);
  assert.equal(parseStock(0), false);
  assert.equal(parseStock('0'), false);
  assert.equal(parseStock('In Stock'), true);
  assert.equal(parseStock('sold out'), false);
  assert.equal(parseStock('Out of stock'), false);
  assert.equal(parseStock('yes'), true);
  assert.equal(parseStock(true), true);
  assert.equal(parseStock('maybe'), null);
  assert.equal(parseStock(''), null);
});

test('external_key prefers sku', () => {
  assert.equal(normalizeProduct({ name: 'Rain  Jacket', sku: ' JK-1 ' }).external_key, 'JK-1');
  assert.equal(normalizeProduct({ name: 'Rain  Jacket' }).external_key, 'rain jacket');
});

test('drops rows without a name', () => {
  assert.equal(normalizeProduct({ price: '10' }), null);
  assert.equal(normalizeProduct({ name: '   ' }), null);
});

test('normalizes fields and defaults currency to INR', () => {
  const p = normalizeProduct({ name: ' Cap ', price: '₹199', in_stock: 'yes', category: '', currency: 'usd' });
  assert.deepEqual(p, {
    external_key: 'cap', name: 'Cap', category: null, description: null, price: 199,
    currency: 'USD', in_stock: true, url: null, image_url: null, attributes: {},
  });
  assert.equal(normalizeProduct({ name: 'Cap' }).currency, 'INR');
});

test('hash is stable and field-order independent', () => {
  const a = normalizeProduct({ name: 'Cap', price: '199', attributes: { colour: 'Red', size: 'M' } });
  const b = normalizeProduct({ attributes: { size: 'M', colour: 'Red' }, price: 199, name: 'Cap' });
  assert.equal(productHash(a), productHash(b));
  assert.notEqual(productHash(a), productHash({ ...a, price: 249 }));
  assert.equal(infoHash({ title: 'Returns', content: '7 days' }), infoHash({ content: '7 days', title: 'Returns' }));
});

test('dedupe merges same key, later non-null wins', () => {
  const merged = dedupeProducts([
    normalizeProduct({ name: 'Rain Jacket', price: 10, url: 'https://x.test/a', attributes: { colour: 'Blue' } }),
    normalizeProduct({ name: 'rain jacket', url: 'https://x.test/b', attributes: { size: 'M' } }),
    normalizeProduct({ name: 'Cap' }),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].price, 10);
  assert.equal(merged[0].url, 'https://x.test/b');
  assert.deepEqual(merged[0].attributes, { colour: 'Blue', size: 'M' });
  assert.equal(merged[1].name, 'Cap');
});
