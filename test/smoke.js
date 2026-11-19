// Smoke test: run against a server with a FRESH database (delete data/ first).  node test/smoke.js
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
let pass = 0, failn = 0;
const ok = (c, m) => { c ? pass++ : (failn++, console.log('FAIL:', m)); };
function client() {
  let cookie = '';
  return async (method, url, body, raw) => {
    const headers = { 'X-Requested-With': 'fetch' };
    if (cookie) headers.Cookie = cookie;
    let b;
    if (raw) { b = raw; headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { b = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const r = await fetch(BASE + url, { method, headers, body: b });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
}
(async () => {
  const ad = client(); let a = ad;
  ok((await a('POST', '/api/login', { username: 'admin', password: 'wrong' })).status === 401, 'bad password rejected');
  ok((await a('GET', '/api/me')).status === 401, 'unauthenticated /me rejected');
  const l = await a('POST', '/api/login', { username: 'admin', password: 'password' });
  ok(l.status === 200 && l.data.user.is_admin, 'admin login');
  ok(l.data.default_admin_password === true, 'default password flagged');
  ok((await a('POST', '/api/users', { kind: 'human', username: 'mum', display_name: 'Mum', password: 'abc' })).status === 400, 'short password rejected');
  const mum = (await a('POST', '/api/users', { kind: 'human', username: 'mum', display_name: 'Mum', password: 'secret1' })).data;
  const bear = (await a('POST', '/api/users', { kind: 'plush', username: 'bear', display_name: 'Mr Bear' })).data;
  const dog = (await a('POST', '/api/users', { kind: 'pet', username: 'rex', display_name: 'Rex' })).data;
  ok(mum.id && bear.id && dog.id, 'members created');
  ok((await a('POST', '/api/users', { kind: 'human', username: 'MUM', display_name: 'x', password: 'secret1' })).status === 400, 'duplicate username (case-insens.) rejected');
  ok(!('password_hash' in mum), 'no hash leaked');

  // family member who does the posting; admin accounts only manage
  const dad = (await ad('POST', '/api/users', { kind: 'human', username: 'dad', display_name: 'Dad', password: 'secret2' })).data;
  ok((await ad('GET', '/api/posts')).status === 403, 'admin cannot read feed');
  ok((await ad('POST', '/api/posts', { body: 'x' })).status === 403, 'admin cannot post');
  ok((await ad('POST', '/api/act-as', { user_id: bear.id })).status === 403, 'admin cannot act as');
  ok((await ad('GET', '/api/users')).data.some((u) => u.is_admin), 'admin sees admin in member list');
  a = client();
  ok((await a('POST', '/api/login', { username: 'dad', password: 'secret2' })).status === 200, 'dad login');
  ok(!(await a('GET', '/api/users')).data.some((u) => u.is_admin), 'family does not see admin');
  ok((await a('GET', '/api/users/1')).status === 404, 'family cannot fetch admin profile');
  const bearLogin = await client()('POST', '/api/login', { username: 'bear', password: '' });
  ok(bearLogin.status === 401, 'plush cannot log in directly');

  // upload image + video
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await a('POST', '/api/upload?name=pic.png', undefined, png);
  ok(up.status === 200 && up.data.kind === 'image', 'image upload');
  const vid = await a('POST', '/api/upload?name=clip.mp4', undefined, Buffer.alloc(5000, 1));
  ok(vid.status === 200 && vid.data.kind === 'video', 'video upload');
  ok((await a('POST', '/api/upload?name=evil.exe', undefined, Buffer.alloc(10))).status === 400, 'exe upload rejected');
  const media = await fetch(BASE + up.data.url, { headers: { Cookie: 'x=1' } });
  ok(media.status === 401, 'media requires login');

  // act as bear
  ok((await a('POST', '/api/act-as', { user_id: mum.id })).status === 400, 'cannot act as a human');
  const as = await a('POST', '/api/act-as', { user_id: bear.id });
  ok(as.data.effective.id === bear.id, 'acting as bear');
  const post = (await a('POST', '/api/posts', { body: 'Bear says hi <script>', media: [up.data.id, vid.data.id], tags: [mum.id, dog.id, 1],
    poll: { question: 'Best snack?', options: ['Honey', 'Biscuit'] } })).data;
  ok(post.author.id === bear.id && post.posted_by.id === dad.id, 'post authored by bear, posted by admin');
  ok(post.media.length === 2 && post.tags.length === 2 /* admin tag ignored */ && post.poll.options.length === 2, 'media/tags/poll attached');
  ok((await a('POST', '/api/posts', { body: 'x', media: [up.data.id] })).status === 400, 'media cannot be reused');

  const rng = await fetch(BASE + post.media[1].url, { headers: { Cookie: (await (async () => { const c = client(); await c('POST', '/api/login', { username: 'admin', password: 'password' }); return null; })()) || '' } });
  ok(rng.status === 401, 'media 401 without session cookie');

  // voting as bear then rex
  let v = (await a('POST', `/api/polls/${post.poll.id}/vote`, { option_id: post.poll.options[0].id })).data;
  ok(v.poll.total === 1 && v.poll.my_vote === post.poll.options[0].id, 'bear voted');
  v = (await a('POST', `/api/polls/${post.poll.id}/vote`, { option_id: post.poll.options[1].id })).data;
  ok(v.poll.total === 1 && v.poll.options[1].count === 1, 'bear re-vote replaces (no double vote)');
  await a('POST', '/api/act-as', { user_id: dog.id });
  v = (await a('POST', `/api/polls/${post.poll.id}/vote`, { option_id: post.poll.options[0].id })).data;
  ok(v.poll.total === 2, 'rex votes separately');
  const rc = (await a('POST', `/api/posts/${post.id}/comments`, { body: 'Woof', tags: [bear.id] })).data;
  ok(rc.comments[0].author.id === dog.id, 'comment as rex');
  const reply = (await a('POST', `/api/posts/${post.id}/comments`, { body: 'Reply', parent_id: rc.comments[0].id })).data;
  ok(reply.comments[1].parent_id === rc.comments[0].id, 'threaded reply');
  ok((await a('POST', `/api/posts/${post.id}/like`)).data.liked === true, 'like');

  // permissions: mum cannot edit others' posts, cannot delete members
  const m = client();
  ok((await m('POST', '/api/login', { username: 'mum', password: 'secret1' })).data.default_admin_password === false, 'mum login');
  ok((await m('PUT', `/api/posts/${post.id}`, { body: 'hijack' })).status === 403, 'mum cannot edit admin-posted post');
  ok((await m('DELETE', `/api/users/${dog.id}`)).status === 403, 'mum cannot remove members');
  ok((await m('POST', `/api/users/1/password`, { new_password: 'hacked1' })).status === 403, 'mum cannot reset admin password');
  ok((await m('POST', '/api/posts', { body: 'x' }, undefined)).status === 200, 'mum can post');
  // CSRF header
  const noHdr = await fetch(BASE + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(noHdr.status === 403, 'missing X-Requested-With blocked');

  // edit & delete as admin
  const ed = (await a('PUT', `/api/posts/${post.id}`, { body: 'Edited', tags: [mum.id], remove_media: [post.media[1].id] })).data;
  ok(ed.body === 'Edited' && ed.tags.length === 1 && ed.media.length === 1 && ed.updated_at, 'post edited');
  ok((await a('DELETE', `/api/comments/${rc.comments[0].id}`)).data.comments.length === 0, 'comment delete cascades replies');
  ok((await ad('POST', '/api/users/1/password', { current_password: 'password', new_password: 'newpass1' })).status === 200, 'admin changes password');
  ok((await ad('DELETE', '/api/users/1')).status === 400, 'cannot remove self');
  ok((await ad('DELETE', `/api/users/${mum.id}`)).status === 200, 'admin removes mum');
  ok((await a('DELETE', `/api/posts/${post.id}`)).status === 200, 'post deleted');
  ok((await a('GET', '/api/posts')).data.posts.length === 0, 'feed empty (mum posts gone)');
  ok((await fetch(BASE + '/../server.js')).status !== 200 && (await fetch(BASE + '/%2e%2e/server.js')).status === 404, 'no path traversal');
  // ----- calendar -----
  const bd = await a('PUT', `/api/users/${bear.id}`, { birthday: '2020-02-29' });
  ok(bd.status === 200 && bd.data.birthday === '2020-02-29', 'birthday saved on plush');
  ok((await a('PUT', `/api/users/${bear.id}`, { birthday: '2999-01-01' })).status === 400, 'future birthday rejected');
  ok((await a('PUT', `/api/users/${bear.id}`, { birthday: 'nope' })).status === 400, 'bad birthday rejected');
  let cal = (await a('GET', '/api/calendar?from=2023-02-01&to=2023-03-01')).data;
  ok(cal.birthdays.length === 1 && cal.birthdays[0].date === '2023-02-28' && cal.birthdays[0].age === 3, 'Feb 29 birthday lands on Feb 28 in non-leap year, age 3');
  cal = (await a('GET', '/api/calendar?from=2024-02-01&to=2024-03-01')).data;
  ok(cal.birthdays[0].date === '2024-02-29' && cal.birthdays[0].age === 4, 'Feb 29 birthday on leap year');
  cal = (await a('GET', '/api/calendar?from=2019-02-01&to=2019-03-01')).data;
  ok(cal.birthdays.length === 0, 'no birthday before birth year');
  ok((await a('POST', '/api/events', { title: '', date: '2026-03-05' })).status === 400, 'event needs title');
  ok((await a('POST', '/api/events', { title: 'x', date: '2026-02-30' })).status === 400, 'invalid date rejected');
  ok((await a('POST', '/api/events', { title: 'x', date: '2026-03-05', time: '25:00' })).status === 400, 'invalid time rejected');
  const ev = await a('POST', '/api/events', { title: 'Picnic <b>', date: '2026-03-05', time: '10:30', location: 'Park', yearly: true });
  ok(ev.status === 200 && ev.data.id, 'event created');
  await a('POST', '/api/act-as', { user_id: bear.id });
  const ev2 = await a('POST', '/api/events', { title: 'Bear nap', date: '2026-03-06' });
  cal = (await a('GET', '/api/calendar?from=2027-03-01&to=2027-03-31')).data;
  ok(cal.events.length === 1 && cal.events[0].date === '2027-03-05' && cal.events[0].yearly, 'yearly event repeats next year');
  cal = (await a('GET', '/api/calendar?from=2026-03-01&to=2026-03-31')).data;
  ok(cal.events.length === 2 && cal.events[1].author.display_name === 'Mr Bear' && !JSON.stringify(cal).includes('via'), 'event authored as bear, no "via"');
  ok((await ad('GET', '/api/calendar?from=2026-03-01&to=2026-03-31')).status === 403, 'admin cannot read calendar');
  ok((await ad('POST', '/api/events', { title: 'x', date: '2026-03-05' })).status === 403, 'admin cannot add events');
  const eve = client();
  await ad('POST', '/api/users', { kind: 'human', username: 'eve', display_name: 'Eve', password: 'secret3' });
  await eve('POST', '/api/login', { username: 'eve', password: 'secret3' });
  ok((await eve('PUT', `/api/events/${ev.data.id}`, { title: 'hijack' })).status === 403, 'other member cannot edit event');
  ok((await eve('DELETE', `/api/events/${ev.data.id}`)).status === 403, 'other member cannot delete event');
  ok((await a('PUT', `/api/events/${ev.data.id}`, { title: 'Picnic 2', time: '' })).status === 200, 'event edited');
  cal = (await a('GET', '/api/calendar?from=2026-03-01&to=2026-03-31')).data;
  ok(cal.events.some((e) => e.title === 'Picnic 2' && e.time === null), 'edit persisted, all-day');
  ok((await a('DELETE', `/api/events/${ev.data.id}`)).status === 200 && (await a('DELETE', `/api/events/${ev2.data.id}`)).status === 200, 'events deleted');
  ok((await a('GET', '/api/calendar?from=2026-01-01&to=2026-12-31')).status === 200 && (await a('GET', '/api/calendar?from=2000-01-01&to=2028-12-31')).status === 400, 'range limit');
  console.log(`${pass} passed, ${failn} failed`);
  process.exit(failn ? 1 : 0);
})();
