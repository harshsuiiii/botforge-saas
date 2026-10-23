'use strict';

/**
 * analytics.js
 * ────────────
 * BotForge – Analytics API Router
 *
 * All routes require a valid BotForge JWT (req.user.sub = user UUID).
 * Every query joins through bots.user_id so users only ever see their own data.
 *
 * Routes
 * ──────
 *  GET /api/analytics/overview          – aggregate KPIs + time-series
 *  GET /api/analytics/sessions          – paginated session list
 *  GET /api/analytics/sessions/:id      – full session transcript
 *  GET /api/analytics/topics            – top detected / blocked topics
 */

const express = require('express');
const { query: qv, param, validationResult } = require('express-validator');

const pool               = require('../auth/db');
const { authMiddleware } = require('../auth/middleware');

const router = express.Router();

// All analytics routes require authentication
router.use(authMiddleware);

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_RANGES   = [7, 30, 90];
const PAGE_SIZE      = 20;
const MAX_PAGE_SIZE  = 100;

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Abort with 400 if express-validator found errors.
 */
function rejectInvalid(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed.', details: errors.array() });
  }
  next();
}

/**
 * Convert a ?range= query param to a Postgres INTERVAL literal.
 * Falls back to 30 days if the value is not in VALID_RANGES.
 *
 * @param {string|number|undefined} range
 * @returns {string}  e.g. '7 days'
 */
function rangeToInterval(range) {
  const days = VALID_RANGES.includes(Number(range)) ? Number(range) : 30;
  return `${days} days`;
}

/**
 * Build the SQL fragment that restricts sessions to bots owned by userId.
 * When botId is supplied it is additionally filtered.
 *
 * Returns: { whereClause, params }
 * Caller MUST offset their own $N params by params.length.
 *
 * @param {string}      userId
 * @param {string|null} botId
 * @param {string}      interval  – e.g. '7 days'
 * @returns {{ whereClause: string, params: any[] }}
 */
