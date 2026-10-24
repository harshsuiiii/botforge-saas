'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot } = require('../helpers/db');
const { installOpenAIStub, sse } = require('../helpers/openai-stub');
const { seedCatalog } = require('../helpers/catalog');
const { startApp } = require('../helpers/http');

const FALLBACK = 'Sorry, that is not in our catalog. Call 98xxxx.';
const CARD_KEYS = ['currency', 'id', 'image_url', 'in_stock', 'name', 'price', 'url'];

let pool;
let app;
let stub;

const CATALOG = [
  { name: 'Waterproof Rain Jacket', category: 'Jackets', price: '2999', in_stock: 'yes',
    url: 'https://shop.test/jacket', image_url: 'https://shop.test/jacket.jpg', description: 'd'.repeat(1000) },
  { name: 'Winter Down Jacket', category: 'Jackets', price: '5499', in_stock: 'yes' },
  { name: 'Cotton T-Shirt', category: 'Tops', price: '499', in_stock: 'no' },
];

async function seedCatalogBot({ answer_mode = 'flexible', status = 'ready' } = {}) {
  const bot = await seedBot(pool, { botFields: { answer_mode, fallback_message: FALLBACK } });
  const { products } = await seedCatalog(pool, bot.botId, CATALOG, { status });
  return { ...bot, products };
}

/** POST /chat and parse the SSE body into events (objects, or the string '[DONE]'). */
async function chat(embedKey, message) {
  const res = await fetch(`${app.base}/chat`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ embed_key: embedKey, message }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  return body.split('\n\n').filter(Boolean).map((frame) => {
    const data = frame.replace(/^data: /, '');
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

const deltas = (events) => events.filter((e) => e.delta).map((e) => e.delta).join('');
const chatRequests = () => stub.requests.filter((r) => r.path === '/v1/chat/completions');

async function waitFor(fn, label) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const unansweredFor = (botId) => waitFor(async () => {
  const { rows } = await pool.query('SELECT * FROM unanswered_questions WHERE bot_id = $1', [botId]);
  return rows.length ? rows : null;
}, 'unanswered row');

test.before(async () => {
  ({ pool } = await setupTestDb());
  stub = installOpenAIStub();
  app = await startApp([['/chat', require('../../chat/chat')]]);
});

test.after(async () => {
  await app.close();
  stub.restore();
});

test.beforeEach(() => { stub.requests.length = 0; stub.failEmbeddings(false); });

test('streams text, runs the tool, then sends product cards', async () => {
  const { embedKey, botId, products } = await seedCatalogBot();
  stub.queueChat({
    sse: [
      ...sse.text('Let me check. '),
      ...sse.toolCall(0, 'call_1', 'search_products', '{"query":"waterproof jacket","max_price":3000}', 4),
    ],
  });
  stub.queueChat({ sse: [...sse.text('We have the Waterproof Rain Jacket for ₹2,999.', 3), sse.finish()] });

  const events = await chat(embedKey, 'Any waterproof jacket under 3000?');

  assert.ok(events[0].session_id);
  assert.equal(deltas(events), 'Let me check. We have the Waterproof Rain Jacket for ₹2,999.');
  const productEvents = events.filter((e) => e.products);
  assert.equal(productEvents.length, 1);
  const cards = productEvents[0].products;
  assert.ok(cards.length >= 1 && cards.length <= 4);
  assert.deepEqual(Object.keys(cards[0]).sort(), CARD_KEYS);
  assert.equal(cards[0].name, 'Waterproof Rain Jacket');
  assert.equal(cards[0].price, 2999);
  assert.ok(!cards.some((c) => c.name === 'Winter Down Jacket'));
  assert.equal(events.at(-1), '[DONE]');

  const [first, second] = chatRequests();
  assert.equal(first.body.temperature, 0.3);
  assert.equal(first.body.tool_choice, 'auto');
  assert.ok(first.body.messages[0].content.includes('Prices and stock in tool results are authoritative.'));
  const assistant = second.body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"query":"waterproof jacket","max_price":3000}');
  const toolMessage = second.body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');

  const jacket = products.find((p) => p.name === 'Waterproof Rain Jacket');
  const session = await waitFor(async () => {
    const { rows } = await pool.query('SELECT messages FROM sessions WHERE bot_id = $1', [botId]);
    return rows[0];
  }, 'session');
  const saved = session.messages.find((m) => m.role === 'assistant');
  assert.equal(saved.content, 'Let me check. We have the Waterproof Rain Jacket for ₹2,999.');
  assert.ok(saved.product_ids.includes(jacket.id));
});

test('truncates descriptions in tool results to 300 chars', async () => {
  const { embedKey } = await seedCatalogBot();
  stub.queueChat({ sse: sse.toolCall(0, 'call_1', 'search_products', '{"query":"waterproof rain jacket"}') });
  stub.queueChat({ sse: [...sse.text('Here it is.'), sse.finish()] });

  await chat(embedKey, 'rain jacket?');

  const toolMessage = chatRequests()[1].body.messages.find((m) => m.role === 'tool');
  const { results } = JSON.parse(toolMessage.content);
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => (r.description ?? '').length <= 300));
  assert.deepEqual(
    Object.keys(results[0]).sort(),
    ['category', 'currency', 'description', 'id', 'in_stock', 'name', 'price', 'url'],
  );
});

