'use strict';

/**
 * ingest.js
 * ─────────
 * BotForge – run one catalog import: parse → extract → diff → embed → save.
 *
 * Status lifecycle (catalog_sources.status):
 *   pending → processing → ready | failed
 * A failed import never touches rows saved by an earlier successful import.
 */

const pool = require('../auth/db');
const { getOwnerToken }    = require('../auth/token-crypto');
const { parseSpreadsheet } = require('./parsers/spreadsheet');
const { parsePdf }         = require('./parsers/pdf');
const { crawlSite }        = require('./parsers/website');
const { extractCatalog }   = require('./extract');
const { productHash, infoHash } = require('./normalize');
const {
  embedTexts, toVectorLiteral, productEmbeddingText, infoEmbeddingText,
} = require('./embed');

const MAX_PRODUCTS_PER_BOT = 5000;
const MAX_INFO_PER_BOT     = 2000;

const NO_TOKEN_MESSAGE = 'Connect OpenAI before importing a catalog.';

async function setStatus(source, status, fields = {}) {
  await pool.query(
    `UPDATE catalog_sources
     SET status = $3, error = $4,
         item_count     = COALESCE($5, item_count),
         last_synced_at = CASE WHEN $6::boolean THEN NOW() ELSE last_synced_at END
     WHERE id = $1 AND bot_id = $2`,
    [source.id, source.bot_id, status, fields.error ?? null, fields.itemCount ?? null, !!fields.synced],
  );
}

function dedupeInfo(info) {
  const byHash = new Map();
  for (const item of info) {
    const hash = infoHash(item);
    if (!byHash.has(hash)) byHash.set(hash, { ...item, content_hash: hash });
  }
  return [...byHash.values()];
}

/** @returns {Promise<{ products: object[], info: object[], skipped: number }>} */
async function loadItems(source, payload, token, deps) {
  if (source.kind === 'spreadsheet') {
    const { products, skipped } = await deps.parseSpreadsheet(payload.buffer, payload.filename ?? source.name);
    return { products, info: [], skipped };
  }

  if (source.kind === 'pdf') {
    const text = await deps.parsePdf(payload.buffer);
    if (!text.trim()) throw new Error('No text could be read from the PDF.');
    return { ...(await deps.extractCatalog(token, [{ url: null, text }])), skipped: 0 };
  }

  if (source.kind === 'url') {
    const pages = await deps.crawlSite(payload.url ?? source.name);
    if (!pages.length) throw new Error('No readable pages were found at that URL.');
    return { ...(await deps.extractCatalog(token, pages)), skipped: 0 };
  }

  throw new Error(`Unknown source kind: ${source.kind}`);
}

