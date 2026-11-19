'use strict';
// Regression tests for the five P1 bugs found in the code review.
// Each test is written to FAIL while the bug exists and PASS once it is fixed.
//   node --test test/bugs.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { startServer, client, seedFamily, PNG, ROOT } = require('./helpers');
const { serveFile } = require('../lib/serve');
const { hashPassword, verifyPassword } = require('../lib/auth');
const { createThrottle } = require('../lib/throttle');

async function withServer(fn) {
  const srv = await startServer();
  try { await fn(srv); } finally { await srv.stop(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Bug 1: media streams have no error handling and are not destroyed on abort
// ---------------------------------------------------------------------------
function fakeRes(drain) {
  const res = new Writable({ highWaterMark: 1, write(chunk, enc, cb) { if (drain) cb(); /* else: never drains */ } });
  res.writeHead = () => {};
  return res;
}
const REQ = { headers: {}, method: 'GET' };

test('bug 1a: a read-stream error must not crash the process', async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  const res = fakeRes(true);
  try {
    // stat() says the file exists, but it vanishes before it can be opened (e.g. the post was just deleted)
    const fsImpl = {
      stat: (f, cb) => cb(null, { isFile: () => true, size: 100 }),
      createReadStream: (f, o) => fs.createReadStream(path.join(os.tmpdir(), 'family-missing-' + Date.now()), o),
    };
    serveFile(REQ, res, 'whatever.mp4', 'video/mp4', null, fsImpl);
    await sleep(150);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught.map((e) => e.code), [], 'unhandled stream error would crash the server');
  assert.ok(res.destroyed || res.writableEnded, 'response should be finished after the error');
});

test('bug 1b: aborting a download must close the file stream (no fd leak)', async () => {
  let source;
  const fsImpl = {
    stat: (f, cb) => cb(null, { isFile: () => true, size: 1e9 }),
    createReadStream: () => { source = new Readable({ read() { this.push(Buffer.alloc(65536)); } }); return source; },
  };
  const res = fakeRes(false);
  serveFile(REQ, res, 'big.mp4', 'video/mp4', null, fsImpl);
  await sleep(50);
  res.destroy(); // browser closed the connection (video seek)
  await sleep(100);
  assert.equal(source.destroyed, true, 'source file stream must be destroyed when the client disconnects');
});

// ---------------------------------------------------------------------------
// Bug 2: removing a human must not delete what they posted as a plush/pet
// ---------------------------------------------------------------------------
test('bug 2: removing a human keeps content they created as a plush/pet', () => withServer(async (srv) => {
  const { admin, dad, mum, ids } = await seedFamily(srv.base);
  await dad('POST', '/api/act-as', { user_id: ids.bear });
  const photo = (await dad('POST', '/api/upload?name=p.png', undefined, PNG)).data;
  const avatar = (await dad('POST', '/api/upload?name=a.png', undefined, PNG)).data;
  assert.equal((await dad('PUT', '/api/users/' + ids.bear, { avatar_media_id: avatar.id })).status, 200);
  const post = (await dad('POST', '/api/posts', { body: 'bear post', media: [photo.id], poll: { question: 'q?', options: ['a', 'b'] } })).data;
  assert.ok(post.id, 'post as bear created');
  await dad('POST', `/api/polls/${post.poll.id}/vote`, { option_id: post.poll.options[0].id });
  await dad('POST', `/api/posts/${post.id}/comments`, { body: 'bear comment' });
  await dad('POST', '/api/events', { title: 'bear party', date: '2030-05-05' });
  await dad('POST', '/api/act-as', { user_id: null });
  const own = (await dad('POST', '/api/posts', { body: 'dads own post' })).data;
  await mum('POST', `/api/posts/${post.id}/comments`, { body: 'mum reply' });

  assert.equal((await admin('DELETE', '/api/users/' + (await mum('GET', '/api/users')).data.find((u) => u.username === 'dad').id)).status, 200);

  const feed = (await mum('GET', '/api/posts')).data.posts;
  const kept = feed.find((p) => p.id === post.id);
  assert.ok(kept, "Mr Bear's post must survive Dad's removal");
  assert.equal(feed.find((p) => p.id === own.id), undefined, "Dad's own post is removed with him");
  assert.equal(kept.comments.length, 2, "bear's comment and Mum's reply must survive");
  assert.equal(kept.poll.total, 1, "bear's vote must survive");
  assert.equal(kept.media.length, 1);
  assert.equal((await mum.raw(kept.media[0].url)).status, 200, 'photo file must still be on disk');
  const bear = (await mum('GET', '/api/users')).data.find((u) => u.username === 'bear');
  assert.equal((await mum.raw('/media/' + bear.avatar)).status, 200, "bear's avatar file must still be on disk");
  const cal = (await mum('GET', '/api/calendar?from=2030-05-01&to=2030-05-31')).data;
  assert.equal(cal.events.length, 1, "bear's event must survive");
}));

// ---------------------------------------------------------------------------
// Bug 3: while acting as a plush/pet you can manage that plush/pet's content
// ---------------------------------------------------------------------------
test('bug 3: acting as a plush lets you edit and delete its posts, replies and events', () => withServer(async (srv) => {
  const { dad, mum, eve, ids } = await seedFamily(srv.base);
  await dad('POST', '/api/act-as', { user_id: ids.bear });
  const post = (await dad('POST', '/api/posts', { body: 'typo' })).data;
  const withComment = (await dad('POST', `/api/posts/${post.id}/comments`, { body: 'cmt typo' })).data;
  const commentId = withComment.comments[0].id;
  const ev = (await dad('POST', '/api/events', { title: 'ev typo', date: '2030-01-01' })).data;

  // Eve is not acting as the bear: still not allowed
  assert.equal((await eve('PUT', '/api/posts/' + post.id, { body: 'x' })).status, 403);
  assert.equal((await mum('PUT', '/api/posts/' + post.id, { body: 'x' })).status, 403, 'Mum not acting as bear is still refused');

  await mum('POST', '/api/act-as', { user_id: ids.bear });
  const feed = (await mum('GET', '/api/posts')).data.posts.find((p) => p.id === post.id);
  assert.equal(feed.can_edit, true, 'UI must show Edit while acting as the post author');
  assert.equal(feed.comments[0].can_edit, true);
  assert.equal((await mum('PUT', '/api/posts/' + post.id, { body: 'fixed' })).status, 200, 'Mum acting as bear can edit');
  assert.equal((await mum('PUT', '/api/comments/' + commentId, { body: 'fixed' })).status, 200);
  assert.equal((await mum('PUT', '/api/events/' + ev.id, { title: 'fixed' })).status, 200);
  assert.equal((await mum('DELETE', '/api/posts/' + post.id)).status, 200);
  assert.equal((await mum('DELETE', '/api/events/' + ev.id)).status, 200);
}));

// ---------------------------------------------------------------------------
// Bug 4: login throttling / blocking
// ---------------------------------------------------------------------------
test('bug 4a: throttle limits a single IP that rotates usernames', () => {
  const t = createThrottle();
  for (let i = 0; i < 40; i++) { t.blocked('10.0.0.9', 'user' + i); t.fail('10.0.0.9', 'user' + i); }
  assert.equal(t.blocked('10.0.0.9', 'brand-new-name'), true, 'IP should be blocked after many failures across usernames');
  assert.equal(t.blocked('10.0.0.10', 'brand-new-name'), false, 'other IPs are unaffected');
});

test('bug 4b: throttle memory is pruned once the window passes', () => {
  let now = 0;
  const t = createThrottle({ now: () => now });
  for (let i = 0; i < 100; i++) { t.blocked('10.0.0.1', 'u' + i); t.fail('10.0.0.1', 'u' + i); }
  now += 10 * 60 * 1000;
  t.blocked('10.0.0.2', 'someone'); t.fail('10.0.0.2', 'someone');
  assert.ok(t.size() <= 5, 'expired entries should be dropped, size was ' + t.size());
});

test('bug 4c: password checks must not block the event loop', async () => {
  const { salt, hash } = await hashPassword('right-password');
  const user = { password_hash: hash, password_salt: salt };
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  // 8 concurrent checks = ~200ms of hashing. Blocking (sync) scrypt gives 0 ticks; the async version gives
  // roughly one tick per timer granularity (~15ms on Windows), so >= 3 cleanly separates the two.
  const results = await Promise.all(Array.from({ length: 8 }, () => verifyPassword('wrong', user)));
  clearInterval(timer);
  assert.deepEqual(results, Array(8).fill(false));
  assert.equal(await verifyPassword('right-password', user), true, 'still verifies correct passwords');
  assert.ok(ticks >= 3, 'event loop was starved while hashing (ticks=' + ticks + ')');
});

test('bug 4d: server throttles an IP flooding logins with random usernames', () => withServer(async (srv) => {
  const c = client(srv.base);
  const statuses = [];
  for (let i = 0; i < 45; i++) statuses.push((await c('POST', '/api/login', { username: 'nobody' + i, password: 'x' })).status);
  assert.ok(statuses.includes(429), 'expected a 429 somewhere in 45 attempts, got only ' + [...new Set(statuses)]);
  assert.equal(statuses[0], 401);
}));

// ---------------------------------------------------------------------------
// Bug 5: the documented Node version must be one where node:sqlite works unflagged
// ---------------------------------------------------------------------------
test('bug 5: engines and README require Node >= 22.13 (node:sqlite is unflagged from there)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const m = /(\d+)\.(\d+)/.exec(pkg.engines.node);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  assert.ok(major > 22 || (major === 22 && minor >= 13), 'engines.node is ' + pkg.engines.node);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(!/22\.5\b/.test(readme), 'README still says Node 22.5');
});
