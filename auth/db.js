'use strict';

const { Pool } = require('pg');

/**
 * Shared connection pool — imported by all auth sub-modules.
 * Configure via DATABASE_URL or individual PG* env vars.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
});

pool.on('error', (err) => {
  console.error('[pg] Unexpected pool error:', err.message);
});

module.exports = pool;
