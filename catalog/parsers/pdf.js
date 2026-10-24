'use strict';

/**
 * pdf.js
 * ──────
 * BotForge – PDF catalog → plain text (products are extracted later by the LLM).
 */

// The package root runs a debug self-test when loaded directly; the lib entry does not.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function parsePdf(buffer) {
  const data = await pdfParse(buffer);
  return data.text ?? '';
}

module.exports = { parsePdf };
