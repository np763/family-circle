'use strict';
// Test helpers: spawn the real server on a random port with a throwaway database.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function startServer() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-test-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('server exited early:\n' + log);
    try { await fetch(base + '/api/default-nothing'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return {
    base, dataDir, child,
    log: () => log,
    alive: () => child.exitCode === null,
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// A cookie-keeping API client.
function client(base) {
  let cookie = '';
  const call = async (method, url, body, raw) => {
    const headers = { 'X-Requested-With': 'fetch' };
    if (cookie) headers.Cookie = cookie;
    let b;
    if (raw) { b = raw; headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { b = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const r = await fetch(base + url, { method, headers, body: b });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = {};
    try { data = await r.json(); } catch { /* not json */ }
    return { status: r.status, data };
  };
  call.raw = (url) => fetch(base + url, { headers: { Cookie: cookie } });
  call.login = async (username, password) => {
    const r = await call('POST', '/api/login', { username, password });
    if (r.status !== 200) throw new Error('login failed for ' + username + ': ' + JSON.stringify(r.data));
    return r;
  };
  return call;
}

// Admin + a few family members, ready to use.
async function seedFamily(base) {
  const admin = client(base);
  await admin.login('admin', 'password');
  const mk = async (body) => (await admin('POST', '/api/users', body)).data;
  const dadU = await mk({ kind: 'human', username: 'dad', display_name: 'Dad', password: 'secret1' });
  const mumU = await mk({ kind: 'human', username: 'mum', display_name: 'Mum', password: 'secret2' });
  const eveU = await mk({ kind: 'human', username: 'eve', display_name: 'Eve', password: 'secret3' });
  const bear = await mk({ kind: 'plush', username: 'bear', display_name: 'Mr Bear' });
  const dad = client(base), mum = client(base), eve = client(base);
  await dad.login('dad', 'secret1'); await mum.login('mum', 'secret2'); await eve.login('eve', 'secret3');
  return { admin, dad, mum, eve, ids: { dad: dadU.id, mum: mumU.id, eve: eveU.id, bear: bear.id } };
}

module.exports = { startServer, client, seedFamily, PNG, ROOT };
