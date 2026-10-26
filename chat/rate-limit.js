'use strict';

/**
 * rate-limit.js
 * ─────────────
 * BotForge – fixed-window, in-memory rate limiter for the public /chat
 * endpoint. Single-process only; a multi-instance deployment would need a
 * shared store (e.g. Redis).
 */

const MAX_TRACKED_KEYS = 50000;

/**
 * @param {{ windowMs: number, max: number }} opts
 * @returns {{ hit(key: string, now?: number): { allowed: boolean, retryAfterSec: number }, reset(): void }}
 */
function createRateLimiter({ windowMs, max }) {
  const windows = new Map(); // key → { count, resetAt }

  function prune(now) {
    for (const [key, w] of windows) {
      if (w.resetAt <= now) windows.delete(key);
    }
  }

  return {
    hit(key, now = Date.now()) {
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        if (windows.size >= MAX_TRACKED_KEYS) prune(now);
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      return {
        allowed      : w.count <= max,
        retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
      };
    },
    reset() {
      windows.clear();
    },
  };
}

module.exports = { createRateLimiter };
