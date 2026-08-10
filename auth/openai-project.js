'use strict';

/**
 * openai-project.js
 * ─────────────────
 * BotForge – OpenAI Project Automation Module
 *
 * Responsibilities
 * ────────────────
 *  1. Decrypt the user's OpenAI token from the DB (AES-256-GCM).
 *  2. Create a new OpenAI Project named after the bot.
 *  3. Persist the returned project_id in the bots table.
 *  4. Apply the bot's spend_cap as a monthly cost limit.
 *  5. Pin the project's default model to gpt-4o-mini.
 *
 * Required ENV vars (see .env.example)
 * ──────────────────────────────────────
 *  TOKEN_ENCRYPTION_KEY   – 32-byte hex string (AES-256 key)
 *  DATABASE_URL           – Postgres connection string
 *
 * OpenAI Management API base: https://api.openai.com/v1
 * All management endpoints require the Authorization header:
 *   Authorization: Bearer <user_openai_token>
 *
 * NOTE: The Management API (organization/projects, billing/limits)
 * is available to organisation owners and requires an org-scoped key.
 */

const crypto = require('crypto');
const pool   = require('./db');   // shared pg Pool from auth/db.js

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_BASE_URL   = 'https://api.openai.com/v1';
const MANAGEMENT_ENDPOINTS = {
  /** Create a new project inside the organisation */
  createProject : `${OPENAI_BASE_URL}/organization/projects`,
  /** GET/POST spend limits for a project */
  billingLimits : (projectId) =>
    `${OPENAI_BASE_URL}/organization/projects/${projectId}/rate_limits`,
  /** Update project-level settings (default model etc.) */
  projectSettings: (projectId) =>
    `${OPENAI_BASE_URL}/organization/projects/${projectId}`,
};

const DEFAULT_MODEL    = 'gpt-4o-mini';
const ENCRYPTION_ALGO  = 'aes-256-gcm';

// ─── Crypto helpers ───────────────────────────────────────────────────────────

/**
 * Derive a 32-byte Buffer from the hex env var TOKEN_ENCRYPTION_KEY.
 * Throws at call time rather than at module load so the error is traceable.
 */
function getEncryptionKey() {
  const hexKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).',
    );
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * Decrypt an AES-256-GCM ciphertext stored in the openai_tokens table.
 *
 * @param {Buffer} encryptedToken – ciphertext || auth-tag (last 16 bytes are the tag)
 * @param {Buffer} iv             – 12-byte initialisation vector
 * @returns {string}              – plaintext OpenAI API key
 */
function decryptToken(encryptedToken, iv) {
  const key     = getEncryptionKey();
  // Last 16 bytes of the stored blob are the GCM auth tag
  const authTag  = encryptedToken.slice(-16);
  const ciphertext = encryptedToken.slice(0, -16);

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, key, iv);
  decipher.setAuthTag(authTag);

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch the encrypted OpenAI token for a user from the DB.
 *
 * @param {string} userId – UUID
 * @returns {{ encrypted_token: Buffer, iv: Buffer } | null}
 */
async function getEncryptedToken(userId) {
  const { rows } = await pool.query(
    `SELECT encrypted_token, iv
     FROM   openai_tokens
     WHERE  user_id = $1
     ORDER  BY updated_at DESC
     LIMIT  1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Fetch a bot's current configuration (name, spend_cap, user_id).
 *
 * @param {string} botId – UUID
 * @returns {object | null}
 */
async function getBotConfig(botId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, name, spend_cap, openai_project_id
     FROM   bots
     WHERE  id = $1`,
    [botId],
  );
  return rows[0] ?? null;
}

/**
 * Persist an OpenAI project_id back to the bots table.
 *
 * @param {string} botId     – UUID
 * @param {string} projectId – OpenAI project ID string
 */
async function saveProjectId(botId, projectId) {
  await pool.query(
    `UPDATE bots SET openai_project_id = $1 WHERE id = $2`,
    [projectId, botId],
  );
}

// ─── OpenAI API helpers ───────────────────────────────────────────────────────

/**
 * Build the standard headers required by every OpenAI Management API call.
 *
 * @param {string} token – decrypted OpenAI API key (org-scoped)
 * @returns {object}
 */
function buildHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type' : 'application/json',
    'OpenAI-Beta'  : 'assistants=v2',   // required for management endpoints
  };
}

