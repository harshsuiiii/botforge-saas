'use strict';

/**
 * pdf.js
 * ──────
 * BotForge – PDF catalog → plain text (products are extracted later by the LLM).
 *
 * Parsing happens in a short-lived worker thread per PDF:
 *  - pdf.js keeps module-level state that made every PDF after the first in a
 *    process come back empty;
 *  - pdf.js ignores Buffer.byteOffset, and small uploads arrive as views into
 *    Node's shared buffer pool — copying into the worker gives it its own bytes;
 *  - a pathological PDF can be stopped with a timeout instead of blocking the API.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH   = path.join(__dirname, 'pdf-worker.js');
const PDF_TIMEOUT_MS = 60 * 1000;

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
function parsePdf(buffer) {
  // Uint8Array.from copies the bytes into a fresh ArrayBuffer starting at offset 0
  const bytes = Uint8Array.from(buffer);

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { bytes }, transferList: [bytes.buffer] });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Reading the PDF took too long.')), PDF_TIMEOUT_MS);

    worker.once('message', (msg) => (msg.error ? finish(reject, new Error(msg.error)) : finish(resolve, msg.text)));
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => finish(reject, new Error(`PDF reader stopped unexpectedly (${code}).`)));
  });
}

module.exports = { parsePdf };
