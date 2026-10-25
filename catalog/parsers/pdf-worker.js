'use strict';

/**
 * pdf-worker.js
 * ─────────────
 * Runs inside a worker thread: parses one PDF and posts { text } or { error }.
 * Each PDF gets a fresh worker because pdf.js keeps module-level state
 * (font caches) that corrupts text extraction for later documents.
 */

const { parentPort, workerData } = require('worker_threads');

// The package root runs a debug self-test when loaded directly; the lib entry does not.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

// Pass the transferred Uint8Array as-is: it owns its ArrayBuffer from offset 0.
// (Buffer.from() would copy it into Node's shared pool at a non-zero offset,
// which pdf.js ignores, breaking the cross-reference table.)
pdfParse(workerData.bytes)
  .then((data) => parentPort.postMessage({ text: data.text ?? '' }))
  .catch((err) => parentPort.postMessage({ error: err?.message ?? String(err) }));
