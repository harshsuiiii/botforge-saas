'use strict';

/**
 * normalize.js
 * ────────────
 * BotForge – turn raw catalog records (spreadsheet rows, LLM extractions)
 * into a single Product shape, plus the hashes used for change detection.
 *
 * Product = {
 *   external_key, name, category, description,
 *   price: number|null, currency, in_stock: boolean|null,
 *   url, image_url, attributes: object
 * }
 */

const crypto = require('crypto');

const STOCK_TRUE  = new Set(['yes', 'y', 'true', 'in stock', 'instock', 'in-stock', 'available']);
const STOCK_FALSE = new Set(['no', 'n', 'false', 'out of stock', 'out-of-stock', 'sold out', 'soldout', 'unavailable']);

/** Trimmed string, or null when empty / missing. */
function cleanString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/**
 * Parse a price such as '₹1,29,999', 'Rs. 499.50', 'INR 2,999' or 12.
 * @returns {number | null}
 */
function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const s = cleanString(value);
  if (!s) return null;

  const stripped = s
    .replace(/₹|\brs\.?|\binr\b|\busd\b|\$|€|£/gi, '')
    .replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(stripped)) return null;
  return Number(stripped);
}

/**
 * Parse stock: numbers > 0 or yes/in stock → true; 0 or no/sold out → false.
 * @returns {boolean | null}
 */
function parseStock(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value > 0 : null;
  const s = cleanString(value)?.toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) > 0;
  if (STOCK_TRUE.has(s)) return true;
  if (STOCK_FALSE.has(s)) return false;
  return null;
}

function cleanAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return {};
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    const k = cleanString(key);
    const v = cleanString(value);
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * @param {object} raw – loosely shaped record
 * @returns {object | null} Product, or null when the record has no name
 */
function normalizeProduct(raw = {}) {
  const name = cleanString(raw.name);
  if (!name) return null;

  const sku = cleanString(raw.sku);

  return {
    external_key: sku ?? name.toLowerCase().replace(/\s+/g, ' '),
    name,
    category   : cleanString(raw.category),
    description: cleanString(raw.description),
    price      : parsePrice(raw.price),
    currency   : (cleanString(raw.currency) ?? 'INR').toUpperCase(),
    in_stock   : parseStock(raw.in_stock),
    url        : cleanString(raw.url),
    image_url  : cleanString(raw.image_url),
    attributes : cleanAttributes(raw.attributes),
  };
}

/** JSON with object keys sorted at every level, so field order never changes the hash. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** @returns {string} hex SHA-256 of the product's canonical JSON */
function productHash(product) {
  return sha256(canonicalJson(product));
}

/** @returns {string} hex SHA-256 of { title, content } */
function infoHash({ title, content }) {
  return sha256(canonicalJson({ title, content }));
}

/**
 * Merge products sharing an external_key (first-seen order; later non-null
 * fields win; attributes are shallow-merged).
 */
function dedupeProducts(list) {
  const byKey = new Map();
  for (const product of list) {
    const existing = byKey.get(product.external_key);
    if (!existing) {
      byKey.set(product.external_key, { ...product, attributes: { ...product.attributes } });
      continue;
    }
    for (const [field, value] of Object.entries(product)) {
      if (field === 'attributes') {
        existing.attributes = { ...existing.attributes, ...value };
      } else if (value !== null && value !== undefined) {
        existing[field] = value;
      }
    }
  }
  return [...byKey.values()];
}

module.exports = {
  parsePrice,
  parseStock,
  normalizeProduct,
  productHash,
  infoHash,
  dedupeProducts,
};
