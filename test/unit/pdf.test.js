'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { parsePdf } = require('../../catalog/parsers/pdf');
const { makePdf } = require('../fixtures/make-pdf');

test('extracts text from a PDF', async () => {
  const text = await parsePdf(makePdf('Rain Jacket Rs 2999'));
  assert.match(text, /Rain Jacket/);
});

test('parses several different PDFs in one process', async () => {
  // pdf.js keeps per-process state that broke every PDF after the first
  for (const text of ['Rain Jacket Rs 2999', 'Trekking Pole Rs 1499', 'Cap Rs 199']) {
    assert.match(await parsePdf(makePdf(text)), new RegExp(text));
  }
});

test('reads a PDF that sits inside a larger buffer (pooled upload buffers)', async () => {
  // multer hands small uploads over as views into Node's shared buffer pool
  const pdf = makePdf('Trekking Pole Rs 1499');
  const pool = Buffer.alloc(pdf.length + 300, 0x20);
  pdf.copy(pool, 300);
  const view = pool.subarray(300);
  assert.notEqual(view.byteOffset, 0);
  assert.match(await parsePdf(view), /Trekking Pole/);
});

test('rejects a buffer that is not a PDF', async () => {
  await assert.rejects(parsePdf(Buffer.from('definitely not a pdf')));
});
