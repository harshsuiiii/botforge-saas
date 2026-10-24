'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot, authHeader } = require('../helpers/db');
const { startApp } = require('../helpers/http');

let pool;
let app;

test.before(async () => {
  ({ pool } = await setupTestDb());
  app = await startApp([['/api/bots', require('../../bots/bots')]]);
});

test.after(() => app.close());

function put(botId, userId, body) {
  return fetch(`${app.base}/api/bots/${botId}`, {
    method : 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader(userId) },
    body   : JSON.stringify(body),
  });
}

test('PUT saves answer_mode and fallback_message', async () => {
  const { botId, userId } = await seedBot(pool);
  const res = await put(botId, userId, { answer_mode: 'strict', fallback_message: 'Call 98xxxx' });
  assert.equal(res.status, 200);
  const { bot } = await res.json();
  assert.equal(bot.answer_mode, 'strict');
  assert.equal(bot.fallback_message, 'Call 98xxxx');
});

test('PUT keeps existing values when omitted', async () => {
  const { botId, userId } = await seedBot(pool);
  await put(botId, userId, { answer_mode: 'strict', fallback_message: 'Call us' });
  const res = await put(botId, userId, { name: 'X' });
  const { bot } = await res.json();
  assert.equal(bot.answer_mode, 'strict');
  assert.equal(bot.fallback_message, 'Call us');
});

test('PUT rejects an invalid answer_mode', async () => {
  const { botId, userId } = await seedBot(pool);
  const res = await put(botId, userId, { answer_mode: 'loose' });
  assert.equal(res.status, 400);
});

test('PUT rejects a fallback_message over 500 chars', async () => {
  const { botId, userId } = await seedBot(pool);
  const res = await put(botId, userId, { fallback_message: 'a'.repeat(501) });
  assert.equal(res.status, 400);
});

test('another user cannot update the bot', async () => {
  const { botId } = await seedBot(pool);
  const { userId: otherUser } = await seedBot(pool);
  const res = await put(botId, otherUser, { answer_mode: 'strict' });
  assert.equal(res.status, 403);
});
