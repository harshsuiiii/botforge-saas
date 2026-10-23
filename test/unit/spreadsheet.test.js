'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseSpreadsheet } = require('../../catalog/parsers/spreadsheet');

const csv = (text) => Buffer.from(text, 'utf8');

test('maps aliased CSV headers', async () => {
  const { products, skipped } = await parseSpreadsheet(
    csv('Product Name,MRP,Qty,Colour\nRain Jacket,"₹2,999",3,Blue\n'),
    'catalog.csv',
  );
  assert.equal(skipped, 0);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Rain Jacket');
  assert.equal(products[0].price, 2999);
  assert.equal(products[0].in_stock, true);
  assert.deepEqual(products[0].attributes, { colour: 'Blue' });
});

test('handles a UTF-8 BOM header', async () => {
  const { products } = await parseSpreadsheet(csv('﻿name,price\nCap,199\n'), 'c.csv');
  assert.equal(products[0].name, 'Cap');
  assert.equal(products[0].price, 199);
});

test('maps the remaining aliases', async () => {
  const { products } = await parseSpreadsheet(
    csv('Title,Selling Price,Availability,Category,Description,SKU,Link,Image URL,Currency\n' +
        'Cap,199,sold out,Hats,Cotton cap,CP-1,https://s.test/cap,https://s.test/cap.jpg,inr\n'),
    'c.csv',
  );
  assert.deepEqual(products[0], {
    external_key: 'CP-1', name: 'Cap', category: 'Hats', description: 'Cotton cap', price: 199,
    currency: 'INR', in_stock: false, url: 'https://s.test/cap', image_url: 'https://s.test/cap.jpg',
    attributes: {},
  });
});

test('counts skipped rows without a name', async () => {
  const { products, skipped } = await parseSpreadsheet(csv('name,price\n,10\nCap,20\n'), 'c.csv');
  assert.equal(skipped, 1);
  assert.equal(products.length, 1);
});

test('merges duplicate SKUs in one file', async () => {
  const { products } = await parseSpreadsheet(
    csv('name,sku,price\nRain Jacket,JK-1,2999\nRain Jacket (Blue),JK-1,\n'),
    'c.csv',
  );
  assert.equal(products.length, 1);
  assert.equal(products[0].price, 2999);
});

test('reads the first XLSX worksheet', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');
  ws.addRow(['Product Name', 'MRP', 'Qty', 'Colour']);
  ws.addRow(['Rain Jacket', '₹2,999', 3, 'Blue']);
  wb.addWorksheet('Notes').addRow(['ignore me']);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  const { products } = await parseSpreadsheet(buffer, 'catalog.XLSX');
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Rain Jacket');
  assert.equal(products[0].price, 2999);
  assert.equal(products[0].in_stock, true);
  assert.deepEqual(products[0].attributes, { colour: 'Blue' });
});

test('rejects unsupported extensions', async () => {
  await assert.rejects(parseSpreadsheet(csv('a'), 'catalog.txt'), /Unsupported/);
});
