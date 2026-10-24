'use strict';

/**
 * tools.js
 * ────────
 * BotForge – catalog search tools offered to the chat model, the prompt
 * section that governs them, and the dispatcher that runs tool calls.
 */

const { embedTexts } = require('./embed');
const { searchProducts, searchInfo, sanitizeFilters } = require('./search');

const DEFAULT_FALLBACK_MESSAGE =
  "I'm sorry, I couldn't find that in our catalog. Please contact us for help.";

const DESCRIPTION_LIMIT = 300;
const INFO_CONTENT_LIMIT = 800;

const TOOL_DEFINITIONS = [
  {
    type    : 'function',
    function: {
      name       : 'search_products',
      description: "Search this business's product catalog. Use it for any question about products, prices or stock.",
      parameters : {
        type      : 'object',
        properties: {
          query    : { type: 'string', description: 'What the customer is looking for, in a few words.' },
          min_price: { type: 'number', description: 'Minimum price, if the customer gave one.' },
          max_price: { type: 'number', description: 'Maximum price, if the customer gave one.' },
          category : { type: 'string', description: 'Product category, if the customer named one.' },
          in_stock : { type: 'boolean', description: 'True to return only products that are in stock.' },
          sort     : {
            type       : 'string',
            enum       : ['relevance', 'price_asc', 'price_desc'],
            description: 'Result order; use price_asc for "cheapest".',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type    : 'function',
    function: {
      name       : 'search_info',
      description: "Search this business's policies and details (shipping, returns, payment, contact, opening hours, FAQs).",
      parameters : {
        type      : 'object',
        properties: {
          query: { type: 'string', description: 'The topic to look up, in a few words.' },
        },
        required: ['query'],
      },
    },
  },
];

/**
 * Catalog section appended to the bot's system prompt at request time.
 * Copy is fixed by the design spec (§5.2).
 */
function buildCatalogPrompt({ answer_mode, fallback_message }) {
  const fallback = fallback_message || DEFAULT_FALLBACK_MESSAGE;
  const modeRules = answer_mode === 'strict'
    ? 'Answer only using results returned by `search_products` and `search_info`. ' +
      'Always search before answering a question about the business. ' +
      `If the results contain nothing relevant, reply exactly with: ${fallback}`
    : 'Use `search_products` for anything about products, prices or stock, and `search_info` for policies or business details. ' +
      'Never state a product, price or stock level that a tool did not return. ' +
      'You may answer general questions from your own knowledge.';

  return `${modeRules}\n` +
    'Prices and stock in tool results are authoritative. ' +
    'Do not list more than 4 products; the user will see product cards for the products you were given.';
}

function truncate(text, limit) {
  if (!text) return text ?? null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const INVALID = () => ({
  content    : JSON.stringify({ error: 'invalid arguments' }),
  cards      : [],
  searched   : false,
  resultCount: 0,
});

/** ProductCard = { id, name, price, currency, in_stock, url, image_url } */
function toCard(row) {
  return {
    id       : row.id,
    name     : row.name,
    price    : row.price,
    currency : row.currency,
    in_stock : row.in_stock,
    url      : row.url,
    image_url: row.image_url,
  };
}

/**
 * Run one model-requested tool call.
 *
 * @param {string} botId
 * @param {string} token – owner's OpenAI key (for the query embedding)
 * @param {{ name: string, arguments: string }} call
 * @returns {Promise<{ content: string, cards: object[], searched: boolean, resultCount: number }>}
 */
async function runToolCall(botId, token, { name, arguments: argsJson }) {
  let args;
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return INVALID();
  }
  if (!args || typeof args !== 'object' || !['search_products', 'search_info'].includes(name)) {
    return INVALID();
  }

  const filters = sanitizeFilters(args);
  if (!filters.query) return INVALID();

  try {
    const [embedding] = await embedTexts(token, [filters.query]);

    if (name === 'search_products') {
      const rows = await searchProducts(botId, filters, embedding);
      const results = rows.map((r) => ({
        id         : r.id,
        name       : r.name,
        category   : r.category,
        price      : r.price,
        currency   : r.currency,
        in_stock   : r.in_stock,
        description: truncate(r.description, DESCRIPTION_LIMIT),
        url        : r.url,
      }));
      return {
        content    : JSON.stringify({ results }),
        cards      : rows.map(toCard),
        searched   : true,
        resultCount: rows.length,
      };
    }

    const rows = await searchInfo(botId, filters.query, embedding);
    const results = rows.map((r) => ({
      title  : r.title,
      content: truncate(r.content, INFO_CONTENT_LIMIT),
      url    : r.url,
    }));
    return { content: JSON.stringify({ results }), cards: [], searched: true, resultCount: rows.length };
  } catch (err) {
    console.error(`[tools] ${name} failed:`, err.message);
    return {
      content    : JSON.stringify({ error: 'search unavailable' }),
      cards      : [],
      searched   : true,
      resultCount: 0,
    };
  }
}

module.exports = {
  DEFAULT_FALLBACK_MESSAGE,
  TOOL_DEFINITIONS,
  buildCatalogPrompt,
  runToolCall,
};
