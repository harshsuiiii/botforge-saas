'use strict';

const express = require('express');

/** Start an Express app with the given [path, router] mounts on a random local port. */
function startApp(mounts) {
  const app = express();
  app.use(express.json());
  for (const [mountPath, router] of mounts) app.use(mountPath, router);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        base : `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startApp };
