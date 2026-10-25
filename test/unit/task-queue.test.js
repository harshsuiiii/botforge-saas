'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { createTaskQueue } = require('../../catalog/task-queue');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs at most N tasks at once and finishes them all', async () => {
  const queue = createTaskQueue(2);
  let running = 0;
  let peak = 0;
  const done = [];

  await Promise.all([1, 2, 3, 4, 5].map((n) => queue.run(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await tick(20);
    running -= 1;
    done.push(n);
  })));

  assert.equal(peak, 2);
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5]);
});

test('a failing task does not block the queue', async () => {
  const queue = createTaskQueue(1);
  const failed = queue.run(async () => { throw new Error('boom'); });
  const ok = queue.run(async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await ok, 'ok');
});