/**
 * POST /v1/organization/projects
 * Create a new OpenAI Project inside the user's organisation.
 *
 * @param {string} token    – decrypted OpenAI key
 * @param {string} botName  – used as the project name
 * @returns {{ id: string, name: string, status: string }}
 * @throws on HTTP errors except 409 Conflict (already exists)
 */
async function createOpenAIProject(token, botName) {
  const res = await fetch(MANAGEMENT_ENDPOINTS.createProject, {
    method : 'POST',
    headers: buildHeaders(token),
    body   : JSON.stringify({ name: botName }),
  });

  // 409 → project name already exists; surface a typed error so callers can handle it
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const err  = new Error(`OpenAI project "${botName}" already exists.`);
    err.code   = 'PROJECT_ALREADY_EXISTS';
    err.openai = body;
    throw err;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err  = new Error(`OpenAI createProject failed: ${res.status} ${res.statusText}`);
    err.code   = 'OPENAI_API_ERROR';
    err.status = res.status;
    err.openai = body;
    throw err;
  }

  return res.json();
}

/**
 * POST /v1/organization/projects/:projectId/rate_limits
 * Apply a monthly cost (spend) cap to the project.
 *
 * OpenAI exposes rate_limits at project level; the "max_request_1d" and
 * "budget_monthly_usd" fields control spend. We set budget_monthly_usd here.
 *
 * @param {string} token     – decrypted OpenAI key
 * @param {string} projectId – OpenAI project ID
 * @param {number} capUsd    – monthly spend cap in USD
 */
async function setProjectSpendCap(token, projectId, capUsd) {
  const res = await fetch(MANAGEMENT_ENDPOINTS.billingLimits(projectId), {
    method : 'POST',
    headers: buildHeaders(token),
    body   : JSON.stringify({
      budget_monthly_usd: capUsd,   // hard monthly USD limit
    }),
  });

  if (res.status === 404) {
    // Billing limits endpoint unavailable → billing not enabled on this org
    const err  = new Error('Billing limits not available: billing may not be enabled for this OpenAI organisation.');
    err.code   = 'BILLING_NOT_ENABLED';
    err.status = 404;
    throw err;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err  = new Error(`OpenAI setSpendCap failed: ${res.status} ${res.statusText}`);
    err.code   = 'OPENAI_API_ERROR';
    err.status = res.status;
    err.openai = body;
    throw err;
  }

  return res.json();
}

/**
 * POST /v1/organization/projects/:projectId  (partial update)
 * Set the project's default model to DEFAULT_MODEL (gpt-4o-mini).
 *
 * @param {string} token     – decrypted OpenAI key
 * @param {string} projectId – OpenAI project ID
 */
async function setProjectDefaultModel(token, projectId) {
  const res = await fetch(MANAGEMENT_ENDPOINTS.projectSettings(projectId), {
    method : 'POST',
    headers: buildHeaders(token),
    body   : JSON.stringify({
      default_model: DEFAULT_MODEL,
    }),
  });

  if (!res.ok) {
    // Non-fatal — default model setting may not be supported on all orgs.
    const body = await res.json().catch(() => ({}));
    console.warn(
      `[openai-project] Could not set default model on project ${projectId}:`,
      res.status, body?.error?.message ?? '',
    );
    return null;  // caller receives null; outer result still succeeds
  }

  return res.json();
}

// ─── Core orchestrator ────────────────────────────────────────────────────────

/**
 * provisionOpenAIProject
 * ──────────────────────
 * Top-level function called from the Express route handler.
 *
 * Steps
 * ─────
 *  1. Load bot config from DB.
 *  2. Decrypt the user's OpenAI token.
 *  3. Create the OpenAI Project (idempotent on name collision).
 *  4. Persist project_id to bots table.
 *  5. Apply spend_cap if defined.
 *  6. Set default model to gpt-4o-mini.
 *
 * @param {string} botId – UUID of the bot being provisioned
 * @returns {{
 *   success:       boolean,
 *   project_id:    string | null,
 *   warnings:      string[],
 *   error:         string | null
 * }}
 */
