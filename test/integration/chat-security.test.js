'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot } = require('../helpers/db');
const { installOpenAIStub, sse } = require('../helpers/openai-stub');
const { startApp } = require('../helpers/http');

let pool;
let app;
let stub;
let chatRouter;

function send(embedKey, { message = 'hi', sessionId = null, origin } = {}) {
  return fetch(`${app.base}/chat`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body   : JSON.stringify({ embed_key: embedKey, message, session_id: sessionId }),
  });
}

async function sessionIdFrom(res) {
  const first = (await res.text()).split('\n\n')[0].replace(/^data: /, '');
  return JSON.parse(first).session_id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const queueHello = () => stub.queueChat({ sse: [...sse.text('Hello!'), sse.finish()] });

test.before(async () => {
  ({ pool } = await setupTestDb());
  stub = installOpenAIStub();
  chatRouter = require('../../chat/chat');
  app = await startApp([['/chat', chatRouter]]);
});

test.after(async () => {
  await app.close();
  stub.restore();
});

test.beforeEach(() => chatRouter.resetRateLimits());

test('rate-limits one visitor to 20 messages a minute per bot', async () => {
  const { embedKey } = await seedBot(pool);
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    if (i < 20) queueHello();
    const res = await send(embedKey);
    statuses.push(res.status);
    await res.body?.cancel();
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200));
  const limited = await send(embedKey);
  assert.equal(statuses[20], 429);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.match((await limited.json()).error, /Too many messages/);
});

test('rate limits are per bot', async () => {
  const a = await seedBot(pool);
  const b = await seedBot(pool);
  for (let i = 0; i < 20; i++) { queueHello(); await (await send(a.embedKey)).text(); }
  assert.equal((await send(a.embedKey)).status, 429);
  queueHello();
  assert.equal((await send(b.embedKey)).status, 200);
});

test('a bot with a domain allowlist rejects requests without an Origin', async () => {
  const { embedKey, botId } = await seedBot(pool);
  await pool.query(`UPDATE embed_configs SET domain_allowlist = '{https://shop.example}' WHERE bot_id = $1`, [botId]);
  const res = await send(embedKey);
  assert.equal(res.status, 403);
});

test('allowlist matching uses hostnames, subdomains included', async () => {
  const { embedKey, botId } = await seedBot(pool);
  await pool.query(`UPDATE embed_configs SET domain_allowlist = '{https://shop.example, other.example, "not a url ::"}' WHERE bot_id = $1`, [botId]);

  for (const origin of ['https://shop.example', 'https://www.shop.example', 'https://other.example', 'http://app.other.example:8080']) {
    queueHello();
    const res = await send(embedKey, { origin });
    assert.equal(res.status, 200, origin);
    await res.text();
  }
  for (const origin of ['https://evilshop.example', 'https://shop.example.attacker.test', 'null']) {
    assert.equal((await send(embedKey, { origin })).status, 403, origin);
  }
});

test('the origin check exposes a pure helper', () => {
  const { isOriginAllowed } = chatRouter;
  assert.equal(isOriginAllowed(undefined, []), true);
  assert.equal(isOriginAllowed(undefined, ['https://a.example']), false);
  assert.equal(isOriginAllowed('https://a.example', ['a.example']), true);
  assert.equal(isOriginAllowed('https://b.example', ['::bad::']), false);
});

test('a non-UUID session_id starts a fresh session', async () => {
  const { embedKey } = await seedBot(pool);
  queueHello();
  const sessionId = await sessionIdFrom(await send(embedKey, { sessionId: "x'; DROP TABLE sessions; --" }));
  assert.match(sessionId, UUID_RE);
});

test("another bot's session_id is never reused or overwritten", async () => {
  const a = await seedBot(pool);
  const b = await seedBot(pool);
  queueHello();
  const sessionA = await sessionIdFrom(await send(a.embedKey, { message: 'secret question for bot A' }));
  await new Promise((r) => setTimeout(r, 200)); // session is saved after the stream

  queueHello();
  const sessionB = await sessionIdFrom(await send(b.embedKey, { sessionId: sessionA, message: 'hijack' }));
  assert.notEqual(sessionB, sessionA);
  await new Promise((r) => setTimeout(r, 200));

  const { rows: [saved] } = await pool.query('SELECT bot_id, messages FROM sessions WHERE session_id = $1', [sessionA]);
  assert.equal(saved.bot_id, a.botId);
  assert.equal(saved.messages[0].content, 'secret question for bot A');
  assert.ok(!saved.messages.some((m) => m.content === 'hijack'));
});
