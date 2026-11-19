'use strict';
// Password hashing helpers (scrypt, per-user salt, constant-time compare).
// Uses the async scrypt so hashing runs on the libuv thread pool and never blocks the event loop.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

async function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: (await scrypt(pw, salt, 64)).toString('hex') };
}

async function verifyPassword(pw, user) {
  if (!user.password_hash || !user.password_salt) return false;
  const a = await scrypt(pw, user.password_salt, 64);
  const b = Buffer.from(user.password_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Burn the same CPU as a real check so unknown usernames are not distinguishable by timing.
async function dummyVerify(pw) {
  await scrypt(pw, 'x'.repeat(16), 64);
}

module.exports = { hashPassword, verifyPassword, dummyVerify };