test('sends no tools when the bot has no ready catalog', async () => {
  const { embedKey } = await seedCatalogBot({ status: 'failed' });
  stub.queueChat({ sse: [...sse.text('Hello!'), sse.finish()] });

  const events = await chat(embedKey, 'hi');

  const [req] = chatRequests();
  assert.ok(!('tools' in req.body));
  assert.ok(!('temperature' in req.body));
  assert.ok(!events.some((e) => e.products));
  assert.equal(deltas(events), 'Hello!');
});

test('strict mode with no results logs no_results', async () => {
  const { embedKey, botId } = await seedCatalogBot({ answer_mode: 'strict' });
  stub.queueChat({ sse: sse.toolCall(0, 'call_1', 'search_products', '{"query":"garden hose"}') });
  stub.queueChat({ sse: [...sse.text(FALLBACK), sse.finish()] });

  const events = await chat(embedKey, 'Do you sell a garden hose?');

  assert.ok(chatRequests()[0].body.messages[0].content.includes(`reply exactly with: ${FALLBACK}`));
  assert.ok(!events.some((e) => e.products));
  const [row] = await unansweredFor(botId);
  assert.equal(row.reason, 'no_results');
  assert.equal(row.question, 'Do you sell a garden hose?');
});

test('strict fallback without a search logs fallback', async () => {
  const { embedKey, botId } = await seedCatalogBot({ answer_mode: 'strict' });
  stub.queueChat({ sse: [...sse.text(FALLBACK), sse.finish()] });

  await chat(embedKey, 'What is the meaning of life?');

  const [row] = await unansweredFor(botId);
  assert.equal(row.reason, 'fallback');
});

test('caps tool rounds at two', async () => {
  const { embedKey } = await seedCatalogBot();
  stub.queueChat({ sse: sse.toolCall(0, 'call_1', 'search_products', '{"query":"jacket"}') });
  stub.queueChat({ sse: sse.toolCall(0, 'call_2', 'search_products', '{"query":"winter jacket"}') });
  stub.queueChat({ sse: [...sse.text('Done.'), sse.finish()] });

  const events = await chat(embedKey, 'jackets?');

  const reqs = chatRequests();
  assert.equal(reqs.length, 3);
  assert.equal(reqs[1].body.tool_choice, 'auto');
  assert.equal(reqs[2].body.tool_choice, 'none');
  assert.equal(events.at(-1), '[DONE]');
});

test('a failing search returns search unavailable', async () => {
  const { embedKey } = await seedCatalogBot();
  stub.failEmbeddings(true);
  stub.queueChat({ sse: sse.toolCall(0, 'call_1', 'search_products', '{"query":"jacket"}') });
  stub.queueChat({ sse: [...sse.text('Sorry, search is down.'), sse.finish()] });

  const events = await chat(embedKey, 'jackets?');

  const toolMessage = chatRequests()[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMessage.content, '{"error":"search unavailable"}');
  assert.equal(events.at(-1), '[DONE]');
});

test('an OpenAI failure after streaming starts ends the stream cleanly', async () => {
  const { embedKey } = await seedCatalogBot();
  stub.queueChat({ sse: sse.toolCall(0, 'call_1', 'search_products', '{"query":"jacket"}') });
  stub.queueChat({ status: 500, json: { error: { message: 'boom' } } });

  const events = await chat(embedKey, 'jackets?');

  assert.ok(deltas(events).includes('Sorry, something went wrong.'));
  assert.equal(events.at(-1), '[DONE]');
});
