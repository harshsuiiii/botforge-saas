'use strict';

/**
 * task-queue.js
 * ─────────────
 * BotForge – tiny in-process concurrency limiter. Imports parse files of up
 * to 10 MB and crawl up to 50 pages, so only a few may run at once per
 * server process; the rest wait their turn.
 */

/**
 * @param {number} concurrency
 * @returns {{ run<T>(task: () => Promise<T>): Promise<T>, size(): number }}
 */
function createTaskQueue(concurrency) {
  let active = 0;
  const waiting = [];

  function next() {
    if (active >= concurrency || !waiting.length) return;
    const { task, resolve, reject } = waiting.shift();
    active += 1;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  }

  return {
    run(task) {
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        next();
      });
    },
    size() {
      return active + waiting.length;
    },
  };
}

module.exports = { createTaskQueue };
