'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCatalogPrompt, TOOL_DEFINITIONS, DEFAULT_FALLBACK_MESSAGE, runToolCall,
} = require('../../catalog/tools');

test('default fallback text is exact', () => {
  assert.equal(DEFAULT_FALLBACK_MESSAGE, "I'm sorry, I couldn't find that in our catalog. Please contact us for help.");
});

test('strict prompt uses the fallback message verbatim', () => {
  const prompt = buildCatalogPrompt({ answer_mode: 'strict', fallback_message: 'Call us on 98xxxx' });
  assert.ok(prompt.includes('Answer only using results returned by `search_products` and `search_info`.'));
  assert.ok(prompt.includes('Always search before answering a question about the business.'));
  assert.ok(prompt.includes('If the results contain nothing relevant, reply exactly with: Call us on 98xxxx'));
  assert.ok(!prompt.includes('general questions from your own knowledge'));
});

test('strict prompt falls back to the default text', () => {
  const prompt = buildCatalogPrompt({ answer_mode: 'strict', fallback_message: null });
  assert.ok(prompt.includes(`reply exactly with: ${DEFAULT_FALLBACK_MESSAGE}`));
});

test('flexible prompt allows general knowledge', () => {
  const prompt = buildCatalogPrompt({ answer_mode: 'flexible', fallback_message: null });
  assert.ok(prompt.includes(
    'Use `search_products` for anything about products, prices or stock, and `search_info` for policies or business details.',
  ));
  assert.ok(prompt.includes('Never state a product, price or stock level that a tool did not return.'));
  assert.ok(prompt.includes('You may answer general questions from your own knowledge.'));
  assert.ok(!prompt.includes('reply exactly with'));
});

test('both prompts state prices are authoritative', () => {
  for (const answer_mode of ['strict', 'flexible']) {
    const prompt = buildCatalogPrompt({ answer_mode, fallback_message: null });
    assert.ok(prompt.includes('Prices and stock in tool results are authoritative.'));
    assert.ok(prompt.includes('Do not list more than 4 products; the user will see product cards for the products you were given.'));
  }
});

test('defines search_products and search_info', () => {
  const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.function.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['search_info', 'search_products']);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');
    assert.deepEqual(tool.function.parameters.required, ['query']);
  }
  assert.deepEqual(
    Object.keys(byName.search_products.function.parameters.properties).sort(),
    ['category', 'in_stock', 'max_price', 'min_price', 'query', 'sort'],
  );
  assert.deepEqual(byName.search_products.function.parameters.properties.sort.enum, ['relevance', 'price_asc', 'price_desc']);
});

test('invalid tool arguments are reported, not thrown', async () => {
  for (const call of [
    { name: 'search_products', arguments: '{"query": "jack' },
    { name: 'search_products', arguments: '{}' },
    { name: 'delete_everything', arguments: '{"query":"x"}' },
  ]) {
    const out = await runToolCall('00000000-0000-0000-0000-000000000000', 'sk-test', call);
    assert.deepEqual(JSON.parse(out.content), { error: 'invalid arguments' });
    assert.equal(out.searched, false);
    assert.deepEqual(out.cards, []);
  }
});
