'use strict';

/**
 * embed.js
 * ────────
 * BotForge – batched OpenAI embeddings for catalog products and info chunks.
 */

const { openaiJson } = require('./openai-client');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS  = 1536;
const EMBED_BATCH     = 100;

/**
 * @param {string}   token
 * @param {string[]} texts
 * @param {{ projectId?: string|null }} opts – the bot's OpenAI project, if any
 * @returns {Promise<number[][]>} one vector per text, in input order
 */
async function embedTexts(token, texts, opts = {}) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const data  = await openaiJson(token, '/embeddings', { model: EMBEDDING_MODEL, input: batch }, opts);
    const ordered = [...data.data].sort((a, b) => a.index - b.index);
    for (const item of ordered) vectors.push(item.embedding);
  }
  return vectors;
}

/** pgvector input literal, e.g. '[0.1,0.2]'. Pass as `$n::vector`. */
function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}

/** `name · category · description · k: v; k: v · price currency`, skipping empty parts. */
function productEmbeddingText(p) {
  const attributes = Object.entries(p.attributes ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ');
  return [
    p.name,
    p.category,
    p.description,
    attributes || null,
    p.price !== null && p.price !== undefined ? `${p.price} ${p.currency}` : null,
  ].filter(Boolean).join(' · ');
}

function infoEmbeddingText({ title, content }) {
  return `${title}\n${content}`;
}

module.exports = {
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  EMBED_BATCH,
  embedTexts,
  toVectorLiteral,
  productEmbeddingText,
  infoEmbeddingText,
};
