'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedAddress, assertPublicUrl } = require('../../catalog/url-guard');

const lookupTo = (...addresses) => async () => addresses.map((address) => ({
  address,
  family: address.includes(':') ? 6 : 4,
}));

test('blocks private, loopback, link-local and metadata ranges', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test('rejects non-http schemes', async () => {
  for (const url of ['ftp://x.com/', 'javascript:alert(1)', 'not a url']) {
    await assert.rejects(assertPublicUrl(url, { lookup: lookupTo('8.8.8.8') }), { code: 'URL_INVALID' });
  }
});

test('rejects localhost by name', async () => {
  await assert.rejects(
    assertPublicUrl('http://localhost:3000/', { lookup: lookupTo('8.8.8.8') }),
    { code: 'URL_BLOCKED' },
  );
});

test('rejects IP-literal private hosts without a lookup', async () => {
  const lookup = async () => { throw new Error('lookup should not be called'); };
  await assert.rejects(assertPublicUrl('http://127.0.0.1/', { lookup }), { code: 'URL_BLOCKED' });
  await assert.rejects(assertPublicUrl('http://[::1]:8080/', { lookup }), { code: 'URL_BLOCKED' });
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data', { lookup }), { code: 'URL_BLOCKED' });
});

test('rejects hosts resolving to private IPs', async () => {
  await assert.rejects(
    assertPublicUrl('https://shop.test/', { lookup: lookupTo('10.0.0.5') }),
    { code: 'URL_BLOCKED' },
  );
});

test('rejects if any resolved address is private', async () => {
  await assert.rejects(
    assertPublicUrl('https://shop.test/', { lookup: lookupTo('8.8.8.8', '192.168.0.2') }),
    { code: 'URL_BLOCKED' },
  );
});

test('allows public hosts', async () => {
  const url = await assertPublicUrl('https://shop.test/products?page=2', { lookup: lookupTo('93.184.216.34') });
  assert.ok(url instanceof URL);
  assert.equal(url.hostname, 'shop.test');
});
