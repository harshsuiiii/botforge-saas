'use strict';

/**
 * search.js
 * ─────────
 * BotForge – hybrid (vector + keyword) catalog search, always scoped to one bot.
 */

const pool = require('../auth/db');
const { toVectorLiteral } = require('./embed');

// Starting values; tune against real catalogs.
const MIN_SIMILARITY      = 0.25;
const VECTOR_WEIGHT       = 0.7;
const KEYWORD_WEIGHT      = 0.3;
const MAX_PRODUCT_RESULTS = 8;
const MAX_INFO_RESULTS    = 4;

/** ORDER BY clauses are chosen from this map only — never built from input. */
const ORDER_BY = {
  relevance : 'score DESC',
  price_asc : 'price ASC NULLS LAST, score DESC',
  price_desc: 'price DESC NULLS LAST, score DESC',
};

function toPrice(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toBool(value) {
  if (value === true || value === 'true' || value === 'yes') return true;
  if (value === false || value === 'false' || value === 'no') return false;
  return null;
}

/**
 * Coerce model-supplied tool arguments into safe, typed filters.
 * @returns {{ query: string, min_price: number|null, max_price: number|null,
 *             category: string|null, in_stock: boolean|null,
 *             sort: 'relevance'|'price_asc'|'price_desc' }}
 */
function sanitizeFilters(raw = {}) {
  const category = String(raw.category ?? '').trim().slice(0, 100);
  return {
    query    : String(raw.query ?? '').trim().slice(0, 200),
    min_price: toPrice(raw.min_price),
    max_price: toPrice(raw.max_price),
    category : category || null,
    in_stock : toBool(raw.in_stock),
    sort     : Object.hasOwn(ORDER_BY, raw.sort) ? raw.sort : 'relevance',
  };
}

const numberOrNull = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * @param {string}   botId
 * @param {object}   filters – raw or sanitized (sanitized again here)
 * @param {number[]} queryEmbedding
 */
async function searchProducts(botId, filters, queryEmbedding) {
  const f = sanitizeFilters(filters);

  const { rows } = await pool.query(
    `WITH scored AS (
       SELECT p.id, p.name, p.category, p.description, p.price, p.currency, p.in_stock,
              p.url, p.image_url,
              1 - (p.embedding <=> $2::vector)                       AS similarity,
              ts_rank(p.search_tsv, plainto_tsquery('simple', $3))   AS keyword_rank,
              p.search_tsv @@ plainto_tsquery('simple', $3)          AS keyword_hit
       FROM catalog_products p
       WHERE p.bot_id = $1
         AND ($4::numeric IS NULL OR p.price >= $4::numeric)
         AND ($5::numeric IS NULL OR p.price <= $5::numeric)
         AND ($6::text    IS NULL OR p.category ILIKE '%' || $6::text || '%')
         AND ($7::boolean IS NULL OR p.in_stock = $7::boolean)
     )
     SELECT id, name, category, description, price, currency, in_stock, url, image_url, similarity,
            ${VECTOR_WEIGHT} * similarity + ${KEYWORD_WEIGHT} * LEAST(keyword_rank, 1) AS score
     FROM scored
     WHERE similarity >= ${MIN_SIMILARITY} OR keyword_hit
     ORDER BY ${ORDER_BY[f.sort]}
     LIMIT ${MAX_PRODUCT_RESULTS}`,
    [botId, toVectorLiteral(queryEmbedding), f.query, f.min_price, f.max_price, f.category, f.in_stock],
  );

  return rows.map((r) => ({
    ...r,
    price     : numberOrNull(r.price),
    similarity: Number(r.similarity),
    score     : Number(r.score),
  }));
}

/**
 * @param {string}   botId
 * @param {string}   query
 * @param {number[]} queryEmbedding
 */
async function searchInfo(botId, query, queryEmbedding) {
  const q = String(query ?? '').trim().slice(0, 200);

  const { rows } = await pool.query(
    `WITH scored AS (
       SELECT i.id, i.title, i.content, i.url,
              1 - (i.embedding <=> $2::vector)                       AS similarity,
              ts_rank(i.search_tsv, plainto_tsquery('simple', $3))   AS keyword_rank,
              i.search_tsv @@ plainto_tsquery('simple', $3)          AS keyword_hit
       FROM catalog_info i
       WHERE i.bot_id = $1
     )
     SELECT id, title, content, url, similarity,
            ${VECTOR_WEIGHT} * similarity + ${KEYWORD_WEIGHT} * LEAST(keyword_rank, 1) AS score
     FROM scored
     WHERE similarity >= ${MIN_SIMILARITY} OR keyword_hit
     ORDER BY score DESC
     LIMIT ${MAX_INFO_RESULTS}`,
    [botId, toVectorLiteral(queryEmbedding), q],
  );

  return rows.map((r) => ({ ...r, similarity: Number(r.similarity), score: Number(r.score) }));
}

module.exports = {
  MIN_SIMILARITY,
  VECTOR_WEIGHT,
  KEYWORD_WEIGHT,
  MAX_PRODUCT_RESULTS,
  MAX_INFO_RESULTS,
  sanitizeFilters,
  searchProducts,
  searchInfo,
};
