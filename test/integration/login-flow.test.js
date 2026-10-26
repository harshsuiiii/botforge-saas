'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const jwt    = require('jsonwebtoken');
const { setupTestDb, seedBot } = require('../helpers/db');
const { startApp } = require('../helpers/http');

// passport-google-oauth20 refuses to construct without a client id
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.FRONTEND_URL         = 'http://localhost:5173';

let pool;
let app;
let codes;
let google;
let devLogin;

const post = (path, body) => fetch(`${app.base}/auth${path}`, {
  method : 'POST',
  headers: { 'Content-Type': 'application/json' },
  body   : JSON.stringify(body ?? {}),
});

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test.before(async () => {
  ({ pool } = await setupTestDb());
  codes    = require('../../auth/login-codes');
  google   = require('../../auth/google');
  devLogin = require('../../auth/dev-login');
  app = await startApp([['/auth', google.router], ['/auth', devLogin.router]]);
});

test.after(() => app.close());

test('exchanging a login code returns a JWT for that user', async () => {
  const { userId } = await seedBot(pool);
  const res = await post('/exchange', { code: codes.issueLoginCode(userId) });
  assert.equal(res.status, 200);
  const { token, user } = await res.json();
  assert.equal(jwt.verify(token, process.env.JWT_SECRET).sub, userId);
  assert.equal(user.id, userId);
});

test('a login code works only once', async () => {
  const { userId } = await seedBot(pool);
  const code = codes.issueLoginCode(userId);
  assert.equal((await post('/exchange', { code })).status, 200);
  assert.equal((await post('/exchange', { code })).status, 401);
});

test('unknown or missing codes are rejected', async () => {
  assert.equal((await post('/exchange', { code: 'f'.repeat(64) })).status, 401);
  assert.equal((await post('/exchange', {})).status, 400);
});

test('codes expire after 60 seconds', () => {
  const code = codes.issueLoginCode('00000000-0000-0000-0000-000000000001');
  assert.equal(codes.redeemLoginCode(code, Date.now() + 61_000), null);
  const fresh = codes.issueLoginCode('00000000-0000-0000-0000-000000000001');
  assert.equal(codes.redeemLoginCode(fresh, Date.now() + 59_000), '00000000-0000-0000-0000-000000000001');
});

test('the Google callback redirect carries a code, never the JWT', () => {
  const url = new URL(google.callbackRedirectUrl('00000000-0000-0000-0000-000000000002'));
  assert.equal(url.origin + url.pathname, 'http://localhost:5173/auth/callback');
  assert.match(url.searchParams.get('code'), /^[0-9a-f]{64}$/);
  assert.equal(url.searchParams.get('token'), null);
  assert.equal(url.searchParams.get('email'), null);
});

test('Google sign-in explains when it is not configured', async () => {
  await withEnv({ GOOGLE_CLIENT_ID: 'your_google_client_id.apps.googleusercontent.com' }, async () => {
    assert.equal(google.isGoogleConfigured(), false);
    const res = await fetch(`${app.base}/auth/google`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://localhost:5173/login?error=google_not_configured');
  });
});

test('dev sign-in is off by default', async () => {
  await withEnv({ NODE_ENV: 'development', DEV_LOGIN: '' }, async () => {
    assert.deepEqual(await (await fetch(`${app.base}/auth/dev-login`)).json(), { enabled: false });
    assert.equal((await post('/dev-login')).status, 404);
  });
});

test('dev sign-in works when enabled in development', async () => {
  await withEnv({ NODE_ENV: 'development', DEV_LOGIN: 'true' }, async () => {
    assert.deepEqual(await (await fetch(`${app.base}/auth/dev-login`)).json(), { enabled: true });

    const first = await post('/dev-login');
    assert.equal(first.status, 200);
    const { user } = await (await post('/exchange', { code: (await first.json()).code })).json();
    assert.equal(user.email, 'dev@botforge.local');

    const again = await (await post('/exchange', { code: (await (await post('/dev-login')).json()).code })).json();
    assert.equal(again.user.id, user.id);
  });
});

test('dev sign-in stays off in production even with DEV_LOGIN=true', async () => {
  await withEnv({ NODE_ENV: 'production', DEV_LOGIN: 'true' }, async () => {
    assert.equal((await post('/dev-login')).status, 404);
    assert.deepEqual(await (await fetch(`${app.base}/auth/dev-login`)).json(), { enabled: false });
  });
});

test('only loopback addresses count as local', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(devLogin.isLoopbackAddress(ip), true, ip);
  for (const ip of ['10.0.0.2', '192.168.1.5', '::ffff:10.0.0.2', '', undefined]) assert.equal(devLogin.isLoopbackAddress(ip), false, String(ip));
});
