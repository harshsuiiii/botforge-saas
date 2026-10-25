'use strict';

/**
 * routes.js
 * ─────────
 * BotForge – owner-only catalog API, mounted at /api/bots/:id/catalog
 *
 *  GET    /sources                 – list this bot's sources
 *  POST   /sources                 – upload a file (multipart "file") or { url }
 *  POST   /sources/:sid/resync     – re-crawl a URL, or re-import with a new file
 *  DELETE /sources/:sid            – remove a source with its products and info
 *  GET    /products                – paginated preview of imported products
 */

const path    = require('path');
const express = require('express');
const multer  = require('multer');
const { query: qv, validationResult } = require('express-validator');

const pool                 = require('../auth/db');
const { authMiddleware }   = require('../auth/middleware');
const { getOwnerToken }    = require('../auth/token-crypto');
const { loadOwnedBot, UUID_RE } = require('../bots/ownership');
const { assertPublicUrl }  = require('./url-guard');
const { runIngest, NO_TOKEN_MESSAGE } = require('./ingest');

const router = express.Router({ mergeParams: true });

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const KIND_BY_EXTENSION = { '.csv': 'spreadsheet', '.xlsx': 'spreadsheet', '.pdf': 'pdf' };
// Browsers and operating systems label CSV files inconsistently; the parser
// validates the content, so generic types are accepted for .csv / .xlsx.
const ALLOWED_MIME = {
  '.csv' : ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv', 'text/x-csv', 'application/octet-stream'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
  '.pdf' : ['application/pdf'],
};

const RUNNING_IMPORT_MESSAGE = 'An import is already running for this bot.';

/** Unique violation of uq_catalog_sources_one_running: another import won the race. */
const isRunningImportConflict = (err) => err?.code === '23505';

const SOURCE_COLUMNS = 'id, kind, name, status, error, item_count, last_synced_at, created_at, updated_at';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

/** multer with JSON errors instead of Express's HTML error page. */
function acceptFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File is larger than 10 MB.' });
    }
    return res.status(400).json({ error: 'Upload a single file in the "file" field.' });
  });
}

/** @returns {{ kind: string } | { error: string }} */
function classifyFile(file) {
  const ext = path.extname(file.originalname ?? '').toLowerCase();
  const kind = KIND_BY_EXTENSION[ext];
  if (!kind || !ALLOWED_MIME[ext].includes(file.mimetype)) {
    return { error: 'Upload a CSV, XLSX or PDF file.' };
  }
  return { kind };
}

function rejectInvalid(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed.', details: errors.array() });
  }
  next();
}

/** 409 without an OpenAI token, 429 while another import runs; null when OK. */
async function preflight(bot) {
  if (!(await getOwnerToken(bot.user_id))) {
    return { status: 409, error: NO_TOKEN_MESSAGE };
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM catalog_sources WHERE bot_id = $1 AND status IN ('pending', 'processing') LIMIT 1`,
    [bot.id],
  );
  if (rows.length) return { status: 429, error: RUNNING_IMPORT_MESSAGE };
  return null;
}

function startIngest(sourceId, payload) {
  setImmediate(() => runIngest(sourceId, payload));
}

router.use(authMiddleware, loadOwnedBot);

// ─── GET /sources ─────────────────────────────────────────────────────────────

router.get('/sources', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SOURCE_COLUMNS} FROM catalog_sources WHERE bot_id = $1 ORDER BY created_at DESC`,
      [req.bot.id],
    );
    return res.json({ sources: rows });
  } catch (err) {
    console.error('[catalog] list sources error:', err.message);
    return res.status(500).json({ error: 'Failed to list catalog sources.' });
  }
});

// ─── POST /sources ────────────────────────────────────────────────────────────

router.post('/sources', acceptFile, async (req, res) => {
  try {
    let kind;
    let name;
    let payload;

    if (req.file) {
      const classified = classifyFile(req.file);
      if (classified.error) return res.status(400).json({ error: classified.error });
      kind    = classified.kind;
      name    = req.file.originalname;
      payload = { buffer: req.file.buffer, filename: req.file.originalname };
    } else if (typeof req.body?.url === 'string' && req.body.url.trim()) {
      let parsed;
      try {
        parsed = await assertPublicUrl(req.body.url.trim());
      } catch {
        return res.status(400).json({ error: 'That URL cannot be imported.' });
      }
      kind    = 'url';
      name    = parsed.href;
      payload = { url: parsed.href };
    } else {
      return res.status(400).json({ error: 'Upload a file or provide a url.' });
    }

    const blocked = await preflight(req.bot);
    if (blocked) return res.status(blocked.status).json({ error: blocked.error });

    const { rows: [source] } = await pool.query(
      `INSERT INTO catalog_sources (bot_id, kind, name) VALUES ($1, $2, $3) RETURNING ${SOURCE_COLUMNS}`,
      [req.bot.id, kind, name],
    );
    startIngest(source.id, payload);
    return res.status(202).json({ source });
  } catch (err) {
    if (isRunningImportConflict(err)) return res.status(429).json({ error: RUNNING_IMPORT_MESSAGE });
    console.error('[catalog] create source error:', err.message);
    return res.status(500).json({ error: 'Failed to start the import.' });
  }
});

