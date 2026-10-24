'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

/** Load public/widget.js in a sandbox with no data-bot, exposing its test helpers. */
function loadWidgetInternals() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'widget.js'), 'utf8');
  const window = { __BF_TEST__: true };
  const context = {
    window,
    document: { currentScript: null, getElementsByTagName: () => [] },
    console : { warn() {}, error() {}, log() {} },
    URL,
    Intl,
  };
  vm.runInNewContext(source, context);
  return window.__BF_TEST__;
}

const internals = loadWidgetInternals();

test('exposes helpers only when the test flag is set', () => {
  assert.equal(typeof internals.safeHttpUrl, 'function');
  assert.equal(typeof internals.formatPrice, 'function');
});

test('safeHttpUrl allows only http(s)', () => {
  const { safeHttpUrl } = internals;
  assert.equal(safeHttpUrl('https://shop.test/p'), 'https://shop.test/p');
  assert.equal(safeHttpUrl('http://shop.test/a b'), 'http://shop.test/a%20b');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('JavaScript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<script>x</script>'), null);
  assert.equal(safeHttpUrl('not a url'), null);
  assert.equal(safeHttpUrl(''), null);
  assert.equal(safeHttpUrl(null), null);
});

test('formatPrice formats currency and survives bad codes', () => {
  const { formatPrice } = internals;
  assert.match(formatPrice(2999, 'INR'), /2,999/);
  assert.equal(formatPrice(5, 'XYZ1'), 'XYZ1 5');
  assert.equal(formatPrice(null, 'INR'), '');
});
