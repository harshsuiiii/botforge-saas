'use strict';

/**
 * spreadsheet.js
 * ──────────────
 * BotForge – CSV / XLSX catalog parser. No LLM involved: prices and stock
 * come straight from the sheet.
 */

const path        = require('path');
const ExcelJS     = require('exceljs');
const { parse }   = require('csv-parse/sync');
const { normalizeProduct, dedupeProducts } = require('../normalize');

/** Lower-cased header → Product field. Anything else goes into attributes. */
const HEADER_ALIASES = {
  'name'          : 'name',
  'title'         : 'name',
  'product'       : 'name',
  'product name'  : 'name',
  'item'          : 'name',
  'price'         : 'price',
  'mrp'           : 'price',
  'cost'          : 'price',
  'selling price' : 'price',
  'amount'        : 'price',
  'stock'         : 'in_stock',
  'qty'           : 'in_stock',
  'quantity'      : 'in_stock',
  'availability'  : 'in_stock',
  'in stock'      : 'in_stock',
  'category'      : 'category',
  'description'   : 'description',
  'sku'           : 'sku',
  'url'           : 'url',
  'link'          : 'url',
  'product url'   : 'url',
  'image'         : 'image_url',
  'image url'     : 'image_url',
  'photo'         : 'image_url',
  'currency'      : 'currency',
};

function normalizeHeader(header) {
  return String(header ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 'price (₹)' → 'price', 'stock [qty]' → 'stock' for alias lookup. */
function stripUnitSuffix(key) {
  return key.replace(/\s*[([].*?[)\]]\s*$/, '');
}

const LINK_FIELDS = new Set(['url', 'image_url']);

/**
 * Map one row ({ header: value }) onto the raw product shape.
 * links holds XLSX hyperlink targets by header; URL columns prefer the target
 * over the display text (often just "View").
 */
function rowToRaw(row, links = {}) {
  const raw = { attributes: {} };
  for (const [header, value] of Object.entries(row)) {
    const key = normalizeHeader(header);
    if (!key) continue;
    const field = HEADER_ALIASES[key] ?? HEADER_ALIASES[stripUnitSuffix(key)];
    if (field) raw[field] = LINK_FIELDS.has(field) && links[header] ? links[header] : value;
    else raw.attributes[key] = value;
  }
  return raw;
}

/** ExcelJS cell value → plain string/number. */
function cellToValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if ('result' in value) return value.result;             // formula
  if ('text' in value) return value.text;                 // hyperlink
  if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
  return String(value);
}

async function readXlsxRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  let headers = null;
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells  = row.values.slice(1);                 // ExcelJS rows are 1-indexed
    const values = cells.map(cellToValue);
    if (!headers) {
      headers = values.map((v) => String(v ?? ''));
      return;
    }
    const record = {};
    const links  = {};
    headers.forEach((h, i) => {
      record[h] = values[i] ?? null;
      if (cells[i] && typeof cells[i] === 'object' && cells[i].hyperlink) links[h] = cells[i].hyperlink;
    });
    rows.push({ record, links });
  });
  return rows;
}

function readCsvRows(buffer) {
  return parse(buffer, {
    bom             : true,
    columns         : true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim            : true,
  });
}

/**
 * @param {Buffer} buffer
 * @param {string} filename – used for the extension (.csv or .xlsx)
 * @returns {Promise<{ products: object[], skipped: number }>}
 */
async function parseSpreadsheet(buffer, filename) {
  const ext = path.extname(filename ?? '').toLowerCase();
  let rows;
  if (ext === '.csv') rows = readCsvRows(buffer).map((record) => ({ record, links: {} }));
  else if (ext === '.xlsx') rows = await readXlsxRows(buffer);
  else throw new Error(`Unsupported spreadsheet type: ${ext || 'unknown'}`);

  const products = [];
  let skipped = 0;
  for (const { record, links } of rows) {
    const product = normalizeProduct(rowToRaw(record, links));
    if (product) products.push(product);
    else skipped += 1;
  }

  return { products: dedupeProducts(products), skipped };
}

module.exports = { parseSpreadsheet, HEADER_ALIASES };
