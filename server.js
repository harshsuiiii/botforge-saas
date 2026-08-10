'use strict';

require('dotenv').config();

const express  = require('express');
const passport = require('passport');

const { router: googleAuthRouter } = require('./auth/google');
const openaiOAuthRouter = require('./auth/openai-oauth');
const { router: openaiRouter } = require('./auth/openai-project');
const botsRouter      = require('./bots/bots');
const analyticsRouter = require('./analytics/analytics');
const chatRouter      = require('./chat/chat');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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
app.use('/auth', openaiOAuthRouter);
app.use('/openai', openaiRouter);
app.use('/api/bots', botsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/chat', chatRouter);
app.use(express.static('public'));

app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`BotForge API listening on http://localhost:${PORT}`);

  const googleId = process.env.GOOGLE_CLIENT_ID ?? '';
  if (!googleId || googleId.includes('your_google_client_id')) {
    console.warn(
      '\n⚠  Google OAuth is not configured.\n' +
      '   Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env\n' +
      '   Create credentials: https://console.cloud.google.com/apis/credentials\n' +
      '   Redirect URI must be: http://localhost:3000/auth/google/callback\n',
    );
  }
});
