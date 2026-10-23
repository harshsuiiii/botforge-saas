'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const { crawlSite } = require('../../catalog/parsers/website');

const page = (body) => `<!doctype html><html><body>${body}</body></html>`;

const ROUTES = {
  '/': page(`
    <nav>NAVTEXT</nav><script>var x = "SCRIPTTEXT";</script><style>.a{}</style>
    <main><h1>Rain Jacket</h1><p>Waterproof, ₹2,999</p></main>
    <a href="/a">A</a> <a href="/a#reviews">A again</a> <a href="http://other.test/x">other</a>
    <a href="/file.json">json</a> <a href="/go">go</a> <a href="mailto:x@y.z">mail</a>
    <footer>FOOTTEXT</footer>`),
  '/a': page('<p>Page A</p><a href="/b">B</a>'),
  '/b': page('<p>Page B</p><a href="/c">C</a>'),
  '/c': page('<p>Page C</p>'),
  '/big': page(`<p>${'x'.repeat(5000)}</p>`),
  '/many': page(Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('')),
};
for (let i = 0; i < 10; i++) ROUTES[`/p${i}`] = page(`<p>Product ${i}</p>`);

let server;
let base;
let guardCalls;
let fetched;

const guard = async (u) => {
  guardCalls.push(u);
  if (new URL(u).hostname === 'blocked.test') {
    throw Object.assign(new Error('blocked'), { code: 'URL_BLOCKED' });
  }
  return new URL(u);
};
const fetchImpl = (u, init) => { fetched.push(String(u)); return fetch(u, init); };
const paths = (pages) => pages.map((p) => new URL(p.url).pathname).sort();

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/file.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"a":1}');
    }
    if (url.pathname === '/go') {
      res.writeHead(302, { location: 'http://blocked.test/' });
      return res.end();
    }
    const loop = /^\/loop(\d+)$/.exec(url.pathname);
    if (loop) {
      res.writeHead(302, { location: `/loop${Number(loop[1]) + 1}` });
      return res.end();
    }
    const html = ROUTES[url.pathname];
    if (!html) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((r) => server.close(r)));

test.beforeEach(() => { guardCalls = []; fetched = []; });

test('crawls same-host links up to maxDepth', async () => {
  const pages = await crawlSite(`${base}/`, { guard, fetchImpl, maxDepth: 2 });
  assert.deepEqual(paths(pages), ['/', '/a', '/b']);
});

test('ignores other hosts', async () => {
  await crawlSite(`${base}/`, { guard, fetchImpl });
  assert.ok(!fetched.some((u) => u.includes('other.test')));
});

test('respects maxPages', async () => {
  const pages = await crawlSite(`${base}/many`, { guard, fetchImpl, maxPages: 3 });
  assert.equal(pages.length, 3);
});

test('strips script, style, nav and footer text', async () => {
  const pages = await crawlSite(`${base}/`, { guard, fetchImpl, maxDepth: 0 });
  assert.equal(pages.length, 1);
  assert.match(pages[0].text, /Rain Jacket/);
  for (const hidden of ['NAVTEXT', 'SCRIPTTEXT', 'FOOTTEXT']) {
    assert.ok(!pages[0].text.includes(hidden), `${hidden} should be stripped`);
  }
});

test('skips non-HTML responses', async () => {
  const pages = await crawlSite(`${base}/`, { guard, fetchImpl });
  assert.ok(!paths(pages).includes('/file.json'));
});

test('skips bodies over maxBytes', async () => {
  const pages = await crawlSite(`${base}/big`, { guard, fetchImpl, maxBytes: 1000 });
  assert.equal(pages.length, 0);
});

test('checks the guard on redirects', async () => {
  const pages = await crawlSite(`${base}/`, { guard, fetchImpl });
  assert.ok(guardCalls.includes('http://blocked.test/'));
  assert.ok(!fetched.some((u) => u.includes('blocked.test')));
  assert.ok(!paths(pages).includes('/go'));
});

test('gives up after too many redirects', async () => {
  const pages = await crawlSite(`${base}/loop1`, { guard, fetchImpl, maxRedirects: 5 });
  assert.equal(pages.length, 0);
  assert.ok(fetched.length <= 6);
});

test('rethrows when the start URL is blocked', async () => {
  await assert.rejects(crawlSite('http://blocked.test/', { guard, fetchImpl }), { code: 'URL_BLOCKED' });
});
