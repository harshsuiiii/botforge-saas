'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

process.env.TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { encryptToken, decryptToken } = require('../../auth/token-crypto');

test('round-trips a token', () => {
  const { encrypted_token, iv } = encryptToken('sk-abc');
  assert.equal(decryptToken(encrypted_token, iv), 'sk-abc');
});

test('uses a fresh 12-byte IV each time', () => {
  const a = encryptToken('sk-abc');
  const b = encryptToken('sk-abc');
  assert.equal(a.iv.length, 12);
  assert.notDeepEqual(a.iv, b.iv);
});

test('rejects tampered ciphertext', () => {
  const { encrypted_token, iv } = encryptToken('sk-abc');
  encrypted_token[0] ^= 0xff;
  assert.throws(() => decryptToken(encrypted_token, iv));
});

test('rejects a key that is not 64 hex chars', () => {
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = 'abc';
  try {
    assert.throws(() => encryptToken('sk-abc'), /64-character/);
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = saved;
  }
});
