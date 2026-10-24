'use strict';

const { fakeEmbedding } = require('./openai-stub');

/**
 * Insert a catalog source with products (and optional info) for a bot,
 * embedding them with fakeEmbedding so search behaves deterministically.
 *
 * @returns {Promise<{ sourceId: string, products: Array<{ id: string, name: string }> }>}
 */
async function seedCatalog(pool, botId, rawProducts, { info = [], status = 'ready' } = {}) {
  const { normalizeProduct, productHash, infoHash } = require('../../catalog/normalize');
  const { productEmbeddingText, infoEmbeddingText, toVectorLiteral } = require('../../catalog/embed');

  const { rows: [source] } = await pool.query(
    `INSERT INTO catalog_sources (bot_id, kind, name, status) VALUES ($1, 'spreadsheet', 'c.csv', $2) RETURNING id`,
    [botId, status],
  );

  const products = [];
  for (const raw of rawProducts) {
    const p = normalizeProduct(raw);
    const { rows: [row] } = await pool.query(
      `INSERT INTO catalog_products
         (bot_id, source_id, external_key, name, category, description, price, currency, in_stock,
          url, image_url, attributes, content_hash, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::vector)
       RETURNING id, name`,
      [botId, source.id, p.external_key, p.name, p.category, p.description, p.price, p.currency,
       p.in_stock, p.url, p.image_url, JSON.stringify(p.attributes), productHash(p),
       toVectorLiteral(fakeEmbedding(productEmbeddingText(p)))],
    );
    products.push(row);
  }

  for (const item of info) {
    await pool.query(
      `INSERT INTO catalog_info (bot_id, source_id, title, content, content_hash, embedding)
       VALUES ($1,$2,$3,$4,$5,$6::vector)`,
      [botId, source.id, item.title, item.content, infoHash(item),
       toVectorLiteral(fakeEmbedding(infoEmbeddingText(item)))],
    );
  }

  return { sourceId: source.id, products };
}

module.exports = { seedCatalog };
