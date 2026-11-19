'use strict';
// Failed-login throttle. Blocks a username from one IP after `max` failures, and an IP after
// `maxPerIp` failures across all usernames (so rotating usernames does not dodge the limit).
// Old entries are swept so the maps cannot grow without bound.
function createThrottle({ windowMs = 5 * 60 * 1000, max = 8, maxPerIp = 30, now = Date.now } = {}) {
  const byKey = new Map(); // "ip|user" -> [timestamps]
  const byIp = new Map();  // ip -> [timestamps]
  let lastSweep = now();
  const keyOf = (ip, user) => ip + '|' + String(user).toLowerCase();
  const recent = (arr, t) => (arr || []).filter((x) => t - x < windowMs);

  function sweep(t) {
    lastSweep = t;
    for (const m of [byKey, byIp]) {
      for (const [k, arr] of m) {
        const keep = recent(arr, t);
        if (keep.length) m.set(k, keep); else m.delete(k);
      }
    }
  }
  function blocked(ip, user) {
    const t = now();
    return recent(byKey.get(keyOf(ip, user)), t).length >= max || recent(byIp.get(ip), t).length >= maxPerIp;
  }
  function fail(ip, user) {
    const t = now();
    if (t - lastSweep >= windowMs) sweep(t);
    const key = keyOf(ip, user);
    byKey.set(key, [...recent(byKey.get(key), t), t]);
    byIp.set(ip, [...recent(byIp.get(ip), t), t]);
  }
  function succeed(ip, user) { byKey.delete(keyOf(ip, user)); }
  return { blocked, fail, succeed, size: () => byKey.size };
}

module.exports = { createThrottle };