async function provisionOpenAIProject(botId) {
  const warnings = [];

  // ── Step 1: load bot ──────────────────────────────────────
  const bot = await getBotConfig(botId);
  if (!bot) {
    return { success: false, project_id: null, warnings, error: `Bot ${botId} not found.` };
  }

  // If already provisioned, return early — idempotent
  if (bot.openai_project_id) {
    return {
      success   : true,
      project_id: bot.openai_project_id,
      warnings  : ['Project was already provisioned; skipped creation.'],
      error     : null,
    };
  }

  // ── Step 2: decrypt token ─────────────────────────────────
  const tokenRow = await getEncryptedToken(bot.user_id);
  if (!tokenRow) {
    return {
      success   : false,
      project_id: null,
      warnings,
      error     : 'No OpenAI token found for this user. Connect OpenAI OAuth first.',
    };
  }

  let openaiToken;
  try {
    openaiToken = decryptToken(
      tokenRow.encrypted_token,
      tokenRow.iv,
    );
  } catch (err) {
    return {
      success   : false,
      project_id: null,
      warnings,
      error     : `Token decryption failed: ${err.message}`,
    };
  }

  // ── Step 3: create project ────────────────────────────────
  let project;
  try {
    project = await createOpenAIProject(openaiToken, bot.name);
  } catch (err) {
    if (err.code === 'PROJECT_ALREADY_EXISTS') {
      // Project name collision — treat as a warning, not a hard failure.
      // The caller should either rename the bot or retrieve the existing project_id manually.
      return {
        success   : false,
        project_id: null,
        warnings,
        error     : err.message,
      };
    }
    return {
      success   : false,
      project_id: null,
      warnings,
      error     : err.message,
    };
  }

  const projectId = project.id;

  // ── Step 4: persist project_id ────────────────────────────
  await saveProjectId(botId, projectId);

  // ── Step 5: spend cap ─────────────────────────────────────
  if (bot.spend_cap != null) {
    try {
      await setProjectSpendCap(openaiToken, projectId, Number(bot.spend_cap));
    } catch (err) {
      if (err.code === 'BILLING_NOT_ENABLED') {
        warnings.push('Spend cap not applied: billing is not enabled for this OpenAI organisation.');
      } else {
        warnings.push(`Spend cap not applied: ${err.message}`);
      }
    }
  } else {
    warnings.push('No spend_cap defined for this bot; monthly limit was not set.');
  }

  // ── Step 6: default model ─────────────────────────────────
  const modelResult = await setProjectDefaultModel(openaiToken, projectId);
  if (!modelResult) {
    warnings.push(`Default model (${DEFAULT_MODEL}) could not be set — may require manual configuration.`);
  }

  return {
    success   : true,
    project_id: projectId,
    warnings,
    error     : null,
  };
}

// ─── Express router ───────────────────────────────────────────────────────────

const express      = require('express');
const router       = express.Router();
const { authMiddleware } = require('./middleware');

/**
 * POST /openai/provision/:botId
 *
 * Protected route — requires a valid BotForge JWT.
 * Provisions an OpenAI Project for the given bot and returns the result.
 *
 * Request headers:
 *   Authorization: Bearer <botforge_jwt>
 *
 * Success response (200):
 *   {
 *     "success": true,
 *     "project_id": "proj_abc123",
 *     "warnings": []
 *   }
 *
 * Error response (4xx / 5xx):
 *   {
 *     "success": false,
 *     "project_id": null,
 *     "error": "..."
 *   }
 */
router.post('/provision/:botId', authMiddleware, async (req, res) => {
  const { botId } = req.params;

  // Ownership check — ensure the bot belongs to the authenticated user
  try {
    const { rows } = await pool.query(
      `SELECT user_id FROM bots WHERE id = $1`,
      [botId],
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Bot not found.' });
    }

    if (rows[0].user_id !== req.user.sub) {
      return res.status(403).json({ success: false, error: 'Forbidden: bot belongs to a different user.' });
    }
  } catch (err) {
    console.error('[openai-project] DB ownership check failed:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }

  // Provision
  try {
    const result = await provisionOpenAIProject(botId);

    const statusCode = result.success ? 200 : 422;
    return res.status(statusCode).json(result);
  } catch (err) {
    console.error('[openai-project] Unhandled error:', err.message);
    return res.status(500).json({
      success   : false,
      project_id: null,
      warnings  : [],
      error     : 'Unexpected server error during project provisioning.',
    });
  }
});

module.exports = { router, provisionOpenAIProject, decryptToken };
