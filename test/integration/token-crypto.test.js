'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, seedBot } = require('../helpers/db');

let pool;
let getOwnerToken;

test.before(async () => {
  ({ pool } = await setupTestDb());
  ({ getOwnerToken } = require('../../auth/token-crypto'));
});

test('getOwnerToken returns null without a token', async () => {
  const { userId } = await seedBot(pool, { withToken: false });
  assert.equal(await getOwnerToken(userId), null);
});

test('getOwnerToken returns the decrypted latest token', async () => {
  const { userId } = await seedBot(pool);
  assert.equal(await getOwnerToken(userId), 'sk-test-owner');
});
