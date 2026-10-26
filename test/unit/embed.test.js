'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { installOpenAIStub, fakeEmbedding } = require('../helpers/openai-stub');
const {
  embedTexts, toVectorLiteral, productEmbeddingText, infoEmbeddingText, EMBEDDING_MODEL,
} = require('../../catalog/embed');
const { openaiJson } = require('../../catalog/openai-client');

let stub;
test.beforeEach(() => { stub = installOpenAIStub(); });
test.afterEach(() => stub.restore());

test('batches 250 texts into 100/100/50 and keeps order', async () => {
  const texts = Array.from({ length: 250 }, (_, i) => `product number ${i}`);
  const vectors = await embedTexts('sk-test', texts);

  const embedCalls = stub.requests.filter((r) => r.path === '/v1/embeddings');
  assert.deepEqual(embedCalls.map((r) => r.body.input.length), [100, 100, 50]);
  assert.ok(embedCalls.every((r) => r.body.model === EMBEDDING_MODEL));
  assert.equal(EMBEDDING_MODEL, 'text-embedding-3-small');
  assert.equal(vectors.length, 250);
  assert.deepEqual(vectors[0], fakeEmbedding(texts[0]));
  assert.deepEqual(vectors[249], fakeEmbedding(texts[249]));
});

test('sends the OpenAI-Project header when given', async () => {
  await embedTexts('sk-test', ['a'], { projectId: 'proj_123' });
  assert.equal(stub.requests[0].headers['OpenAI-Project'], 'proj_123');
  await embedTexts('sk-test', ['b']);
  assert.equal(stub.requests[1].headers['OpenAI-Project'], undefined);
});

test('no request for an empty list', async () => {
  assert.deepEqual(await embedTexts('sk-test', []), []);
  assert.equal(stub.requests.length, 0);
});

test('formats a vector literal', () => {
  assert.equal(toVectorLiteral([1, 0.5, -0.25]), '[1,0.5,-0.25]');
});

test('builds product embedding text', () => {
  const text = productEmbeddingText({
    external_key: 'jk-1', name: 'Rain Jacket', category: 'Jackets', description: null,
    price: 2999, currency: 'INR', in_stock: true, url: null, image_url: null,
    attributes: { colour: 'Blue', size: 'M' },
  });
  assert.equal(text, 'Rain Jacket · Jackets · colour: Blue; size: M · 2999 INR');
  assert.ok(!text.includes('null'));
});

test('builds info embedding text', () => {
  assert.equal(infoEmbeddingText({ title: 'Returns', content: '7 days' }), 'Returns\n7 days');
});

test('throws with status on API errors', async () => {
  stub.queueChat({ status: 401, json: { error: { message: 'bad key' } } });
  await assert.rejects(
    openaiJson('sk-test', '/chat/completions', { model: 'x', messages: [] }),
    (err) => err.status === 401 && err.openai.error.message === 'bad key',
  );
});
