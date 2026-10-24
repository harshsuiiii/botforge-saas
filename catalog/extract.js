'use strict';

/**
 * extract.js
 * ──────────
 * BotForge – LLM extraction of products and info from unstructured text
 * (PDF catalogs and crawled web pages).
 */

const { openaiJson } = require('./openai-client');
const { normalizeProduct, dedupeProducts } = require('./normalize');

const WINDOW_CHARS     = 12000;   // ≈ 3,000 tokens
const EXTRACTION_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = [
  'You extract product catalog data from a business document or web page.',
  'Extract only what is explicitly stated in the text. Never guess or invent prices, stock levels, SKUs or URLs.',
  'Use null for any field that is not stated.',
  'Put other information useful to customers (shipping, returns, payment, contact details, opening hours, FAQs, about the business) into "info" as short self-contained items.',
].join(' ');

const nullable = (type) => ({ type: [type, 'null'] });

// Strict structured outputs require every property listed in `required` and
// no free-form objects, so attributes come back as name/value pairs.
const EXTRACTION_SCHEMA = {
  type                : 'object',
  additionalProperties: false,
  required            : ['products', 'info'],
  properties          : {
    products: {
      type : 'array',
      items: {
        type                : 'object',
        additionalProperties: false,
        required            : ['name', 'category', 'description', 'price', 'currency',
                               'in_stock', 'sku', 'url', 'image_url', 'attributes'],
        properties: {
          name       : nullable('string'),
          category   : nullable('string'),
          description: nullable('string'),
          price      : nullable('number'),
          currency   : nullable('string'),
          in_stock   : nullable('boolean'),
          sku        : nullable('string'),
          url        : nullable('string'),
          image_url  : nullable('string'),
          attributes : {
            type : 'array',
            items: {
              type                : 'object',
              additionalProperties: false,
              required            : ['name', 'value'],
              properties          : { name: { type: 'string' }, value: { type: 'string' } },
            },
          },
        },
      },
    },
    info: {
      type : 'array',
      items: {
        type                : 'object',
        additionalProperties: false,
        required            : ['title', 'content'],
        properties          : { title: { type: 'string' }, content: { type: 'string' } },
      },
    },
  },
};

/**
 * Pack paragraphs greedily into windows of at most maxChars; a paragraph
 * longer than maxChars is hard-split.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitIntoWindows(text, maxChars = WINDOW_CHARS) {
  const paragraphs = String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const windows = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      if (current) { windows.push(current); current = ''; }
      for (let i = 0; i < para.length; i += maxChars) windows.push(para.slice(i, i + maxChars));
      continue;
    }
    if (current && current.length + 2 + para.length > maxChars) {
      windows.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) windows.push(current);
  return windows;
}

function pairsToObject(pairs) {
  const out = {};
  for (const pair of pairs ?? []) {
    if (pair?.name) out[pair.name] = pair.value;
  }
  return out;
}

async function extractWindow(token, text) {
  const data = await openaiJson(token, '/chat/completions', {
    model          : EXTRACTION_MODEL,
    temperature    : 0,
    response_format: {
      type       : 'json_schema',
      json_schema: { name: 'catalog_extraction', strict: true, schema: EXTRACTION_SCHEMA },
    },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: text },
    ],
  });

  const content = data?.choices?.[0]?.message?.content ?? '{}';
  const parsed  = JSON.parse(content);
  return {
    products: Array.isArray(parsed.products) ? parsed.products : [],
    info    : Array.isArray(parsed.info) ? parsed.info : [],
  };
}

/**
 * @param {string} token
 * @param {Array<{ url: string|null, text: string }>} pages
 * @returns {Promise<{ products: object[], info: Array<{ title, content, url }> }>}
 */
async function extractCatalog(token, pages) {
  const products = [];
  const info = [];

  for (const page of pages) {
    for (const window of splitIntoWindows(page.text)) {
      const result = await extractWindow(token, window);

      for (const raw of result.products) {
        const product = normalizeProduct({
          ...raw,
          url       : raw.url ?? page.url,
          attributes: pairsToObject(raw.attributes),
        });
        if (product) products.push(product);
      }

      for (const item of result.info) {
        const title   = String(item.title ?? '').trim();
        const content = String(item.content ?? '').trim();
        if (title && content) info.push({ title, content, url: page.url ?? null });
      }
    }
  }

  return { products: dedupeProducts(products), info };
}

module.exports = { WINDOW_CHARS, EXTRACTION_MODEL, splitIntoWindows, extractCatalog };
