'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot, authHeader } = require('../helpers/db');
const { installOpenAIStub } = require('../helpers/openai-stub');
const { startApp } = require('../helpers/http');

let pool;
let app;
let stub;
let getOwnerToken;

const GOOD_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234';

function call(method, path, userId, body) {
  return fetch(`${app.base}/auth/openai${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(userId ? authHeader(userId) : {}) },
    body   : body === undefined ? undefined : JSON.stringify(body),
  });
}

test.before(async () => {
  ({ pool } = await setupTestDb());
  stub = installOpenAIStub();
  ({ getOwnerToken } = require('../../auth/token-crypto'));
  app = await startApp([['/auth', require('../../auth/openai-key')]]);
});

test.after(async () => {
  await app.close();
  stub.restore();
});

test.beforeEach(() => { stub.requests.length = 0; });

test('saves a valid key encrypted and reports it connected', async () => {
  const { userId } = await seedBot(pool, { withToken: false });

  const res = await call('POST', '/key', userId, { api_key: `  ${GOOD_KEY} ` });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connected: true, key_hint: 'sk-…1234' });

  const [check] = stub.requests;
  assert.equal(check.path, '/v1/models');
  assert.equal(check.headers.Authorization, `Bearer ${GOOD_KEY}`);
  assert.equal(await getOwnerToken(userId), GOOD_KEY);
  const { rows: [row] } = await pool.query('SELECT encrypted_token FROM openai_tokens WHERE user_id = $1', [userId]);
  assert.ok(!Buffer.from(row.encrypted_token).toString('utf8').includes(GOOD_KEY));
});

test('replacing a key keeps a single row', async () => {
  const { userId } = await seedBot(pool); // already has a key
  await call('POST', '/key', userId, { api_key: GOOD_KEY });
  const { rows } = await pool.query('SELECT 1 FROM openai_tokens WHERE user_id = $1', [userId]);
  assert.equal(rows.length, 1);
  assert.equal(await getOwnerToken(userId), GOOD_KEY);
});

test('rejects malformed keys without calling OpenAI', async () => {
  const { userId } = await seedBot(pool, { withToken: false });
  for (const api_key of ['', 'hello', 'sk-short', 42, null, 'sk-' + 'x'.repeat(400)]) {
    const res = await call('POST', '/key', userId, { api_key });
    assert.equal(res.status, 400, String(api_key));
  }
  assert.equal(stub.requests.length, 0);
});

test('rejects a key OpenAI refuses', async () => {
  const { userId } = await seedBot(pool, { withToken: false });
  const res = await call('POST', '/key', userId, { api_key: 'sk-bad-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'OpenAI rejected this key. Check it and try again.');
  assert.equal(await getOwnerToken(userId), null);
});

test('reports an OpenAI outage as 502', async () => {
  const { userId } = await seedBot(pool, { withToken: false });
  const res = await call('POST', '/key', userId, { api_key: 'sk-down-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(res.status, 502);
  assert.equal(await getOwnerToken(userId), null);
});

test('status shows connection and a key hint', async () => {
  const { userId } = await seedBot(pool, { withToken: false });
  assert.deepEqual(await (await call('GET', '/status', userId)).json(), { connected: false, key_hint: null });
  await call('POST', '/key', userId, { api_key: GOOD_KEY });
  assert.deepEqual(await (await call('GET', '/status', userId)).json(), { connected: true, key_hint: 'sk-…1234' });
});

test('DELETE disconnects the key', async () => {
  const { userId } = await seedBot(pool);
  const res = await call('DELETE', '/key', userId);
  assert.equal(res.status, 204);
  assert.equal(await getOwnerToken(userId), null);
});

test('requires authentication', async () => {
  assert.equal((await call('POST', '/key', null, { api_key: GOOD_KEY })).status, 401);
  assert.equal((await call('DELETE', '/key', null)).status, 401);
});

test('the old OAuth routes are gone', async () => {
  const { userId } = await seedBot(pool);
  assert.equal((await call('GET', '?token=x', userId)).status, 404);
  assert.equal((await call('GET', '/callback?code=x&state=y', userId)).status, 404);
});