function buildOwnershipWhere(userId, botId, interval) {
  const params = [userId, interval];
  let clause = `
    JOIN bots b ON b.id = s.bot_id
    WHERE b.user_id   = $1
      AND b.deleted_at IS NULL
      AND s.started_at >= NOW() - $2::INTERVAL`;

  if (botId) {
    params.push(botId);
    clause += `\n      AND s.bot_id = $${params.length}`;
  }

  return { whereClause: clause, params };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 – GET /api/analytics/overview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/analytics/overview?bot_id=&range=7|30|90
 *
 * Returns:
 *  {
 *    total_messages       : number,
 *    unique_users         : number,
 *    avg_turns_per_session: number,
 *    blocked_count        : number,
 *    resolution_rate      : { resolved, escalated, abandoned }  // % strings
 *    daily_message_volume : [{ date, count }]                   // filled for full range
 *    sessions_by_hour     : [{ hour, count }]                   // 24 buckets 0–23
 *  }
 */
router.get(
  '/overview',
  [
    qv('bot_id').optional().isUUID().withMessage('bot_id must be a valid UUID.'),
    qv('range').optional().isIn(['7', '30', '90']).withMessage('range must be 7, 30, or 90.'),
  ],
  rejectInvalid,
  async (req, res) => {
    const userId   = req.user.sub;
    const botId    = req.query.bot_id || null;
    const interval = rangeToInterval(req.query.range);

    const { whereClause, params } = buildOwnershipWhere(userId, botId, interval);
    const nextIdx = params.length + 1; // next available $N

    try {
      // ── Query A: Core aggregates ────────────────────────────────────────
      //
      // SQL:
      //   SELECT
      //     COALESCE(SUM(s.turn_count), 0)                          AS total_messages,
      //     COUNT(DISTINCT s.user_fingerprint)                       AS unique_users,
      //     ROUND(AVG(s.turn_count)::NUMERIC, 2)                     AS avg_turns_per_session,
      //     COUNT(*) FILTER (WHERE s.blocked = true)                 AS blocked_count,
      //     COUNT(*) FILTER (WHERE s.outcome = 'resolved')           AS resolved_count,
      //     COUNT(*) FILTER (WHERE s.outcome = 'escalated')          AS escalated_count,
      //     COUNT(*) FILTER (WHERE s.outcome = 'abandoned')          AS abandoned_count,
      //     COUNT(*)                                                  AS total_sessions
      //   FROM sessions s
      //   JOIN bots b ON b.id = s.bot_id
      //   WHERE b.user_id = $1 AND b.deleted_at IS NULL
      //     AND s.started_at >= NOW() - $2::INTERVAL
      //     [AND s.bot_id = $3]
      //
      const aggregateSQL = `
        SELECT
          COALESCE(SUM(s.turn_count), 0)                        AS total_messages,
          COUNT(DISTINCT s.user_fingerprint)                     AS unique_users,
          ROUND(AVG(s.turn_count)::NUMERIC, 2)                   AS avg_turns_per_session,
          COUNT(*) FILTER (WHERE s.blocked = true)               AS blocked_count,
          COUNT(*) FILTER (WHERE s.outcome = 'resolved')         AS resolved_count,
          COUNT(*) FILTER (WHERE s.outcome = 'escalated')        AS escalated_count,
          COUNT(*) FILTER (WHERE s.outcome = 'abandoned')        AS abandoned_count,
          COUNT(*)                                                AS total_sessions
        FROM sessions s
        ${whereClause}
      `;

      // ── Query B: Daily message volume ───────────────────────────────────
      //
      // Generates a complete date series for the range (no gaps) by cross-joining
      // with generate_series, then LEFT JOINs actual session data.
      //
      // SQL:
      //   WITH date_series AS (
      //     SELECT generate_series(
      //       date_trunc('day', NOW() - $2::INTERVAL),
      //       date_trunc('day', NOW()),
      //       '1 day'::INTERVAL
      //     )::DATE AS day
      //   ),
      //   daily AS (
      //     SELECT date_trunc('day', s.started_at)::DATE AS day,
      //            SUM(s.turn_count) AS msg_count
      //     FROM sessions s
      //     JOIN bots b ON b.id = s.bot_id
      //     WHERE b.user_id = $1 AND b.deleted_at IS NULL
      //       AND s.started_at >= NOW() - $2::INTERVAL
      //       [AND s.bot_id = $3]
      //     GROUP BY 1
      //   )
      //   SELECT ds.day AS date,
      //          COALESCE(d.msg_count, 0) AS count
      //   FROM date_series ds
      //   LEFT JOIN daily d USING (day)
      //   ORDER BY ds.day
      //
      const dailySQL = `
        WITH date_series AS (
          SELECT generate_series(
            date_trunc('day', NOW() - $2::INTERVAL),
            date_trunc('day', NOW()),
            '1 day'::INTERVAL
          )::DATE AS day
        ),
        daily AS (
          SELECT date_trunc('day', s.started_at)::DATE AS day,
                 SUM(s.turn_count) AS msg_count
          FROM sessions s
          ${whereClause}
          GROUP BY 1
        )
        SELECT ds.day  AS date,
               COALESCE(d.msg_count, 0) AS count
        FROM date_series ds
        LEFT JOIN daily d USING (day)
        ORDER BY ds.day
      `;

      // ── Query C: Sessions by hour of day (0–23) ─────────────────────────
      //
      // Fills all 24 hour buckets even if some have zero sessions.
      //
      // SQL:
      //   WITH hour_series AS (
      //     SELECT generate_series(0, 23) AS hour
      //   ),
      //   hourly AS (
      //     SELECT EXTRACT(HOUR FROM s.started_at)::INT AS hour,
      //            COUNT(*)                              AS cnt
      //     FROM sessions s
      //     JOIN bots b ON b.id = s.bot_id
      //     WHERE b.user_id = $1 AND b.deleted_at IS NULL
      //       AND s.started_at >= NOW() - $2::INTERVAL
      //       [AND s.bot_id = $3]
      //     GROUP BY 1
      //   )
      //   SELECT hs.hour,
      //          COALESCE(h.cnt, 0) AS count
      //   FROM hour_series hs
      //   LEFT JOIN hourly h USING (hour)
      //   ORDER BY hs.hour
      //
      const hourlySQL = `
        WITH hour_series AS (
          SELECT generate_series(0, 23) AS hour
        ),
        hourly AS (
          SELECT EXTRACT(HOUR FROM s.started_at)::INT AS hour,
                 COUNT(*)                              AS cnt
          FROM sessions s
          ${whereClause}
          GROUP BY 1
        )
        SELECT hs.hour,
               COALESCE(h.cnt, 0) AS count
        FROM hour_series hs
        LEFT JOIN hourly h USING (hour)
        ORDER BY hs.hour
      `;

      // Run all three queries in parallel
      const [aggResult, dailyResult, hourlyResult] = await Promise.all([
        pool.query(aggregateSQL, params),
        pool.query(dailySQL, params),
        pool.query(hourlySQL, params),
      ]);

      const agg = aggResult.rows[0];
      const totalSessions = Number(agg.total_sessions) || 0;

      /**
       * Calculate a percentage of total_sessions, rounded to 1 decimal place.
       * Returns the string "0.0" when total_sessions is 0 to avoid division by zero.
       */
      function pct(count) {
        if (!totalSessions) return '0.0';
        return ((Number(count) / totalSessions) * 100).toFixed(1);
      }

      return res.json({
        total_messages        : Number(agg.total_messages),
        unique_users          : Number(agg.unique_users),
        avg_turns_per_session : Number(agg.avg_turns_per_session ?? 0),
        blocked_count         : Number(agg.blocked_count),
        resolution_rate: {
          resolved  : pct(agg.resolved_count),
          escalated : pct(agg.escalated_count),
          abandoned : pct(agg.abandoned_count),
        },
        daily_message_volume: dailyResult.rows.map((r) => ({
          date : r.date,             // JS Date object; JSON.stringify → ISO string
          count: Number(r.count),
        })),
        sessions_by_hour: hourlyResult.rows.map((r) => ({
          hour : Number(r.hour),
          count: Number(r.count),
        })),
      });
    } catch (err) {
      console.error('[analytics] overview error:', err.message);
      return res.status(500).json({ error: 'Failed to load overview analytics.' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 – GET /api/analytics/sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/analytics/sessions?bot_id=&range=&search=&outcome=&blocked=&page=&limit=
 *
 * Returns:
 *  {
 *    sessions : [{ session_id, started_at, ended_at, turn_count, outcome,
 *                  blocked, topics_detected, bot_id, bot_name }],
 *    pagination: { page, limit, total, total_pages }
 *  }
 *
 * Filters:
 *   search  – full-text search across messages JSONB (content field)
 *   outcome – 'resolved' | 'escalated' | 'abandoned' | 'blocked'
 *   blocked – 'true' | 'false'
 *   page    – 1-based page number (default 1)
 *   limit   – rows per page (default 20, max 100)
 */
router.get(
  '/sessions',
  [
    qv('bot_id').optional().isUUID(),
    qv('range').optional().isIn(['7', '30', '90']),
    qv('outcome').optional().isIn(['resolved', 'escalated', 'abandoned', 'blocked']),
    qv('blocked').optional().isIn(['true', 'false']),
    qv('search').optional().isString().trim().isLength({ max: 200 }),
    qv('page').optional().isInt({ min: 1 }).toInt(),
    qv('limit').optional().isInt({ min: 1, max: MAX_PAGE_SIZE }).toInt(),
  ],
  rejectInvalid,
  async (req, res) => {
    const userId   = req.user.sub;
    const botId    = req.query.bot_id   || null;
    const interval = rangeToInterval(req.query.range);
    const search   = req.query.search   || null;
    const outcome  = req.query.outcome  || null;
    const blocked  = req.query.blocked  !== undefined
      ? req.query.blocked === 'true'
      : null;
    const page     = req.query.page  || 1;
    const limit    = req.query.limit || PAGE_SIZE;
    const offset   = (page - 1) * limit;

    // Build dynamic WHERE conditions
    const params  = [userId, interval];
    let   botJoin = `JOIN bots b ON b.id = s.bot_id`;
    let   where   = `WHERE b.user_id = $1 AND b.deleted_at IS NULL AND s.started_at >= NOW() - $2::INTERVAL`;

    if (botId) {
      params.push(botId);
      where += ` AND s.bot_id = $${params.length}`;
    }
    if (outcome) {
      params.push(outcome);
      where += ` AND s.outcome = $${params.length}::session_outcome`;
    }
    if (blocked !== null) {
      params.push(blocked);
      where += ` AND s.blocked = $${params.length}`;
    }
    if (search) {
      // Search the 'content' field inside the messages JSONB array.
      //
      // SQL fragment:
      //   AND EXISTS (
      //     SELECT 1 FROM jsonb_array_elements(s.messages) AS m
      //     WHERE m->>'content' ILIKE '%<search>%'
      //   )
      //
      // This is a targeted scan of the JSONB array; for high-traffic deployments
      // replace with a generated tsvector column + GIN index on messages.
      params.push(`%${search}%`);
      where += ` AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.messages) AS m
        WHERE m->>'content' ILIKE $${params.length}
      )`;
    }

    // ── SQL: count total matching rows ────────────────────────────────────
    //
    //   SELECT COUNT(*) AS total
    //   FROM sessions s
    //   JOIN bots b ON b.id = s.bot_id
    //   WHERE b.user_id = $1 AND b.deleted_at IS NULL
    //     AND s.started_at >= NOW() - $2::INTERVAL
    //     [AND s.bot_id = $N] [AND s.outcome = $N] [AND s.blocked = $N]
    //     [AND EXISTS (...)]
    //
    const countSQL = `SELECT COUNT(*) AS total FROM sessions s ${botJoin} ${where}`;

    // ── SQL: paginated session list ───────────────────────────────────────
    //
    //   SELECT s.session_id, s.started_at, s.ended_at,
    //          s.turn_count, s.outcome, s.blocked, s.topics_detected,
    //          b.id AS bot_id, b.name AS bot_name
    //   FROM sessions s
    //   JOIN bots b ON b.id = s.bot_id
    //   WHERE ...
    //   ORDER BY s.started_at DESC
    //   LIMIT $N OFFSET $N
    //
    params.push(limit, offset);
    const listSQL = `
      SELECT s.session_id,
             s.started_at,
             s.ended_at,
             s.turn_count,
             s.outcome,
             s.blocked,
             s.topics_detected,
             b.id   AS bot_id,
             b.name AS bot_name
      FROM sessions s
      ${botJoin}
      ${where}
      ORDER BY s.started_at DESC
      LIMIT  $${params.length - 1}
      OFFSET $${params.length}
    `;

    try {
      const [countResult, listResult] = await Promise.all([
        pool.query(countSQL, params.slice(0, -2)), // count query doesn't need LIMIT/OFFSET
        pool.query(listSQL, params),
      ]);

      const total = Number(countResult.rows[0].total);

      return res.json({
        sessions: listResult.rows,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.error('[analytics] sessions list error:', err.message);
      return res.status(500).json({ error: 'Failed to load sessions.' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 – GET /api/analytics/sessions/:session_id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/analytics/sessions/:session_id
 *
 * Returns the full session transcript with all messages.
 * Ownership enforced via JOIN on bots.user_id.
 *
 * Returns:
 *  {
 *    session_id, bot_id, bot_name, user_fingerprint,
 *    started_at, ended_at, turn_count, outcome, blocked,
 *    topics_detected, messages: [{ role, content, ts }]
 *  }
 */
router.get(
  '/sessions/:session_id',
  param('session_id').isUUID().withMessage('session_id must be a valid UUID.'),
  rejectInvalid,
  async (req, res) => {
    const userId    = req.user.sub;
    const sessionId = req.params.session_id;

    // ── SQL ────────────────────────────────────────────────────────────────
    //
    //   SELECT s.session_id, s.user_fingerprint,
    //          s.started_at, s.ended_at, s.turn_count,
    //          s.outcome, s.blocked, s.topics_detected,
    //          s.messages,
    //          b.id   AS bot_id,
    //          b.name AS bot_name
    //   FROM sessions s
    //   JOIN bots b ON b.id = s.bot_id
    //   WHERE s.session_id = $1
    //     AND b.user_id    = $2
    //     AND b.deleted_at IS NULL
    //
    const sql = `
      SELECT s.session_id,
             s.user_fingerprint,
             s.started_at,
             s.ended_at,
             s.turn_count,
             s.outcome,
             s.blocked,
             s.topics_detected,
             s.messages,
             b.id   AS bot_id,
             b.name AS bot_name
      FROM sessions s
      JOIN bots b ON b.id = s.bot_id
      WHERE s.session_id = $1
        AND b.user_id    = $2
        AND b.deleted_at IS NULL
    `;

    try {
      const { rows } = await pool.query(sql, [sessionId, userId]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Session not found.' });
      }

      return res.json({ session: rows[0] });
    } catch (err) {
      console.error('[analytics] session transcript error:', err.message);
      return res.status(500).json({ error: 'Failed to load session transcript.' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4 – GET /api/analytics/topics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/analytics/topics?bot_id=&range=7|30|90
 *
 * Returns:
 *  {
 *    top_detected : [{ topic, count }]   // top 10 across all sessions
 *    top_blocked  : [{ topic, count }]   // top 10 in blocked sessions only
 *  }
 *
 * Uses unnest(topics_detected) to expand the text[] column into individual rows,
 * then aggregates by frequency.
 */
router.get(
  '/topics',
  [
    qv('bot_id').optional().isUUID(),
    qv('range').optional().isIn(['7', '30', '90']),
  ],
  rejectInvalid,
  async (req, res) => {
    const userId   = req.user.sub;
    const botId    = req.query.bot_id || null;
    const interval = rangeToInterval(req.query.range);

    const { whereClause, params } = buildOwnershipWhere(userId, botId, interval);

    // ── SQL: top detected topics (all sessions) ────────────────────────────
    //
    //   SELECT t.topic, COUNT(*) AS count
    //   FROM sessions s
    //   CROSS JOIN LATERAL unnest(s.topics_detected) AS t(topic)
    //   JOIN bots b ON b.id = s.bot_id
    //   WHERE b.user_id = $1 AND b.deleted_at IS NULL
    //     AND s.started_at >= NOW() - $2::INTERVAL
    //     [AND s.bot_id = $3]
    //     AND t.topic <> ''
    //   GROUP BY t.topic
    //   ORDER BY count DESC
    //   LIMIT 10
    //
    // The lateral unnest must sit in the FROM list before whereClause, because
    // whereClause carries both the bots JOIN and the WHERE keyword.
    //
    const detectedSQL = `
      SELECT t.topic,
             COUNT(*) AS count
      FROM sessions s
      CROSS JOIN LATERAL unnest(s.topics_detected) AS t(topic)
      ${whereClause}
        AND t.topic <> ''
      GROUP BY t.topic
      ORDER BY count DESC
      LIMIT 10
    `;

    // ── SQL: top blocked topic attempts (blocked sessions only) ────────────
    //
    // Same shape but additionally filters WHERE s.blocked = true.
    // This reveals which block-list keywords are being hit most often.
    //
    //   SELECT t.topic, COUNT(*) AS count
    //   FROM sessions s
    //   CROSS JOIN LATERAL unnest(s.topics_detected) AS t(topic)
    //   JOIN bots b ON b.id = s.bot_id
    //   WHERE b.user_id = $1 AND b.deleted_at IS NULL
    //     AND s.started_at >= NOW() - $2::INTERVAL
    //     [AND s.bot_id = $3]
    //     AND s.blocked = true
    //     AND t.topic <> ''
    //   GROUP BY t.topic
    //   ORDER BY count DESC
    //   LIMIT 10
    //
    const blockedSQL = `
      SELECT t.topic,
             COUNT(*) AS count
      FROM sessions s
      CROSS JOIN LATERAL unnest(s.topics_detected) AS t(topic)
      ${whereClause}
        AND s.blocked = true
        AND t.topic <> ''
      GROUP BY t.topic
      ORDER BY count DESC
      LIMIT 10
    `;

    try {
      const [detectedResult, blockedResult] = await Promise.all([
        pool.query(detectedSQL, params),
        pool.query(blockedSQL, params),
      ]);

      return res.json({
        top_detected : detectedResult.rows.map((r) => ({
          topic : r.topic,
          count : Number(r.count),
        })),
        top_blocked  : blockedResult.rows.map((r) => ({
          topic : r.topic,
          count : Number(r.count),
        })),
      });
    } catch (err) {
      console.error('[analytics] topics error:', err.message);
      return res.status(500).json({ error: 'Failed to load topic analytics.' });
    }
  },
);

module.exports = router;
