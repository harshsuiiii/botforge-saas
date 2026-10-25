'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { installOpenAIStub } = require('../helpers/openai-stub');
const { splitIntoWindows, extractCatalog, WINDOW_CHARS } = require('../../catalog/extract');

const EMPTY_PRODUCT = {
  name: null, category: null, description: null, price: null, currency: null,
  in_stock: null, sku: null, url: null, image_url: null, attributes: [],
};
const product = (fields) => ({ ...EMPTY_PRODUCT, ...fields });
const extraction = (products = [], info = []) => ({
  json: { choices: [{ message: { content: JSON.stringify({ products, info }) } }] },
});

let stub;
test.beforeEach(() => { stub = installOpenAIStub(); });
test.afterEach(() => stub.restore());

const twoWindows = `${'a'.repeat(7000)}\n\n${'b'.repeat(7000)}`;
const rawReply = (message) => ({ json: { choices: [{ message, finish_reason: 'stop' }] } });

test('skips a window whose JSON is broken and keeps the rest', async () => {
  stub.queueChat(rawReply({ content: '{"products": [{"name": "Cut off' }));
  stub.queueChat(extraction([product({ name: 'Rain Jacket' })]));
  const { products } = await extractCatalog('sk-test', [{ url: null, text: twoWindows }]);
  assert.deepEqual(products.map((p) => p.name), ['Rain Jacket']);
});

test('skips a window the model refused', async () => {
  stub.queueChat(rawReply({ content: null, refusal: 'I cannot help with that.' }));
  stub.queueChat(extraction([product({ name: 'Cap' })]));
  const { products } = await extractCatalog('sk-test', [{ url: null, text: twoWindows }]);
  assert.deepEqual(products.map((p) => p.name), ['Cap']);
});

test('fails with a clear message when every window fails', async () => {
  stub.queueChat(rawReply({ content: 'not json' }));
  stub.queueChat(rawReply({ content: null, refusal: 'no' }));
  await assert.rejects(
    extractCatalog('sk-test', [{ url: null, text: twoWindows }]),
    /Could not read any products or information/,
  );
});

test('still fails on OpenAI errors such as a bad key', async () => {
  stub.queueChat({ status: 401, json: { error: { message: 'bad key' } } });
  await assert.rejects(extractCatalog('sk-test', [{ url: null, text: 'Cap' }]), (err) => err.status === 401);
});

test('resolves relative product and image URLs against the page', async () => {
  stub.queueChat(extraction([product({ name: 'Cap', url: '/p/1', image_url: 'img/cap.jpg' })]));
  const { products } = await extractCatalog('sk-test', [{ url: 'https://shop.test/cat/', text: 'Cap' }]);
  assert.equal(products[0].url, 'https://shop.test/p/1');
  assert.equal(products[0].image_url, 'https://shop.test/cat/img/cap.jpg');
});

test('sends the OpenAI-Project header when given', async () => {
  stub.queueChat(extraction());
  await extractCatalog('sk-test', [{ url: null, text: 'Cap' }], { projectId: 'proj_123' });
  assert.equal(stub.requests[0].headers['OpenAI-Project'], 'proj_123');
});

test('splits on paragraph boundaries', () => {
  const para = (c) => c.repeat(5000);
  const windows = splitIntoWindows([para('a'), para('b'), para('c')].join('\n\n'), 12000);
  assert.equal(WINDOW_CHARS, 12000);
  assert.equal(windows.length, 2);
  assert.ok(windows.every((w) => w.length <= 12000));
  assert.ok(windows[0].startsWith('a') && windows[0].includes('b'));
  assert.ok(windows[1].startsWith('c'));
});

test('hard-splits an oversized paragraph', () => {
  const windows = splitIntoWindows('x'.repeat(30000), 12000);
  assert.ok(windows.length >= 3);
  assert.ok(windows.every((w) => w.length <= 12000));
  assert.equal(windows.join('').length, 30000);
});

test('returns no windows for blank text', () => {
  assert.deepEqual(splitIntoWindows('  \n\n  '), []);
});

test('sends gpt-4o-mini with a strict JSON schema at temperature 0', async () => {
  stub.queueChat(extraction());
  await extractCatalog('sk-test', [{ url: null, text: 'Rain Jacket Rs 2999' }]);

  const [req] = stub.requests;
  assert.equal(req.path, '/v1/chat/completions');
  assert.equal(req.body.model, 'gpt-4o-mini');
  assert.equal(req.body.temperature, 0);
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.equal(req.body.response_format.json_schema.strict, true);
  assert.equal(req.body.response_format.json_schema.name, 'catalog_extraction');
  assert.ok(req.body.messages.some((m) => m.role === 'user' && m.content.includes('Rain Jacket Rs 2999')));
});

test('merges products across windows and keeps page URLs', async () => {
  const text = `${'a'.repeat(7000)}\n\n${'b'.repeat(7000)}`;
  stub.queueChat(extraction([product({ name: 'Rain Jacket', price: 2999, attributes: [{ name: 'colour', value: 'Blue' }] })]));
  stub.queueChat(extraction([product({ name: 'Rain Jacket', image_url: 'https://shop.test/jk.jpg' })]));

  const { products } = await extractCatalog('sk-test', [{ url: 'https://shop.test/p', text }]);

  assert.equal(stub.requests.length, 2);
  assert.equal(products.length, 1);
  assert.equal(products[0].price, 2999);
  assert.equal(products[0].image_url, 'https://shop.test/jk.jpg');
  assert.equal(products[0].url, 'https://shop.test/p');
  assert.deepEqual(products[0].attributes, { colour: 'Blue' });
});

test('keeps a product URL the model found', async () => {
  stub.queueChat(extraction([product({ name: 'Cap', url: 'https://shop.test/cap' })]));
  const { products } = await extractCatalog('sk-test', [{ url: 'https://shop.test/', text: 'Cap' }]);
  assert.equal(products[0].url, 'https://shop.test/cap');
});

test('collects info with the page URL and drops empty items', async () => {
  stub.queueChat(extraction([product({ name: '  ' })], [
    { title: 'Returns', content: '7 days' },
    { title: '', content: 'orphan' },
  ]));
  const { products, info } = await extractCatalog('sk-test', [{ url: 'https://shop.test/policy', text: 'Returns 7 days' }]);
  assert.equal(products.length, 0);
  assert.deepEqual(info, [{ title: 'Returns', content: '7 days', url: 'https://shop.test/policy' }]);
});