async function checkLimits(source, productCount, infoCount) {
  const { rows: [counts] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM catalog_products WHERE bot_id = $1 AND source_id <> $2)::int AS products,
       (SELECT COUNT(*) FROM catalog_info     WHERE bot_id = $1 AND source_id <> $2)::int AS info`,
    [source.bot_id, source.id],
  );
  if (counts.products + productCount > MAX_PRODUCTS_PER_BOT) {
    throw new Error(`This catalog would exceed the limit of ${MAX_PRODUCTS_PER_BOT} products per bot.`);
  }
  if (counts.info + infoCount > MAX_INFO_PER_BOT) {
    throw new Error(`This catalog would exceed the limit of ${MAX_INFO_PER_BOT} information entries per bot.`);
  }
}

async function saveItems(source, changedProducts, productVectors, newInfo, infoVectors, keepKeys, keepHashes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < changedProducts.length; i++) {
      const p = changedProducts[i];
      await client.query(
        `INSERT INTO catalog_products
           (bot_id, source_id, external_key, name, category, description, price, currency,
            in_stock, url, image_url, attributes, content_hash, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::vector)
         ON CONFLICT (source_id, external_key) DO UPDATE SET
           name = EXCLUDED.name, category = EXCLUDED.category, description = EXCLUDED.description,
           price = EXCLUDED.price, currency = EXCLUDED.currency, in_stock = EXCLUDED.in_stock,
           url = EXCLUDED.url, image_url = EXCLUDED.image_url, attributes = EXCLUDED.attributes,
           content_hash = EXCLUDED.content_hash, embedding = EXCLUDED.embedding`,
        [
          source.bot_id, source.id, p.external_key, p.name, p.category, p.description, p.price,
          p.currency, p.in_stock, p.url, p.image_url, JSON.stringify(p.attributes),
          productHash(p), toVectorLiteral(productVectors[i]),
        ],
      );
    }

    for (let i = 0; i < newInfo.length; i++) {
      const item = newInfo[i];
      await client.query(
        `INSERT INTO catalog_info (bot_id, source_id, title, content, url, content_hash, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7::vector)
         ON CONFLICT (source_id, content_hash) DO NOTHING`,
        [source.bot_id, source.id, item.title, item.content, item.url ?? null,
         item.content_hash, toVectorLiteral(infoVectors[i])],
      );
    }

    await client.query(
      `DELETE FROM catalog_products
       WHERE bot_id = $1 AND source_id = $2 AND NOT (external_key = ANY($3::text[]))`,
      [source.bot_id, source.id, keepKeys],
    );
    await client.query(
      `DELETE FROM catalog_info
       WHERE bot_id = $1 AND source_id = $2 AND NOT (content_hash = ANY($3::text[]))`,
      [source.bot_id, source.id, keepHashes],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run one import. Never throws: every outcome is written to catalog_sources.
 *
 * @param {string} sourceId
 * @param {{ buffer?: Buffer, filename?: string, url?: string }} payload
 * @param {object} deps – injectable parsers/extractor (tests)
 */
async function runIngest(sourceId, payload, deps = {}) {
  const d = { parseSpreadsheet, parsePdf, crawlSite, extractCatalog, ...deps };
  let source;

  try {
    const { rows } = await pool.query(
      `SELECT s.*, b.user_id
       FROM catalog_sources s
       JOIN bots b ON b.id = s.bot_id
       WHERE s.id = $1`,
      [sourceId],
    );
    source = rows[0];
    if (!source) return;

    await setStatus(source, 'processing');

    const token = await getOwnerToken(source.user_id);
    if (!token) throw new Error(NO_TOKEN_MESSAGE);

    const loaded   = await loadItems(source, payload, token, d);
    const products = loaded.products;
    const info     = dedupeInfo(loaded.info);
    if (!products.length && !info.length) {
      throw new Error('No products or information were found in this source.');
    }

    await checkLimits(source, products.length, info.length);

    // ── Diff against this source's existing rows ──────────────────────
    const { rows: existingProducts } = await pool.query(
      'SELECT external_key, content_hash FROM catalog_products WHERE bot_id = $1 AND source_id = $2',
      [source.bot_id, source.id],
    );
    const { rows: existingInfo } = await pool.query(
      'SELECT content_hash FROM catalog_info WHERE bot_id = $1 AND source_id = $2',
      [source.bot_id, source.id],
    );
    const knownProducts = new Map(existingProducts.map((r) => [r.external_key, r.content_hash]));
    const knownInfo     = new Set(existingInfo.map((r) => r.content_hash));

    const changedProducts = products.filter((p) => knownProducts.get(p.external_key) !== productHash(p));
    const newInfo         = info.filter((i) => !knownInfo.has(i.content_hash));

    // ── Embed only what changed ───────────────────────────────────────
    const productVectors = await embedTexts(token, changedProducts.map(productEmbeddingText));
    const infoVectors    = await embedTexts(token, newInfo.map(infoEmbeddingText));

    await saveItems(
      source, changedProducts, productVectors, newInfo, infoVectors,
      products.map((p) => p.external_key), info.map((i) => i.content_hash),
    );

    await setStatus(source, 'ready', {
      error    : loaded.skipped > 0 ? `Skipped ${loaded.skipped} rows without a name.` : null,
      itemCount: products.length + info.length,
      synced   : true,
    });
  } catch (err) {
    console.error(`[ingest] source ${sourceId} failed:`, err.message);
    if (!source) return;
    await setStatus(source, 'failed', { error: err.message || 'Import failed.' })
      .catch((e) => console.error('[ingest] could not record failure:', e.message));
  }
}

/**
 * Mark imports that were running when the server stopped as failed.
 * @returns {Promise<number>} rows updated
 */
async function recoverInterruptedImports() {
  const { rowCount } = await pool.query(
    `UPDATE catalog_sources
     SET status = 'failed', error = 'Interrupted by server restart'
     WHERE status IN ('pending', 'processing')`,
  );
  return rowCount;
}

module.exports = {
  MAX_PRODUCTS_PER_BOT,
  MAX_INFO_PER_BOT,
  NO_TOKEN_MESSAGE,
  runIngest,
  recoverInterruptedImports,
};
