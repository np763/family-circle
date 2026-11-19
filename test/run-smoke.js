'use strict';
// Runs test/smoke.js against a throwaway server (fresh temp database, random port).
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { startServer } = require('./helpers');

(async () => {
  const srv = await startServer();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'smoke.js')], { env: { ...process.env, BASE: srv.base }, stdio: 'inherit' });
  await srv.stop();
  process.exit(r.status ?? 1);
})();
