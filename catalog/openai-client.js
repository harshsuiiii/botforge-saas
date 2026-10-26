'use strict';

/**
 * openai-client.js
 * ────────────────
 * BotForge – minimal JSON client for the OpenAI REST API (no SDK).
 */

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * POST a JSON body to an OpenAI endpoint with the owner's token.
 *
 * @param {string} token – decrypted OpenAI key
 * @param {string} path  – e.g. '/embeddings'
 * @param {object} body
 * @param {{ projectId?: string|null }} opts – bills the call to the bot's OpenAI project
 * @returns {Promise<object>} parsed JSON response
 * @throws {Error} with .status and .openai (parsed error body) on non-2xx
 */
async function openaiJson(token, path, body, { projectId } = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type' : 'application/json',
  };
  if (projectId) headers['OpenAI-Project'] = projectId;

  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body  : JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err  = new Error(`OpenAI ${path} failed: ${res.status} ${data?.error?.message ?? ''}`.trim());
    err.status = res.status;
    err.openai = data;
    throw err;
  }
  return data;
}

module.exports = { openaiJson };
