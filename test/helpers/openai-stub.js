'use strict';

/**
 * Replaces globalThis.fetch for api.openai.com with scripted responses.
 * Embeddings are answered automatically; chat completions come from a queue.
 */

const crypto = require('crypto');

const DIMS = 1536;

/** Deterministic bag-of-words embedding: texts sharing words get positive cosine similarity. */
function fakeEmbedding(text) {
  const vec = new Array(DIMS).fill(0);
  const tokens = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [];
  for (const token of tokens) {
    vec[crypto.createHash('md5').update(token).digest().readUInt32BE(0) % DIMS] += 1;
  }
  let norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (norm === 0) { vec[0] = 1; norm = 1; } // pgvector cannot compare zero vectors
  return vec.map((x) => x / norm);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Stream each SSE event as its own chunk so consumers must handle partial
 * reads. With chunkBytes, the byte stream is instead cut every N bytes —
 * mid-line and mid-character.
 */
function sseResponse(status, payloads, chunkBytes = 0) {
  const encoder = new TextEncoder();
  const events  = [...payloads, '[DONE]'].map((d) => `data: ${d}\n\n`);
  const chunks  = chunkBytes
    ? (() => {
      const bytes = encoder.encode(events.join(''));
      const out = [];
      for (let i = 0; i < bytes.length; i += chunkBytes) out.push(bytes.slice(i, i + chunkBytes));
      return out;
    })()
    : events.map((e) => encoder.encode(e));
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function installOpenAIStub() {
  const realFetch = globalThis.fetch;
  const requests  = [];
  const chatQueue = [];
  let failEmbeddings = false;
  let embedDelayMs = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.openai.com/')) return realFetch(input, init);

    const path    = new URL(url).pathname;
    const body    = init.body ? JSON.parse(init.body) : null;
    const headers = { ...(init.headers ?? {}) };
    requests.push({ path, body, headers, method: init.method ?? 'GET' });

    // Key check: 'sk-bad…' is rejected, 'sk-down…' simulates an OpenAI outage
    if (path === '/v1/models') {
      const key = String(headers.Authorization ?? '').replace(/^Bearer /, '');
      if (key.startsWith('sk-bad')) return jsonResponse(401, { error: { message: 'Incorrect API key provided' } });
      if (key.startsWith('sk-down')) return jsonResponse(500, { error: { message: 'server error' } });
      return jsonResponse(200, { object: 'list', data: [{ id: 'gpt-4o-mini' }] });
    }

    if (path === '/v1/embeddings') {
      if (embedDelayMs) await new Promise((r) => setTimeout(r, embedDelayMs));
      if (failEmbeddings) return jsonResponse(500, { error: { message: 'stub embeddings failure' } });
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return jsonResponse(200, {
        data : inputs.map((text, index) => ({ index, embedding: fakeEmbedding(text) })),
        model: body.model,
      });
    }

    if (path === '/v1/chat/completions') {
      const reply = chatQueue.shift();
      if (!reply) throw new Error('OpenAI stub: no queued chat reply');
      const status = reply.status ?? 200;
      return reply.sse ? sseResponse(status, reply.sse, reply.chunkBytes) : jsonResponse(status, reply.json ?? {});
    }

    return jsonResponse(404, { error: { message: `OpenAI stub: unknown path ${path}` } });
  };

  return {
    requests,
    queueChat(reply) { chatQueue.push(reply); },
    failEmbeddings(on) { failEmbeddings = on; },
    delayEmbeddings(ms) { embedDelayMs = ms; },
    restore() { globalThis.fetch = realFetch; },
  };
}

function splitParts(str, parts) {
  const size = Math.max(1, Math.ceil(str.length / parts));
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out.length ? out : [''];
}

const chunk = (delta, finishReason = null) =>
  JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] });

const sse = {
  text(str, parts = 1) {
    return splitParts(str, parts).map((piece) => chunk({ content: piece }));
  },
  /** A tool call whose argument JSON arrives in `parts` pieces, then finish_reason 'tool_calls'. */
  toolCall(index, id, name, argsJson, parts = 1) {
    const pieces = splitParts(argsJson, parts).map((piece, i) => chunk({
      tool_calls: [i === 0
        ? { index, id, type: 'function', function: { name, arguments: piece } }
        : { index, function: { arguments: piece } }],
    }));
    return [...pieces, chunk({}, 'tool_calls')];
  },
  finish(reason = 'stop') {
    return chunk({}, reason);
  },
};

module.exports = { fakeEmbedding, installOpenAIStub, sse };
