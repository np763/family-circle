'use strict';
// Family Circle — a small private social app for a family and their plush/pets.
// Zero dependencies: node:http + node:sqlite + node:crypto.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword, dummyVerify } = require('./lib/auth');
const { createThrottle } = require('./lib/throttle');
const { serveFile } = require('./lib/serve');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_USERS = 50;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'family.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'human' CHECK(kind IN ('human','plush','pet')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,            -- NULL for non-human members (they cannot log in directly)
  password_salt TEXT,
  bio TEXT NOT NULL DEFAULT '',
  avatar TEXT,                   -- uploaded media filename
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acting_as_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,     -- who the post appears from
  posted_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the human who really typed it
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  posted_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS media(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tags(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  CHECK((post_id IS NULL) != (comment_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_post ON tags(post_id,user_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tags_comment ON tags(comment_id,user_id) WHERE comment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS polls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  question TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_votes(
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cast_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(poll_id, voter_id)       -- one vote per member per poll
);
CREATE TABLE IF NOT EXISTS likes(
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(post_id, user_id)
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,        -- YYYY-MM-DD
  event_time TEXT,                 -- HH:MM or NULL for all-day
  yearly INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  posted_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);
`);

// ---------- helpers ----------
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'birthday')) db.exec('ALTER TABLE users ADD COLUMN birthday TEXT'); // YYYY-MM-DD
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const marks = (n) => Array(n).fill('?').join(',');

// A member may edit/delete content they typed themselves, or content from the plush/pet they are currently acting as.
function canManage(s, row) {
  return row.posted_by_id === s.user.id || row.author_id === s.effective.id || row.author_id === s.user.id;
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const forbid = (msg = 'Not allowed') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);

async function seedAdmin() {
  if (q1('SELECT 1 FROM users LIMIT 1')) return;
  const { salt, hash } = await hashPassword('password');
  run(`INSERT INTO users(username,display_name,kind,is_admin,password_hash,password_salt) VALUES('admin','Admin','human',1,?,?)`, hash, salt);
  console.log('Seeded default account admin / password');
}

const PUBLIC_USER = 'id,username,display_name,kind,is_admin,bio,avatar,birthday,created_at,(password_hash IS NOT NULL) AS has_password';
const publicUser = (id) => q1(`SELECT ${PUBLIC_USER} FROM users WHERE id=?`, id);

// ---------- uploads ----------
const TYPES = {
  jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'], png: ['image/png', 'image'],
  gif: ['image/gif', 'image'], webp: ['image/webp', 'image'],
  mp4: ['video/mp4', 'video'], m4v: ['video/mp4', 'video'], webm: ['video/webm', 'video'],
  mov: ['video/quicktime', 'video'], ogv: ['video/ogg', 'video'],
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('Invalid JSON'); }
}

function saveUpload(req, url, user) {
  return new Promise((resolve, reject) => {
    const orig = (url.searchParams.get('name') || 'file').slice(0, 120);
    const ext = path.extname(orig).slice(1).toLowerCase();
    const t = TYPES[ext];
    if (!t) return reject(bad('Unsupported file type. Use jpg, png, gif, webp, mp4, webm or mov.'));
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_UPLOAD) return reject(new HttpError(413, 'File too large (max 200 MB)'));
    const filename = crypto.randomBytes(16).toString('hex') + '.' + ext;
    const file = path.join(UPLOAD_DIR, filename);
    const out = fs.createWriteStream(file);
    let size = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.unlink(file, () => {}); reject(e); };
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { fail(new HttpError(413, 'File too large (max 200 MB)')); req.destroy(); } });
    req.on('error', fail);
    out.on('error', fail);
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (!size) return fail(bad('Empty file'));
      const r = run('INSERT INTO media(filename,original_name,mime,kind,uploader_id) VALUES(?,?,?,?,?)', filename, orig, t[0], t[1], user.id);
      resolve({ id: Number(r.lastInsertRowid), filename, url: '/media/' + filename, kind: t[1], original_name: orig });
    });
  });
}

const STATIC_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------- sessions ----------
function parseCookies(req) {
  const o = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return o;
}
function getSession(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = q1('SELECT * FROM sessions WHERE token=?', token);
  if (!s) return null;
  if (s.expires_at < Date.now()) { run('DELETE FROM sessions WHERE token=?', token); return null; }
  const user = q1('SELECT * FROM users WHERE id=?', s.user_id);
  if (!user) return null;
  let acting = null;
  if (s.acting_as_id) {
    acting = q1(`SELECT * FROM users WHERE id=? AND kind!='human'`, s.acting_as_id);
  }
  return { token, user, acting, effective: acting || user };
}
const cookie = (token, maxAge) => `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

const throttle = createThrottle();

async function sessionInfo(s) {
  const me = publicUser(s.user.id);
  return {
    user: me,
    acting_as: s.acting ? publicUser(s.acting.id) : null,
    effective: publicUser(s.effective.id),
    default_admin_password: !!(s.user.is_admin && await verifyPassword('password', s.user)),
  };
}

// ---------- feed assembly ----------
function validTagIds(ids, selfId) {
  if (!Array.isArray(ids)) return [];
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  if (!uniq.length) return [];
  return q(`SELECT id FROM users WHERE is_admin=0 AND id IN (${marks(uniq.length)})`, ...uniq).map((r) => r.id);
}
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

function buildPosts(rows, me) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const m = marks(ids.length);
  const media = q(`SELECT id,post_id,filename,mime,kind FROM media WHERE post_id IN (${m}) ORDER BY id`, ...ids);
  const ptags = q(`SELECT t.post_id,u.id,u.display_name,u.kind FROM tags t JOIN users u ON u.id=t.user_id WHERE t.post_id IN (${m})`, ...ids);
  const polls = q(`SELECT * FROM polls WHERE post_id IN (${m})`, ...ids);
  const likes = q(`SELECT l.post_id,u.id,u.display_name FROM likes l JOIN users u ON u.id=l.user_id WHERE l.post_id IN (${m})`, ...ids);
  const comments = q(`SELECT c.*, a.display_name AS author_name, a.kind AS author_kind, a.avatar AS author_avatar, b.display_name AS posted_by_name
    FROM comments c JOIN users a ON a.id=c.author_id JOIN users b ON b.id=c.posted_by_id WHERE c.post_id IN (${m}) ORDER BY c.id`, ...ids);
  const cids = comments.map((c) => c.id);
  const ctags = cids.length ? q(`SELECT t.comment_id,u.id,u.display_name,u.kind FROM tags t JOIN users u ON u.id=t.user_id WHERE t.comment_id IN (${marks(cids.length)})`, ...cids) : [];
  const pollIds = polls.map((p) => p.id);
  const options = pollIds.length ? q(`SELECT * FROM poll_options WHERE poll_id IN (${marks(pollIds.length)}) ORDER BY id`, ...pollIds) : [];
  const votes = pollIds.length ? q(`SELECT v.poll_id,v.option_id,v.voter_id,u.display_name FROM poll_votes v JOIN users u ON u.id=v.voter_id WHERE v.poll_id IN (${marks(pollIds.length)})`, ...pollIds) : [];

  const group = (arr, key) => arr.reduce((o, x) => ((o[x[key]] ||= []).push(x), o), {});
  const gMedia = group(media, 'post_id'), gTags = group(ptags, 'post_id'), gLikes = group(likes, 'post_id');
  const gComments = group(comments, 'post_id'), gCTags = group(ctags, 'comment_id');
  const gPoll = Object.fromEntries(polls.map((p) => [p.post_id, p]));
  const gOpts = group(options, 'poll_id'), gVotes = group(votes, 'option_id');

  return rows.map((r) => {
    const poll = gPoll[r.id];
    return {
      id: r.id, body: r.body, created_at: r.created_at, updated_at: r.updated_at,
      author: { id: r.author_id, display_name: r.author_name, kind: r.author_kind, avatar: r.author_avatar },
      posted_by: { id: r.posted_by_id, display_name: r.posted_by_name },
      can_edit: canManage(me, r),
      media: (gMedia[r.id] || []).map((x) => ({ id: x.id, url: '/media/' + x.filename, kind: x.kind, mime: x.mime })),
      tags: (gTags[r.id] || []).map(({ id, display_name, kind }) => ({ id, display_name, kind })),
      likes: (gLikes[r.id] || []).map(({ id, display_name }) => ({ id, display_name })),
      liked: (gLikes[r.id] || []).some((l) => l.id === me.effective.id),
      poll: poll ? {
        id: poll.id, question: poll.question,
        my_vote: (votes.find((v) => v.poll_id === poll.id && v.voter_id === me.effective.id) || {}).option_id || null,
        total: votes.filter((v) => v.poll_id === poll.id).length,
        options: (gOpts[poll.id] || []).map((o) => ({
          id: o.id, label: o.label, count: (gVotes[o.id] || []).length,
          voters: (gVotes[o.id] || []).map((v) => v.display_name),
        })),
      } : null,
      comments: (gComments[r.id] || []).map((c) => ({
        id: c.id, parent_id: c.parent_id, body: c.body, created_at: c.created_at, updated_at: c.updated_at,
        author: { id: c.author_id, display_name: c.author_name, kind: c.author_kind, avatar: c.author_avatar },
        posted_by: { id: c.posted_by_id, display_name: c.posted_by_name },
        can_edit: canManage(me, c),
        tags: (gCTags[c.id] || []).map(({ id, display_name, kind }) => ({ id, display_name, kind })),
      })),
    };
  });
}
const POST_SELECT = `SELECT p.*, a.display_name AS author_name, a.kind AS author_kind, a.avatar AS author_avatar, b.display_name AS posted_by_name
  FROM posts p JOIN users a ON a.id=p.author_id JOIN users b ON b.id=p.posted_by_id`;

function setTags(col, rowId, ids) {
  run(`DELETE FROM tags WHERE ${col}=?`, rowId);
  for (const uid of ids) run(`INSERT INTO tags(${col},user_id) VALUES(?,?)`, rowId, uid);
}

function removeMediaFiles(rows) {
  for (const r of rows) fs.unlink(path.join(UPLOAD_DIR, r.filename), () => {});
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function parseBirthday(v) {
  if (v == null || v === '') return null;
  if (!validDate(v) || v > new Date().toISOString().slice(0, 10) || v < '1900-01-01') throw bad('Birthday must be a valid date in the past');
  return v;
}
// every date in [from,to] on which the month-day of ymd falls (Feb 29 -> Feb 28 in non-leap years)
function yearlyOccurrences(ymd, from, to) {
  const out = [], y0 = Number(ymd.slice(0, 4)), md = ymd.slice(5);
  for (let y = Math.max(y0, Number(from.slice(0, 4))); y <= Number(to.slice(0, 4)); y++) {
    let d = y + '-' + md;
    if (md === '02-29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) d = y + '-02-28';
    if (d >= from && d <= to) out.push({ date: d, year: y });
  }
  return out;
}
function eventShape(e, date, s) {
  return { id: e.id, title: e.title, notes: e.notes, location: e.location, date, base_date: e.event_date, time: e.event_time, yearly: !!e.yearly,
    author: { id: e.author_id, display_name: e.author_name, kind: e.author_kind, avatar: e.author_avatar },
    can_edit: canManage(s, e) };
}
const EVENT_SELECT = 'SELECT e.*, a.display_name AS author_name, a.kind AS author_kind, a.avatar AS author_avatar FROM events e JOIN users a ON a.id=e.author_id';
function readEvent(b, existing) {
  const title = clean(b.title ?? existing?.title, 100);
  if (!title) throw bad('Give the event a title');
  const date = b.date ?? existing?.event_date;
  if (!validDate(date)) throw bad('Pick a valid date');
  const time = b.time === undefined ? (existing ? existing.event_time : null) : (b.time || null);
  if (time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('Invalid time');
  return { title, date, time, notes: clean(b.notes ?? existing?.notes, 1000), location: clean(b.location ?? existing?.location, 100),
    yearly: (b.yearly === undefined ? existing?.yearly : b.yearly) ? 1 : 0 };
}

function requireHuman(s) { if (s.user.kind !== 'human') throw forbid(); }

// ---------- routes ----------
async function api(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  let m;

  // public: login
  if (method === 'POST' && p === '/api/login') {
    const b = await readJson(req);
    const username = clean(b.username, 60), password = String(b.password ?? '');
    const ip = req.socket.remoteAddress || '';
    if (throttle.blocked(ip, username)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    // Count the attempt before the (async) hash check, so a burst of simultaneous requests cannot all slip past the limit.
    throttle.fail(ip, username);
    const user = q1('SELECT * FROM users WHERE username=?', username);
    // Non-human accounts have no password and can never log in directly.
    const ok = user && user.kind === 'human' && await verifyPassword(password, user);
    if (!ok) {
      if (!user) await dummyVerify(password); // equalise timing
      throw new HttpError(401, 'Wrong username or password');
    }
    throttle.succeed(ip, username);
    const token = crypto.randomBytes(32).toString('hex');
    const ttl = 14 * 24 * 3600;
    run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, user.id, Date.now() + ttl * 1000);
    res.setHeader('Set-Cookie', cookie(token, ttl));
    return sessionInfo(getSession({ headers: { cookie: 'sid=' + token } }));
  }

  const s = getSession(req);
  if (!s) throw new HttpError(401, 'Please log in');
  // Administrator accounts are for managing members only: no feed, posts, replies, votes or acting as others.
  if (s.user.is_admin && /^\/api\/(posts|comments|polls|act-as|calendar|events)(\/|$)/.test(p)) throw forbid('Administrator accounts cannot view or post content');

  if (method === 'POST' && p === '/api/logout') {
    run('DELETE FROM sessions WHERE token=?', s.token);
    res.setHeader('Set-Cookie', cookie('', 0));
    return { ok: true };
  }
  if (method === 'GET' && p === '/api/me') return sessionInfo(s);

  // act as a non-human member
  if (method === 'POST' && p === '/api/act-as') {
    requireHuman(s);
    const b = await readJson(req);
    if (b.user_id == null) { run('UPDATE sessions SET acting_as_id=NULL WHERE token=?', s.token); }
    else {
      const t = q1(`SELECT id FROM users WHERE id=? AND kind!='human'`, Number(b.user_id));
      if (!t) throw bad('You can only act as a plush or pet member');
      run('UPDATE sessions SET acting_as_id=? WHERE token=?', t.id, s.token);
    }
    return sessionInfo(getSession(req));
  }

  // ----- users -----
  if (method === 'GET' && p === '/api/users') {
    // administrators are invisible to the family
    return q(`SELECT ${PUBLIC_USER} FROM users ${s.user.is_admin ? '' : 'WHERE is_admin=0'} ORDER BY is_admin DESC, kind!='human', display_name COLLATE NOCASE`);
  }
  if (method === 'POST' && p === '/api/users') {
    requireHuman(s);
    const b = await readJson(req);
    const kind = ['human', 'plush', 'pet'].includes(b.kind) ? b.kind : null;
    if (!kind) throw bad('Kind must be human, plush or pet');
    const username = clean(b.username, 30), display = clean(b.display_name, 60);
    if (!/^[A-Za-z0-9_.-]{2,30}$/.test(username)) throw bad('Username: 2-30 letters, numbers, . _ -');
    if (!display) throw bad('Display name is required');
    if (q1('SELECT 1 FROM users WHERE username=?', username)) throw bad('That username is taken');
    if (q1('SELECT COUNT(*) c FROM users').c >= MAX_USERS) throw bad(`Member limit (${MAX_USERS}) reached`);
    let hash = null, salt = null;
    if (kind === 'human') {
      const pw = String(b.password ?? '');
      if (pw.length < 6) throw bad('Password must be at least 6 characters');
      ({ hash, salt } = await hashPassword(pw));
    }
    const isAdmin = kind === 'human' && s.user.is_admin && b.is_admin ? 1 : 0;
    const birthday = parseBirthday(b.birthday);
    let avatar = null;
    if (b.avatar_media_id != null) {
      const md = q1(`SELECT filename FROM media WHERE id=? AND kind='image' AND uploader_id=? AND post_id IS NULL`, Number(b.avatar_media_id), s.user.id);
      if (!md) throw bad('Invalid profile picture');
      avatar = md.filename;
    }
    const r = run('INSERT INTO users(username,display_name,kind,is_admin,password_hash,password_salt,bio,avatar,birthday,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
      username, display, kind, isAdmin, hash, salt, clean(b.bio, 300), avatar, birthday, s.user.id);
    return publicUser(Number(r.lastInsertRowid));
  }
  if ((m = p.match(/^\/api\/users\/(\d+)$/))) {
    const id = Number(m[1]);
    const target = q1('SELECT * FROM users WHERE id=?', id);
    if (!target || (target.is_admin && !s.user.is_admin)) throw notFound('Member not found');
    if (method === 'GET') return publicUser(id);
    requireHuman(s);
    if (method === 'PUT') {
      // humans edit themselves; any human may edit a plush/pet; admins edit anyone
      if (!(s.user.is_admin || id === s.user.id || target.kind !== 'human')) throw forbid();
      const b = await readJson(req);
      const display = b.display_name !== undefined ? clean(b.display_name, 60) : target.display_name;
      if (!display) throw bad('Display name is required');
      const bio = b.bio !== undefined ? clean(b.bio, 300) : target.bio;
      let avatar = target.avatar;
      if (b.avatar_media_id !== undefined) {
        if (b.avatar_media_id === null) avatar = null;
        else {
          const md = q1(`SELECT filename FROM media WHERE id=? AND kind='image' AND uploader_id=? AND post_id IS NULL`, Number(b.avatar_media_id), s.user.id);
          if (!md) throw bad('Invalid avatar image');
          avatar = md.filename;
        }
      }
      let isAdmin = target.is_admin;
      if (b.is_admin !== undefined && s.user.is_admin && target.kind === 'human') {
        isAdmin = b.is_admin ? 1 : 0;
        if (!isAdmin && q1(`SELECT COUNT(*) c FROM users WHERE is_admin=1 AND id!=?`, id).c === 0) throw bad('There must be at least one admin');
      }
      let kind = target.kind;
      if (b.kind !== undefined && target.kind !== 'human' && ['plush', 'pet'].includes(b.kind)) kind = b.kind;
      const birthday = b.birthday !== undefined ? parseBirthday(b.birthday) : target.birthday;
      run('UPDATE users SET display_name=?,bio=?,avatar=?,is_admin=?,kind=?,birthday=? WHERE id=?', display, bio, avatar, isAdmin, kind, birthday, id);
      return publicUser(id);
    }
    if (method === 'DELETE') {
      if (!s.user.is_admin) throw forbid('Only an admin can remove members');
      if (id === s.user.id) throw bad('You cannot remove yourself');
      if (target.is_admin && q1(`SELECT COUNT(*) c FROM users WHERE is_admin=1 AND id!=?`, id).c === 0) throw bad('Cannot remove the last admin');
      const files = [];
      tx(() => {
        // Things this human typed while acting as a plush/pet belong to that character: hand them over
        // instead of letting ON DELETE CASCADE wipe them out.
        run('UPDATE posts SET posted_by_id=author_id WHERE posted_by_id=? AND author_id!=?', id, id);
        run('UPDATE comments SET posted_by_id=author_id WHERE posted_by_id=? AND author_id!=?', id, id);
        run('UPDATE events SET posted_by_id=author_id WHERE posted_by_id=? AND author_id!=?', id, id);
        run('UPDATE poll_votes SET cast_by_id=voter_id WHERE cast_by_id=? AND voter_id!=?', id, id);
        // Files this human uploaded that now belong to someone else (a character's post, another member's avatar).
        run('UPDATE media SET uploader_id=(SELECT author_id FROM posts WHERE posts.id=media.post_id) WHERE uploader_id=? AND post_id IN (SELECT id FROM posts WHERE author_id!=?)', id, id);
        run('UPDATE media SET uploader_id=(SELECT u.id FROM users u WHERE u.avatar=media.filename AND u.id!=?) WHERE uploader_id=? AND post_id IS NULL AND filename IN (SELECT avatar FROM users WHERE avatar IS NOT NULL AND id!=?)', id, id, id);
        // Only files that are really going away get deleted from disk.
        files.push(...q('SELECT filename FROM media WHERE uploader_id=? OR post_id IN (SELECT id FROM posts WHERE author_id=?)', id, id));
        if (target.avatar) files.push({ filename: target.avatar });
        run('DELETE FROM users WHERE id=?', id);
      });
      removeMediaFiles(files);
      return { ok: true };
    }
  }
  if ((m = p.match(/^\/api\/users\/(\d+)\/password$/)) && method === 'POST') {
    requireHuman(s);
    const id = Number(m[1]);
    const target = q1('SELECT * FROM users WHERE id=?', id);
    if (!target) throw notFound('Member not found');
    if (target.kind !== 'human') throw bad('Plush and pet members do not have passwords');
    const b = await readJson(req);
    const pw = String(b.new_password ?? '');
    if (pw.length < 6) throw bad('Password must be at least 6 characters');
    if (id === s.user.id) {
      if (!(await verifyPassword(String(b.current_password ?? ''), target))) throw bad('Current password is incorrect');
    } else if (!s.user.is_admin) throw forbid();
    const { hash, salt } = await hashPassword(pw);
    tx(() => {
      run('UPDATE users SET password_hash=?,password_salt=? WHERE id=?', hash, salt, id);
      run('DELETE FROM sessions WHERE user_id=? AND token!=?', id, s.token);
    });
    return { ok: true };
  }

  // ----- calendar: events + automatic birthdays -----
  if (method === 'GET' && p === '/api/calendar') {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!validDate(from) || !validDate(to) || to < from || (new Date(to) - new Date(from)) / 864e5 > 400) throw bad('Invalid date range');
    const events = [];
    for (const e of q(`${EVENT_SELECT} WHERE e.yearly=1 OR (e.event_date BETWEEN ? AND ?)`, from, to)) {
      if (e.yearly) for (const o of yearlyOccurrences(e.event_date, from, to)) events.push(eventShape(e, o.date, s));
      else events.push(eventShape(e, e.event_date, s));
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    const birthdays = [];
    for (const u of q('SELECT id,display_name,kind,avatar,birthday FROM users WHERE is_admin=0 AND birthday IS NOT NULL')) {
      for (const o of yearlyOccurrences(u.birthday, from, to)) {
        birthdays.push({ user_id: u.id, display_name: u.display_name, kind: u.kind, avatar: u.avatar, date: o.date, age: o.year - Number(u.birthday.slice(0, 4)) });
      }
    }
    birthdays.sort((a, b) => a.date.localeCompare(b.date) || a.display_name.localeCompare(b.display_name));
    return { events, birthdays };
  }
  if (method === 'POST' && p === '/api/events') {
    requireHuman(s);
    const e = readEvent(await readJson(req));
    const r = run('INSERT INTO events(title,notes,location,event_date,event_time,yearly,author_id,posted_by_id) VALUES(?,?,?,?,?,?,?,?)',
      e.title, e.notes, e.location, e.date, e.time, e.yearly, s.effective.id, s.user.id);
    return { id: Number(r.lastInsertRowid) };
  }
  if ((m = p.match(/^\/api\/events\/(\d+)$/))) {
    requireHuman(s);
    const id = Number(m[1]);
    const ev = q1('SELECT * FROM events WHERE id=?', id);
    if (!ev) throw notFound('Event not found');
    if (!canManage(s, ev)) throw forbid();
    if (method === 'PUT') {
      const e = readEvent(await readJson(req), ev);
      run('UPDATE events SET title=?,notes=?,location=?,event_date=?,event_time=?,yearly=? WHERE id=?', e.title, e.notes, e.location, e.date, e.time, e.yearly, id);
      return { ok: true };
    }
    if (method === 'DELETE') { run('DELETE FROM events WHERE id=?', id); return { ok: true }; }
  }

  // ----- uploads -----
  if (method === 'POST' && p === '/api/upload') {
    requireHuman(s);
    return saveUpload(req, url, s.user);
  }

  // ----- posts -----
  if (method === 'GET' && p === '/api/posts') {
    const before = Number(url.searchParams.get('before')) || 1e12;
    const author = Number(url.searchParams.get('author')) || null;
    const limit = 20;
    const rows = q(`${POST_SELECT} WHERE p.id<? ${author ? 'AND p.author_id=?' : ''} ORDER BY p.id DESC LIMIT ${limit + 1}`, ...(author ? [before, author] : [before]));
    const more = rows.length > limit;
    return { posts: buildPosts(rows.slice(0, limit), s), more };
  }
  if (method === 'POST' && p === '/api/posts') {
    requireHuman(s);
    const b = await readJson(req);
    const body = clean(b.body, 5000);
    const mediaIds = [...new Set((Array.isArray(b.media) ? b.media : []).map(Number))].slice(0, 10);
    const pollIn = b.poll && typeof b.poll === 'object' ? b.poll : null;
    const options = pollIn ? (Array.isArray(pollIn.options) ? pollIn.options : []).map((o) => clean(o, 100)).filter(Boolean).slice(0, 8) : [];
    if (pollIn && (!clean(pollIn.question, 200) || options.length < 2)) throw bad('A poll needs a question and at least 2 options');
    if (!body && !mediaIds.length && !pollIn) throw bad('Write something or add a photo, video or poll');
    const id = tx(() => {
      const r = run('INSERT INTO posts(author_id,posted_by_id,body) VALUES(?,?,?)', s.effective.id, s.user.id, body);
      const pid = Number(r.lastInsertRowid);
      for (const mid of mediaIds) {
        const u = run('UPDATE media SET post_id=? WHERE id=? AND uploader_id=? AND post_id IS NULL AND id NOT IN (SELECT id FROM media WHERE filename IN (SELECT avatar FROM users WHERE avatar IS NOT NULL))', pid, mid, s.user.id);
        if (!u.changes) throw bad('Invalid media attachment');
      }
      setTags('post_id', pid, validTagIds(b.tags));
      if (pollIn) {
        const pr = run('INSERT INTO polls(post_id,question) VALUES(?,?)', pid, clean(pollIn.question, 200));
        for (const o of options) run('INSERT INTO poll_options(poll_id,label) VALUES(?,?)', Number(pr.lastInsertRowid), o);
      }
      return pid;
    });
    return buildPosts(q(`${POST_SELECT} WHERE p.id=?`, id), s)[0];
  }
  if ((m = p.match(/^\/api\/posts\/(\d+)$/))) {
    const id = Number(m[1]);
    const post = q1('SELECT * FROM posts WHERE id=?', id);
    if (!post) throw notFound('Post not found');
    if (method === 'GET') return buildPosts(q(`${POST_SELECT} WHERE p.id=?`, id), s)[0];
    requireHuman(s);
    if (!canManage(s, post)) throw forbid();
    if (method === 'PUT') {
      const b = await readJson(req);
      const body = b.body !== undefined ? clean(b.body, 5000) : post.body;
      const hasMedia = q1('SELECT 1 FROM media WHERE post_id=?', id), hasPoll = q1('SELECT 1 FROM polls WHERE post_id=?', id);
      if (!body && !hasMedia && !hasPoll) throw bad('A post cannot be empty');
      tx(() => {
        run(`UPDATE posts SET body=?, updated_at=datetime('now') WHERE id=?`, body, id);
        if (b.tags !== undefined) setTags('post_id', id, validTagIds(b.tags));
        if (Array.isArray(b.remove_media)) {
          for (const mid of b.remove_media.map(Number)) {
            const md = q1('SELECT filename FROM media WHERE id=? AND post_id=?', mid, id);
            if (md) { run('DELETE FROM media WHERE id=?', mid); removeMediaFiles([md]); }
          }
        }
      });
      return buildPosts(q(`${POST_SELECT} WHERE p.id=?`, id), s)[0];
    }
    if (method === 'DELETE') {
      const files = q('SELECT filename FROM media WHERE post_id=?', id);
      tx(() => run('DELETE FROM posts WHERE id=?', id));
      removeMediaFiles(files);
      return { ok: true };
    }
  }

  // likes (as the effective identity)
  if ((m = p.match(/^\/api\/posts\/(\d+)\/like$/)) && method === 'POST') {
    requireHuman(s);
    const id = Number(m[1]);
    if (!q1('SELECT 1 FROM posts WHERE id=?', id)) throw notFound('Post not found');
    if (q1('SELECT 1 FROM likes WHERE post_id=? AND user_id=?', id, s.effective.id)) run('DELETE FROM likes WHERE post_id=? AND user_id=?', id, s.effective.id);
    else run('INSERT INTO likes(post_id,user_id) VALUES(?,?)', id, s.effective.id);
    return buildPosts(q(`${POST_SELECT} WHERE p.id=?`, id), s)[0];
  }

  // votes: one per member per poll; re-voting changes it, DELETE retracts it
  if ((m = p.match(/^\/api\/polls\/(\d+)\/vote$/))) {
    requireHuman(s);
    const pollId = Number(m[1]);
    const poll = q1('SELECT * FROM polls WHERE id=?', pollId);
    if (!poll) throw notFound('Poll not found');
    if (method === 'POST') {
      const b = await readJson(req);
      const opt = q1('SELECT id FROM poll_options WHERE id=? AND poll_id=?', Number(b.option_id), pollId);
      if (!opt) throw bad('Invalid option');
      run(`INSERT INTO poll_votes(poll_id,option_id,voter_id,cast_by_id) VALUES(?,?,?,?)
        ON CONFLICT(poll_id,voter_id) DO UPDATE SET option_id=excluded.option_id, cast_by_id=excluded.cast_by_id, created_at=datetime('now')`,
        pollId, opt.id, s.effective.id, s.user.id);
    } else if (method === 'DELETE') {
      run('DELETE FROM poll_votes WHERE poll_id=? AND voter_id=?', pollId, s.effective.id);
    } else throw notFound();
    return buildPosts(q(`${POST_SELECT} WHERE p.id=?`, poll.post_id), s)[0];
  }

  // ----- comments / replies -----
  if ((m = p.match(/^\/api\/posts\/(\d+)\/comments$/)) && method === 'POST') {
    requireHuman(s);
    const postId = Number(m[1]);
    if (!q1('SELECT 1 FROM posts WHERE id=?', postId)) throw notFound('Post not found');
    const b = await readJson(req);
    const body = clean(b.body, 2000);
    if (!body) throw bad('Write a reply first');
    let parent = null;
    if (b.parent_id != null) {
      parent = q1('SELECT id,parent_id FROM comments WHERE id=? AND post_id=?', Number(b.parent_id), postId);
      if (!parent) throw bad('Invalid parent comment');
      if (parent.parent_id) parent = { id: parent.parent_id }; // keep threads one level deep
    }
    tx(() => {
      const r = run('INSERT INTO comments(post_id,parent_id,author_id,posted_by_id,body) VALUES(?,?,?,?,?)', postId, parent ? parent.id : null, s.effective.id, s.user.id, body);
      setTags('comment_id', Number(r.lastInsertRowid), validTagIds(b.tags));
    });
    return buildPosts(q(`${POST_SELECT} WHERE p.id=?`, postId), s)[0];
  }
  if ((m = p.match(/^\/api\/comments\/(\d+)$/))) {
    requireHuman(s);
    const id = Number(m[1]);
    const c = q1('SELECT * FROM comments WHERE id=?', id);
    if (!c) throw notFound('Comment not found');
    if (!canManage(s, c)) throw forbid();
    if (method === 'PUT') {
      const b = await readJson(req);
      const body = clean(b.body, 2000);
      if (!body) throw bad('A reply cannot be empty');
      tx(() => {
        run(`UPDATE comments SET body=?, updated_at=datetime('now') WHERE id=?`, body, id);
        if (b.tags !== undefined) setTags('comment_id', id, validTagIds(b.tags));
      });
    } else if (method === 'DELETE') run('DELETE FROM comments WHERE id=?', id);
    else throw notFound();
    return buildPosts(q(`${POST_SELECT} WHERE p.id=?`, c.post_id), s)[0];
  }

  throw notFound('Unknown endpoint');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw forbid('Missing request header');
      const out = await api(req, res, url);
      const json = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(json);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (p.startsWith('/media/')) {
      // media is private to logged-in members
      if (!getSession(req)) { res.writeHead(401); return res.end('Please log in'); }
      const name = path.basename(decodeURIComponent(p.slice(7)));
      const t = TYPES[path.extname(name).slice(1).toLowerCase()];
      if (!t || !/^[a-f0-9]{32}\.[a-z0-9]+$/.test(name)) { res.writeHead(404); return res.end('Not found'); }
      return serveFile(req, res, path.join(UPLOAD_DIR, name), t[0], 'private, max-age=86400');
    }
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !STATIC_TYPES[path.extname(file)]) { res.writeHead(404); return res.end('Not found'); }
    return serveFile(req, res, file, STATIC_TYPES[path.extname(file)], 'no-cache');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status === 500 ? 'Server error' : e.message }));
  }
});
server.requestTimeout = 0; // allow large uploads on slow links
seedAdmin().then(() => server.listen(PORT, HOST, () => console.log(`Family Circle running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)));
