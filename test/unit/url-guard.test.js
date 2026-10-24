'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const { isBlockedAddress, assertPublicUrl, makeGuardedLookup, guardedFetch } = require('../../catalog/url-guard');

test('blocks CGNAT, NAT64, IPv4-compatible, 6to4, multicast and reserved ranges', () => {
  for (const ip of [
    '100.100.100.200', '100.64.0.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255', '64:ff9b::a9fe:a9fe', '::7f00:1', '2002:7f00:1::',
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
  assert.equal(isBlockedAddress('100.128.0.1'), false);
});

test('rejects an IPv4-compatible IPv6 literal URL', async () => {
  await assert.rejects(
    assertPublicUrl('http://[::127.0.0.1]/', { lookup: async () => { throw new Error('no lookup'); } }),
    { code: 'URL_BLOCKED' },
  );
});

test('guarded lookup rejects private answers and passes public ones', async () => {
  const stub = (address) => (_host, _opts, cb) => cb(null, [{ address, family: 4 }]);
  const call = (lookup, opts) => new Promise((resolve) => lookup('shop.test', opts, (...args) => resolve(args)));

  const [blockedErr] = await call(makeGuardedLookup(stub('10.0.0.5')), {});
  assert.equal(blockedErr.code, 'URL_BLOCKED');

  const [err, address, family] = await call(makeGuardedLookup(stub('93.184.216.34')), {});
  assert.equal(err, null);
  assert.equal(address, '93.184.216.34');
  assert.equal(family, 4);

  const [allErr, list] = await call(makeGuardedLookup(stub('93.184.216.34')), { all: true });
  assert.equal(allErr, null);
  assert.deepEqual(list, [{ address: '93.184.216.34', family: 4 }]);
});

test('guarded fetch re-checks DNS at connect time (rebinding)', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits += 1; res.end('internal'); });
  await new Promise((r) => server.listen(0, r));
  try {
    // localhost passes no pre-check here, but the connection-time lookup resolves to loopback
    await assert.rejects(guardedFetch(`http://localhost:${server.address().port}/`));
    assert.equal(hits, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

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
