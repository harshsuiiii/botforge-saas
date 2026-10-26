'use strict';

require('dotenv').config();

const express  = require('express');
const passport = require('passport');

const { router: googleAuthRouter, isGoogleConfigured } = require('./auth/google');
const { router: devLoginRouter } = require('./auth/dev-login');
const openaiKeyRouter = require('./auth/openai-key');
const { router: openaiRouter } = require('./auth/openai-project');
const botsRouter      = require('./bots/bots');
const analyticsRouter = require('./analytics/analytics');
const chatRouter      = require('./chat/chat');
const catalogRouter   = require('./catalog/routes');
const { recoverInterruptedImports } = require('./catalog/ingest');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Mounted before the dashboard CORS middleware below: the widget calls /chat
// from customer origins, and the chat router answers its own preflights.
app.use('/chat', chatRouter);

app.use((req, res, next) => {
  const origin = process.env.FRONTEND_URL || 'http://localhost:5173';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(passport.initialize());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', googleAuthRouter);
app.use('/auth', devLoginRouter);
app.use('/auth', openaiKeyRouter);
app.use('/openai', openaiRouter);
app.use('/api/bots/:id/catalog', catalogRouter);
app.use('/api/bots', botsRouter);
app.use('/api/analytics', analyticsRouter);
app.use(express.static('public'));

app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`BotForge API listening on http://localhost:${PORT}`);

  recoverInterruptedImports()
    .then((count) => { if (count) console.warn(`[catalog] Marked ${count} interrupted import(s) as failed.`); })
    .catch((err) => console.error('[catalog] Could not recover interrupted imports:', err.message));

  if (!isGoogleConfigured()) {
    console.warn(
      '\n⚠  Google OAuth is not configured.\n' +
      '   Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env\n' +
      '   Create credentials: https://console.cloud.google.com/apis/credentials\n' +
      `   Redirect URI must be: ${process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`}\n`,
    );
  }

  if (process.env.DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production') {
    console.warn('⚠  DEV_LOGIN is on: "Continue as dev user" signs in without Google (localhost only).\n');
  }
});