// ─── POST /sources/:sid/resync ────────────────────────────────────────────────

router.post('/sources/:sid/resync', acceptFile, async (req, res) => {
  if (!UUID_RE.test(req.params.sid)) return res.status(400).json({ error: 'sid must be a valid UUID.' });

  try {
    const { rows } = await pool.query(
      `SELECT ${SOURCE_COLUMNS} FROM catalog_sources WHERE id = $1 AND bot_id = $2`,
      [req.params.sid, req.bot.id],
    );
    const source = rows[0];
    if (!source) return res.status(404).json({ error: 'Catalog source not found.' });

    let payload;
    if (source.kind === 'url') {
      try {
        await assertPublicUrl(source.name);
      } catch {
        return res.status(400).json({ error: 'That URL cannot be imported.' });
      }
      payload = { url: source.name };
    } else {
      if (!req.file) return res.status(400).json({ error: 'Upload the new version of this file.' });
      const classified = classifyFile(req.file);
      if (classified.error) return res.status(400).json({ error: classified.error });
      if (classified.kind !== source.kind) {
        return res.status(400).json({ error: `This source expects a ${source.kind} file.` });
      }
      payload = { buffer: req.file.buffer, filename: req.file.originalname };
    }

    const blocked = await preflight(req.bot);
    if (blocked) return res.status(blocked.status).json({ error: blocked.error });

    const { rows: [updated] } = await pool.query(
      `UPDATE catalog_sources SET status = 'pending', error = NULL, name = $3
       WHERE id = $1 AND bot_id = $2
       RETURNING ${SOURCE_COLUMNS}`,
      [source.id, req.bot.id, payload.filename ?? source.name],
    );
    startIngest(source.id, payload);
    return res.status(202).json({ source: updated });
  } catch (err) {
    if (isRunningImportConflict(err)) return res.status(429).json({ error: RUNNING_IMPORT_MESSAGE });
    console.error('[catalog] resync error:', err.message);
    return res.status(500).json({ error: 'Failed to start the re-sync.' });
  }
});

// ─── DELETE /sources/:sid ─────────────────────────────────────────────────────

router.delete('/sources/:sid', async (req, res) => {
  if (!UUID_RE.test(req.params.sid)) return res.status(400).json({ error: 'sid must be a valid UUID.' });

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM catalog_sources WHERE id = $1 AND bot_id = $2',
      [req.params.sid, req.bot.id],
    );
    if (!rowCount) return res.status(404).json({ error: 'Catalog source not found.' });
    return res.status(204).send();
  } catch (err) {
    console.error('[catalog] delete source error:', err.message);
    return res.status(500).json({ error: 'Failed to delete the catalog source.' });
  }
});

// ─── GET /products ────────────────────────────────────────────────────────────

router.get(
  '/products',
  [
    qv('search').optional().isString().trim().isLength({ max: 200 }),
    qv('page').optional().isInt({ min: 1 }).toInt(),
    qv('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  rejectInvalid,
  async (req, res) => {
    const page   = req.query.page  || 1;
    const limit  = req.query.limit || 20;
    const search = req.query.search ? `%${req.query.search}%` : null;

    try {
      const [countResult, listResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total FROM catalog_products
           WHERE bot_id = $1 AND ($2::text IS NULL OR name ILIKE $2::text)`,
          [req.bot.id, search],
        ),
        pool.query(
          `SELECT id, source_id, name, category, description, price, currency, in_stock,
                  url, image_url, attributes, updated_at
           FROM catalog_products
           WHERE bot_id = $1 AND ($2::text IS NULL OR name ILIKE $2::text)
           ORDER BY name
           LIMIT $3 OFFSET $4`,
          [req.bot.id, search, limit, (page - 1) * limit],
        ),
      ]);

      const total = countResult.rows[0].total;
      return res.json({
        products  : listResult.rows.map((p) => ({ ...p, price: p.price === null ? null : Number(p.price) })),
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('[catalog] products preview error:', err.message);
      return res.status(500).json({ error: 'Failed to load catalog products.' });
    }
  },
);

module.exports = router;
