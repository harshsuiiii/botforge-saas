'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { parsePdf } = require('../../catalog/parsers/pdf');
const { makePdf } = require('../fixtures/make-pdf');

test('extracts text from a PDF', async () => {
  const text = await parsePdf(makePdf('Rain Jacket Rs 2999'));
  assert.match(text, /Rain Jacket/);
});

test('rejects a buffer that is not a PDF', async () => {
  await assert.rejects(parsePdf(Buffer.from('definitely not a pdf')));
});
