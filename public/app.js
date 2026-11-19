'use strict';
// All user-provided text is inserted with textContent (never innerHTML) to prevent XSS.
const $app = document.getElementById('app');
const state = { me: null, users: [], posts: [], more: false, filter: null };
const ICON = { human: '🙂', plush: '🧸', pet: '🐾' };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); }

async function api(method, url, body, raw) {
  const opt = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (raw) { opt.body = raw; opt.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opt);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && state.me) { state.me = null; renderLogin('Your session expired. Please log in again.'); }
    throw new Error(data.error || res.statusText);
  }
  return data;
}
function toast(msg) { const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2800); }
const fail = (e) => toast(e.message || String(e));

function when(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function avatar(u, cls = '') {
  const c = `avatar ${cls} ${u.kind !== 'human' ? u.kind : ''}`;
  return u.avatar ? h('img', { class: c + ' photo', src: '/media/' + u.avatar, alt: '' }) : h('span', { class: c }, ICON[u.kind] || '🙂');
}
const badge = (u) => u.kind !== 'human' ? h('span', { class: 'badge ' + u.kind }, u.kind) : (u.is_admin ? h('span', { class: 'badge admin' }, 'admin') : null);
const eff = () => state.me.effective;

// ---------------- login ----------------
function renderLogin(msg) {
  const err = h('div', { class: 'err' }, msg || '');
  const user = h('input', { type: 'text', autocomplete: 'username', autofocus: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const go = async (e) => {
    e.preventDefault();
    try {
      state.me = await api('POST', '/api/login', { username: user.value, password: pass.value });
      await boot();
    } catch (x) { err.textContent = x.message; }
  };
  fill($app, h('form', { class: 'login', onsubmit: go },
    h('h1', {}, '🧸 Family Circle'), h('div', { class: 'muted' }, 'A private place for the family, the plushies and the pets.'),
    h('label', {}, 'Username'), user, h('label', {}, 'Password'), pass,
    h('button', { class: 'btn', type: 'submit' }, 'Log in'), err));
}

// ---------------- shell ----------------
async function boot() {
  try {
    if (!state.me) state.me = await api('GET', '/api/me');
  } catch { return renderLogin(); }
  await refreshUsers();
  if (state.me.user.is_admin) return renderAdminShell();
  renderShell();
  await loadPosts(true);
}
async function refreshUsers() { state.users = await api('GET', '/api/users'); }

let feedEl, composerEl, sideEl, topEl, bannerEl, feedWrap, calEl, tabsEl;
// Administrators only manage members; they never see the family's content.
function renderAdminShell() {
  topEl = h('div', { class: 'top' });
  bannerEl = h('div');
  const box = h('div', { class: 'card' });
  fill($app, topEl, bannerEl, h('div', { class: 'layout', style: 'grid-template-columns:1fr;max-width:640px' }, h('main', {}, box)));
  fill(topEl, h('span', { class: 'brand' }, '🧸 Family Circle'), h('span', { class: 'muted' }, 'Administrator console'), h('span', { class: 'grow' }),
    h('button', { class: 'btn ghost sm', onclick: () => openPassword(state.me.user) }, 'Password'),
    h('button', { class: 'btn ghost sm', onclick: async () => { try { await api('POST', '/api/logout'); } catch {} state.me = null; renderLogin(); } }, 'Log out'));
  if (state.me.default_admin_password) fill(bannerEl, h('div', { class: 'banner warn' }, 'The admin account still uses the default password. ',
    h('button', { class: 'link', onclick: () => openPassword(state.me.user) }, 'Change it now')));
  openMembers(undefined, box);
}

function renderShell() {
  topEl = h('div', { class: 'top' });
  bannerEl = h('div');
  sideEl = h('div', { class: 'side' });
  composerEl = h('div');
  feedEl = h('div');
  feedWrap = h('div', {}, composerEl, feedEl);
  calEl = h('div', { hidden: true });
  tabsEl = h('div', { class: 'tabs' });
  fill($app, topEl, bannerEl, h('div', { class: 'layout' }, sideEl, h('main', {}, tabsEl, feedWrap, calEl)));
  state.view = 'feed';
  drawTabs();
  renderTop(); renderSide(); renderComposer();
}

function renderTop() {
  const nonHumans = state.users.filter((u) => u.kind !== 'human');
  const sel = h('select', { 'aria-label': 'Act as', onchange: async (e) => {
    try {
      state.me = await api('POST', '/api/act-as', { user_id: e.target.value ? Number(e.target.value) : null });
      renderTop(); renderComposer(); await loadPosts(true);
      if (state.view === 'calendar') loadCalendar();
    } catch (x) { fail(x); }
  } },
    h('option', { value: '' }, `Myself (${state.me.user.display_name})`),
    nonHumans.map((u) => h('option', { value: u.id, selected: state.me.acting_as && state.me.acting_as.id === u.id }, `${ICON[u.kind]} ${u.display_name}`)));
  fill(topEl, 
    h('span', { class: 'brand' }, '🧸 Family Circle'), h('span', { class: 'grow' }),
    nonHumans.length ? h('span', { class: 'actas' }, 'Act as:', sel) : null,
    h('button', { class: 'btn ghost sm', onclick: () => openMembers() }, 'Members'),
    h('button', { class: 'btn ghost sm', onclick: () => openMembers(state.me.user.id) }, 'My photo'),
    h('button', { class: 'btn ghost sm', onclick: () => openPassword(state.me.user) }, 'Password'),
    h('button', { class: 'btn ghost sm', onclick: async () => { try { await api('POST', '/api/logout'); } catch {} state.me = null; renderLogin(); } }, `Log out ${state.me.user.display_name}`));
  const b = [];
  if (state.me.acting_as) b.push(h('div', { class: 'banner acting' }, `You are acting as ${ICON[eff().kind]} ${eff().display_name}. Posts, replies and votes will appear from them. `,
    h('button', { class: 'link', onclick: () => { const s = topEl.querySelector('select'); s.value = ''; s.dispatchEvent(new Event('change')); } }, 'Switch back to me')));
  if (state.me.default_admin_password) b.push(h('div', { class: 'banner warn' }, 'The admin account still uses the default password. ',
    h('button', { class: 'link', onclick: () => openPassword(state.me.user) }, 'Change it now')));
  fill(bannerEl, ...b);
}

function renderSide() {
  fill(sideEl, h('h3', {}, `Family (${state.users.length})`),
    h('button', { class: 'member' + (state.filter == null ? ' on' : ''), onclick: () => { state.filter = null; renderSide(); setView('feed'); loadPosts(true); } }, h('span', { class: 'avatar sm' }, '🏠'), 'Everyone'),
    ...state.users.map((u) => h('button', { class: 'member' + (state.filter === u.id ? ' on' : ''), onclick: () => { state.filter = u.id; renderSide(); setView('feed'); loadPosts(true); } },
      avatar(u, 'sm'), h('span', {}, u.display_name), badge(u))));
}

// ---------------- tag picker ----------------
function tagPicker(selected, onChange) {
  const box = h('div', { class: 'chips' });
  const draw = () => fill(box, ...state.users.map((u) => h('button', { type: 'button', class: 'chip' + (selected.has(u.id) ? ' on' : ''),
    onclick: () => { selected.has(u.id) ? selected.delete(u.id) : selected.add(u.id); draw(); onChange && onChange(); } }, `${ICON[u.kind]} ${u.display_name}`)));
  draw();
  return box;
}

// ---------------- composer ----------------
function renderComposer() {
  const text = h('textarea', { placeholder: `What's happening, ${eff().display_name}?`, maxlength: 5000 });
  const tags = new Set(); let tagBox = null, pollBox = null;
  const files = []; const previews = h('div', { class: 'previews' });
  const err = h('div', { class: 'err' });
  const fileIn = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', style: 'display:none', onchange: () => {
    for (const f of fileIn.files) files.push(f);
    fileIn.value = ''; drawPrev();
  } });
  const drawPrev = () => fill(previews, ...files.map((f, i) => h('span', { class: 'preview' }, (f.type.startsWith('video') ? '🎬 ' : '🖼️ ') + f.name + ' ',
    h('button', { type: 'button', class: 'link danger', onclick: () => { files.splice(i, 1); drawPrev(); } }, '✕'))));
  const pollQ = h('input', { type: 'text', placeholder: 'Poll question', maxlength: 200 });
  const pollOpts = [h('input', { type: 'text', placeholder: 'Option 1', maxlength: 100 }), h('input', { type: 'text', placeholder: 'Option 2', maxlength: 100 })];
  const optHolder = h('div', {}, pollOpts);
  const addOpt = h('button', { type: 'button', class: 'link', onclick: () => { if (pollOpts.length < 8) { const i = h('input', { type: 'text', placeholder: 'Option ' + (pollOpts.length + 1), maxlength: 100 }); pollOpts.push(i); optHolder.append(i); } } }, '+ add option');
  const pollForm = h('div', { class: 'pollform', hidden: true }, pollQ, optHolder, addOpt);
  const tagHolder = h('div');
  const send = h('button', { class: 'btn', type: 'button', onclick: async () => {
    err.textContent = ''; send.disabled = true;
    try {
      const media = [];
      for (const f of files) {
        send.textContent = `Uploading ${f.name}…`;
        media.push((await api('POST', '/api/upload?name=' + encodeURIComponent(f.name), undefined, f)).id);
      }
      const body = { body: text.value, media, tags: [...tags] };
      if (!pollForm.hidden) body.poll = { question: pollQ.value, options: pollOpts.map((o) => o.value) };
      const post = await api('POST', '/api/posts', body);
      state.posts.unshift(post);
      if (state.filter != null && state.filter !== post.author.id) { state.filter = null; renderSide(); await loadPosts(true); }
      renderComposer(); renderFeed();
    } catch (e) { err.textContent = e.message; }
    send.disabled = false; send.textContent = 'Post';
  } }, 'Post');
  fill(composerEl, h('div', { class: 'card composer' },
    h('div', { class: 'row' }, avatar(eff(), 'sm'), h('span', {}, 'Posting as ', h('b', {}, eff().display_name))), text, previews, tagHolder, pollForm,
    h('div', { class: 'tools' },
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => fileIn.click() }, '📷 Photo / video'), fileIn,
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { pollForm.hidden = !pollForm.hidden; } }, '📊 Poll'),
      h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { if (tagBox) { tagBox.remove(); tagBox = null; } else { tagBox = tagPicker(tags); tagHolder.append(tagBox); } } }, '🏷️ Tag'),
      h('span', { class: 'grow' }), send), err));
}

// ---------------- feed ----------------
async function loadPosts(reset) {
  try {
    const qs = new URLSearchParams();
    if (!reset && state.posts.length) qs.set('before', state.posts[state.posts.length - 1].id);
    if (state.filter != null) qs.set('author', state.filter);
    const r = await api('GET', '/api/posts?' + qs);
    state.posts = reset ? r.posts : state.posts.concat(r.posts);
    state.more = r.more;
    renderFeed();
  } catch (e) { fail(e); }
}
function renderFeed() {
  if (!state.posts.length) return fill(feedEl, h('div', { class: 'empty' }, 'Nothing here yet. Be the first to post! 🎉'));
  fill(feedEl, ...state.posts.map(postCard),
    state.more ? h('button', { class: 'btn ghost', style: 'width:100%', onclick: () => loadPosts(false) }, 'Load older posts') : null);
}
function replacePost(post) {
  const i = state.posts.findIndex((p) => p.id === post.id);
  if (i >= 0) state.posts[i] = post;
  const old = document.getElementById('post-' + post.id);
  if (old) old.replaceWith(postCard(post)); else renderFeed();
}
const tagsLine = (tags) => tags.length ? h('div', { class: 'tagline' }, '🏷️ with ', tags.map((t, i) => [i ? ', ' : '', h('span', { class: 'tag' }, '@' + t.display_name)])) : null;
function byline(x) {
  return h('div', { class: 'meta' }, h('b', {}, x.author.display_name), badge(x.author),
    h('div', { class: 'muted' }, when(x.created_at) + (x.updated_at ? ' · edited' : '')));
}
function lightbox(src) { const lb = h('div', { class: 'lightbox', onclick: () => lb.remove() }, h('img', { src })); document.body.append(lb); }

function postCard(p) {
  const card = h('article', { class: 'card', id: 'post-' + p.id });
  const call = (fn) => async (...a) => { try { replacePost(await fn(...a)); } catch (e) { fail(e); } };

  const head = h('div', { class: 'post-head' }, avatar(p.author), byline(p),
    p.can_edit ? [h('button', { class: 'link', onclick: () => editPost(p, card) }, 'Edit'),
      h('button', { class: 'link danger', onclick: async () => {
        if (!confirm('Delete this post and everything on it?')) return;
        try { await api('DELETE', '/api/posts/' + p.id); state.posts = state.posts.filter((x) => x.id !== p.id); card.remove(); if (!state.posts.length) renderFeed(); } catch (e) { fail(e); }
      } }, 'Delete')] : null);

  const media = p.media.length ? h('div', { class: 'media' }, p.media.map((m) => m.kind === 'video'
    ? h('video', { src: m.url, controls: true, preload: 'metadata', playsinline: true })
    : h('img', { src: m.url, alt: 'photo', loading: 'lazy', onclick: () => lightbox(m.url) }))) : null;

  let poll = null;
  if (p.poll) {
    const pl = p.poll;
    poll = h('div', { class: 'poll' }, h('div', { class: 'q' }, '📊 ' + pl.question),
      pl.options.map((o) => h('button', { class: 'opt' + (pl.my_vote === o.id ? ' mine' : ''), title: o.voters.join(', ') || 'No votes yet',
        onclick: call(() => api(pl.my_vote === o.id ? 'DELETE' : 'POST', `/api/polls/${pl.id}/vote`, pl.my_vote === o.id ? undefined : { option_id: o.id })) },
        h('span', { class: 'fill', style: `width:${pl.total ? Math.round(o.count * 100 / pl.total) : 0}%` }),
        h('span', { class: 'l' }, h('span', {}, (pl.my_vote === o.id ? '✓ ' : '') + o.label), h('span', {}, `${o.count}${o.voters.length ? ' · ' + o.voters.join(', ') : ''}`)))),
      h('div', { class: 'muted' }, `${pl.total} vote${pl.total === 1 ? '' : 's'} · voting as ${eff().display_name} (tap your choice again to undo)`));
  }

  const likeNames = p.likes.map((l) => l.display_name).join(', ');
  const actions = h('div', { class: 'actions' },
    h('button', { class: 'btn ghost sm', onclick: call(() => api('POST', `/api/posts/${p.id}/like`)) }, (p.liked ? '❤️' : '🤍') + ' Like' + (p.likes.length ? ` · ${p.likes.length}` : '')),
    likeNames ? h('span', { class: 'muted' }, likeNames) : null);

  fill(card, head, p.body ? h('div', { class: 'body' }, p.body) : null, media, poll, tagsLine(p.tags), actions, commentsBlock(p));
  return card;
}

function editPost(p, card) {
  const text = h('textarea', { value: p.body });
  const tags = new Set(p.tags.map((t) => t.id));
  const remove = new Set();
  const err = h('div', { class: 'err' });
  const mediaList = p.media.length ? h('div', { class: 'previews' }, p.media.map((m) => {
    const pv = h('span', { class: 'preview' }, (m.kind === 'video' ? '🎬 video ' : '🖼️ photo '), h('button', { type: 'button', class: 'link danger', onclick: () => {
      if (remove.has(m.id)) { remove.delete(m.id); pv.style.opacity = 1; } else { remove.add(m.id); pv.style.opacity = .4; } } }, 'remove'));
    return pv;
  })) : null;
  fill(card, h('div', { class: 'post-head' }, avatar(p.author), byline(p)), text, mediaList, tagPicker(tags), err,
    h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: async () => {
      try { replacePost(await api('PUT', '/api/posts/' + p.id, { body: text.value, tags: [...tags], remove_media: [...remove] })); } catch (e) { err.textContent = e.message; }
    } }, 'Save'), h('button', { class: 'btn ghost sm', onclick: () => replacePost(p) }, 'Cancel')));
}

function commentsBlock(p) {
  const wrap = h('div', { class: 'comments' });
  const top = p.comments.filter((c) => !c.parent_id);
  const render = (c, isReply) => {
    const row = h('div', { class: 'comment' + (isReply ? ' reply' : '') }, avatar(c.author, 'sm'));
    const bubble = h('div', { class: 'bubble' }, h('b', {}, c.author.display_name), badge(c.author),
      h('div', { class: 'body' }, c.body), tagsLine(c.tags),
      h('div', { class: 'muted' }, when(c.created_at) + (c.updated_at ? ' · edited' : '') + ' ',
        h('button', { class: 'link', onclick: () => replyForm(c, row) }, 'Reply'),
        c.can_edit ? [h('button', { class: 'link', onclick: () => editComment(c, bubble) }, 'Edit'),
          h('button', { class: 'link danger', onclick: async () => { if (confirm('Delete this comment?')) try { replacePost(await api('DELETE', '/api/comments/' + c.id)); } catch (e) { fail(e); } } }, 'Delete')] : null));
    row.append(bubble);
    return row;
  };
  const replyForm = (c, row) => {
    if (row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains('cform')) return row.nextSibling.remove();
    const f = commentForm(p, c.parent_id || c.id, `Reply to ${c.author.display_name}…`);
    f.classList.add('reply'); f.style.marginLeft = '36px';
    row.after(f); f.querySelector('input[type=text]').focus();
  };
  for (const c of top) {
    wrap.append(render(c, false));
    for (const r of p.comments.filter((x) => x.parent_id === c.id)) wrap.append(render(r, true));
  }
  wrap.append(commentForm(p, null, `Comment as ${eff().display_name}…`));
  return wrap;
}
function commentForm(p, parentId, placeholder) {
  const input = h('input', { type: 'text', placeholder, maxlength: 2000 });
  const tags = new Set(); let box = null;
  const holder = h('div', { style: 'flex-basis:100%' });
  const submit = async () => {
    if (!input.value.trim()) return;
    try { replacePost(await api('POST', `/api/posts/${p.id}/comments`, { body: input.value, parent_id: parentId, tags: [...tags] })); } catch (e) { fail(e); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  return h('div', { class: 'cform' }, input,
    h('button', { class: 'btn ghost sm', type: 'button', title: 'Tag someone', onclick: () => { if (box) { box.remove(); box = null; } else { box = tagPicker(tags); holder.append(box); } } }, '🏷️'),
    h('button', { class: 'btn sm', type: 'button', onclick: submit }, 'Send'), holder);
}
function editComment(c, bubble) {
  const input = h('input', { type: 'text', value: c.body, maxlength: 2000 });
  const tags = new Set(c.tags.map((t) => t.id));
  const save = async () => { try { replacePost(await api('PUT', '/api/comments/' + c.id, { body: input.value, tags: [...tags] })); } catch (e) { fail(e); } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const post = state.posts.find((p) => p.comments.some((x) => x.id === c.id));
  fill(bubble, input, tagPicker(tags), h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: save }, 'Save'), h('button', { class: 'btn ghost sm', onclick: () => replacePost(post) }, 'Cancel')));
}

// ---------------- modals ----------------
function modal(title, content) {
  const bg = h('div', { class: 'modal-bg', onmousedown: (e) => { if (e.target === bg) bg.remove(); } },
    h('div', { class: 'modal' }, h('div', { class: 'head' }, h('h2', {}, title), h('button', { class: 'btn ghost sm', onclick: () => bg.remove() }, '✕')), content));
  document.body.append(bg);
  return bg;
}

function openPassword(user) {
  const self = user.id === state.me.user.id;
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'err' });
  const m = modal(self ? 'Change my password' : `Reset password for ${user.display_name}`, h('div', {},
    self ? [h('label', {}, 'Current password'), cur] : null, h('label', {}, 'New password (min 6 characters)'), nw, err,
    h('button', { class: 'btn', style: 'margin-top:12px', onclick: async () => {
      try {
        await api('POST', `/api/users/${user.id}/password`, { current_password: cur.value, new_password: nw.value });
        m.remove(); toast('Password updated');
        if (self) { state.me = await api('GET', '/api/me'); renderTop(); }
      } catch (e) { err.textContent = e.message; }
    } }, 'Save')));
}

async function uploadAvatar(file) {
  return (await api('POST', '/api/upload?name=' + encodeURIComponent(file.name), undefined, file)).id;
}

function openMembers(editId, inline) {
  const adminView = !!state.me.user.is_admin;
  const body = inline || h('div');
  if (!inline) modal('Family members', body);
  const draw = () => {
    const isAdmin = state.me.user.is_admin;
    const list = state.users.map((u) => {
      const canEdit = isAdmin || u.id === state.me.user.id || u.kind !== 'human';
      return h('div', { class: 'mrow' }, avatar(u), h('div', { class: 'grow' }, h('b', {}, u.display_name), badge(u), h('div', { class: 'muted' }, '@' + u.username + (u.birthday ? ' · 🎂 ' + u.birthday : '') + (u.bio ? ' · ' + u.bio : ''))),
        canEdit ? h('button', { class: 'btn ghost sm', onclick: () => editMember(u) }, 'Edit') : null,
        isAdmin && u.kind === 'human' && u.id !== state.me.user.id ? h('button', { class: 'btn ghost sm', onclick: () => openPassword(u) }, 'Reset password') : null,
        isAdmin && u.id !== state.me.user.id ? h('button', { class: 'btn danger sm', onclick: async () => {
          if (!confirm(`Remove ${u.display_name}? Their own posts, replies, votes and events will be deleted. Anything they posted as a plush or pet stays. This cannot be undone.`)) return;
          try { await api('DELETE', '/api/users/' + u.id); await afterUsersChange(); draw(); } catch (e) { fail(e); }
        } }, 'Remove') : null);
    });
    fill(body, h('div', { class: 'muted' }, `${state.users.length} of 50 accounts. ` + (adminView ? 'Administrators manage accounts only and never see the family\'s posts. Plush & pet members can\'t log in; family members act as them.' : 'Plush & pet members can\'t log in — a human acts as them using the "Act as" menu.')), ...list, addForm());
  };
  const afterUsersChange = async () => {
    await refreshUsers(); state.me = await api('GET', '/api/me');
    if (adminView) return;
    renderTop(); renderSide(); renderComposer(); await loadPosts(true);
  };
  const editMember = (u) => {
    const name = h('input', { type: 'text', value: u.display_name, maxlength: 60 });
    const bio = h('input', { type: 'text', value: u.bio || '', maxlength: 300 });
    const bday = h('input', { type: 'date', value: u.birthday || '', max: ymd(new Date()) });
    const pic = h('input', { type: 'file', accept: 'image/*' });
    const admin = null;
    const err = h('div', { class: 'err' });
    const e = modal(`Edit ${u.display_name}`, h('div', {}, h('label', {}, 'Display name'), name, h('label', {}, 'About'), bio, h('label', {}, 'Birthday (shows on the calendar)'), bday, h('label', {}, 'Profile picture'), pic,
      admin ? h('label', {}, admin, ' Administrator') : null, err,
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: async () => {
        try {
          const patch = { display_name: name.value, bio: bio.value, birthday: bday.value || null };
          if (pic.files[0]) patch.avatar_media_id = await uploadAvatar(pic.files[0]);
          if (admin) patch.is_admin = admin.checked;
          await api('PUT', '/api/users/' + u.id, patch);
          e.remove(); await afterUsersChange(); draw();
        } catch (x) { err.textContent = x.message; }
      } }, 'Save')));
  };
  const addForm = () => {
    const kind = h('select', {}, h('option', { value: 'human' }, '🙂 Human (can log in)'), h('option', { value: 'plush' }, '🧸 Plush toy'), h('option', { value: 'pet' }, '🐾 Pet'));
    const username = h('input', { type: 'text', maxlength: 30, autocomplete: 'off' });
    const display = h('input', { type: 'text', maxlength: 60 });
    const pic = h('input', { type: 'file', accept: 'image/*' });
    const bday = h('input', { type: 'date', max: ymd(new Date()) });
    const pw = h('input', { type: 'password', autocomplete: 'new-password' });
    const pwLabel = h('label', {}, 'Password (min 6 characters)');
    const adm = h('input', { type: 'checkbox' });
    const admLabel = h('label', {}, adm, ' Administrator (manages members only; no feed, cannot post)');
    admLabel.hidden = !state.me.user.is_admin;
    const err = h('div', { class: 'err' });
    kind.addEventListener('change', () => { const hu = kind.value === 'human'; pw.hidden = pwLabel.hidden = !hu; admLabel.hidden = !hu || !state.me.user.is_admin; });
    return h('div', { style: 'border-top:2px solid var(--line);margin-top:10px;padding-top:6px' }, h('h3', {}, 'Add a member'),
      h('label', {}, 'Type'), kind, h('label', {}, 'Username'), username, h('label', {}, 'Display name'), display, h('label', {}, 'Profile picture (optional)'), pic, h('label', {}, 'Birthday (optional)'), bday, pwLabel, pw, admLabel, err,
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: async () => {
        try {
          const avatar_media_id = pic.files[0] ? await uploadAvatar(pic.files[0]) : undefined;
          await api('POST', '/api/users', { kind: kind.value, username: username.value, display_name: display.value, password: pw.value, is_admin: adm.checked, avatar_media_id, birthday: bday.value || undefined });
          toast('Member added'); await afterUsersChange(); draw();
        } catch (x) { err.textContent = x.message; }
      } }, 'Add member'));
  };
  draw();
  if (editId) { const u = state.users.find((x) => x.id === editId); if (u) editMember(u); }
}

// ---------------- calendar ----------------
const pad2 = (n) => String(n).padStart(2, '0');
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
const parseYmd = (t) => { const [y, m, d] = t.split('-').map(Number); return new Date(y, m - 1, d); };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const time12 = (t) => { if (!t) return ''; const [hh, mm] = t.split(':').map(Number); return ((hh % 12) || 12) + ':' + pad2(mm) + (hh < 12 ? 'am' : 'pm'); };

function drawTabs() {
  fill(tabsEl,
    h('button', { class: 'tab' + (state.view === 'feed' ? ' on' : ''), onclick: () => setView('feed') }, '📰 Feed'),
    h('button', { class: 'tab' + (state.view === 'calendar' ? ' on' : ''), onclick: () => setView('calendar') }, '📅 Calendar'));
}
function setView(v) {
  state.view = v;
  feedWrap.hidden = v !== 'feed';
  calEl.hidden = v !== 'calendar';
  drawTabs();
  if (v === 'calendar') loadCalendar();
}

async function loadCalendar() {
  const t = new Date();
  if (!state.cal) state.cal = { month: new Date(t.getFullYear(), t.getMonth(), 1), selected: ymd(t), data: { events: [], birthdays: [] }, upcoming: { events: [], birthdays: [] }, form: null };
  const c = state.cal;
  const start = new Date(c.month.getFullYear(), c.month.getMonth(), 1 - c.month.getDay());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 41);
  c.start = start;
  try {
    const soon = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 60);
    const [data, upcoming] = await Promise.all([
      api('GET', '/api/calendar?from=' + ymd(start) + '&to=' + ymd(end)),
      api('GET', '/api/calendar?from=' + ymd(t) + '&to=' + ymd(soon))]);
    c.data = data; c.upcoming = upcoming;
    renderCalendar();
  } catch (e) { fail(e); }
}

function renderCalendar() {
  const c = state.cal, today = ymd(new Date());
  const byDay = {};
  for (const b of c.data.birthdays) (byDay[b.date] ||= { b: [], e: [] }).b.push(b);
  for (const e of c.data.events) (byDay[e.date] ||= { b: [], e: [] }).e.push(e);
  const go = (delta) => { c.month = new Date(c.month.getFullYear(), c.month.getMonth() + delta, 1); c.form = null; loadCalendar(); };

  const head = h('div', { class: 'calhead' },
    h('button', { class: 'btn ghost sm', onclick: () => go(-1), 'aria-label': 'Previous month' }, '‹'),
    h('b', { class: 'grow' }, MONTHS[c.month.getMonth()] + ' ' + c.month.getFullYear()),
    h('button', { class: 'btn ghost sm', onclick: () => { const t = new Date(); c.month = new Date(t.getFullYear(), t.getMonth(), 1); c.selected = ymd(t); c.form = null; loadCalendar(); } }, 'Today'),
    h('button', { class: 'btn ghost sm', onclick: () => go(1), 'aria-label': 'Next month' }, '›'));

  const cells = [];
  for (const wd of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) cells.push(h('div', { class: 'wd' }, wd));
  for (let i = 0; i < 42; i++) {
    const d = new Date(c.start.getFullYear(), c.start.getMonth(), c.start.getDate() + i), key = ymd(d), info = byDay[key] || { b: [], e: [] };
    const items = [...info.b.map((b) => h('div', { class: 'ci bday' }, '🎂 ' + b.display_name)), ...info.e.map((e) => h('div', { class: 'ci ev' }, (e.time ? time12(e.time) + ' ' : '') + e.title))];
    cells.push(h('button', { class: 'day' + (d.getMonth() !== c.month.getMonth() ? ' other' : '') + (key === today ? ' today' : '') + (key === c.selected ? ' sel' : ''),
      onclick: () => { c.selected = key; c.form = null; renderCalendar(); } },
      h('span', { class: 'dn' }, d.getDate()), items.slice(0, 3), items.length > 3 ? h('div', { class: 'ci more' }, '+' + (items.length - 3) + ' more') : null));
  }

  // selected-day panel
  const sel = byDay[c.selected] || { b: [], e: [] };
  const panel = h('div', { class: 'card daypanel' },
    h('div', { class: 'row' }, h('b', { class: 'grow' }, parseYmd(c.selected).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })),
      h('button', { class: 'btn sm', onclick: () => { c.form = { date: c.selected }; renderCalendar(); } }, '+ Add event')),
    !sel.b.length && !sel.e.length && !c.form ? h('div', { class: 'muted', style: 'margin-top:8px' }, 'Nothing planned. Add an event or set birthdays in Members.') : null,
    sel.b.map((b) => h('div', { class: 'agenda' }, avatar({ kind: b.kind, avatar: b.avatar, id: b.user_id }, 'sm'),
      h('span', {}, '🎂 ', h('b', {}, b.display_name + "'s birthday"), b.age > 0 ? ' (turns ' + b.age + ')' : ''))),
    sel.e.map((e) => eventRow(e)),
    c.form ? eventForm(c.form) : null);

  // upcoming strip
  const up = [...c.upcoming.birthdays.map((b) => ({ date: b.date, text: '🎂 ' + b.display_name + (b.age > 0 ? ' turns ' + b.age : '') })),
    ...c.upcoming.events.map((e) => ({ date: e.date, text: (e.time ? time12(e.time) + ' ' : '') + e.title }))].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
  const upcoming = h('div', { class: 'card' }, h('b', {}, 'Coming up (next 60 days)'),
    up.length ? up.map((x) => h('div', { class: 'agenda' }, h('span', { class: 'muted', style: 'min-width:70px' }, parseYmd(x.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), h('span', {}, x.text)))
      : h('div', { class: 'muted' }, 'Nothing in the next 60 days.'));

  fill(calEl, upcoming, h('div', { class: 'card' }, head, h('div', { class: 'calgrid' }, cells)), panel);
}

function eventRow(e) {
  return h('div', { class: 'agenda evrow' }, h('span', { class: 'ci ev', style: 'flex:none' }, e.time ? time12(e.time) : 'All day'),
    h('div', { class: 'grow' }, h('b', {}, e.title), e.yearly ? h('span', { class: 'muted' }, ' · every year') : null,
      e.location ? h('div', { class: 'muted' }, '📍 ' + e.location) : null,
      e.notes ? h('div', { class: 'body' }, e.notes) : null,
      h('div', { class: 'muted' }, 'Added by ' + e.author.display_name)),
    e.can_edit ? [h('button', { class: 'link', onclick: () => { state.cal.form = { id: e.id, date: e.base_date, title: e.title, time: e.time || '', location: e.location, notes: e.notes, yearly: e.yearly }; renderCalendar(); } }, 'Edit'),
      h('button', { class: 'link danger', onclick: async () => {
        if (!confirm('Delete "' + e.title + '"' + (e.yearly ? ' (all years)' : '') + '?')) return;
        try { await api('DELETE', '/api/events/' + e.id); loadCalendar(); } catch (x) { fail(x); }
      } }, 'Delete')] : null);
}

function eventForm(f) {
  const title = h('input', { type: 'text', value: f.title || '', maxlength: 100, placeholder: 'e.g. Family picnic' });
  const date = h('input', { type: 'date', value: f.date });
  const time = h('input', { type: 'time', value: f.time || '' });
  const loc = h('input', { type: 'text', value: f.location || '', maxlength: 100 });
  const notes = h('textarea', { maxlength: 1000, style: 'min-height:50px' }, f.notes || '');
  notes.value = f.notes || '';
  const yearly = h('input', { type: 'checkbox', checked: !!f.yearly });
  const err = h('div', { class: 'err' });
  return h('div', { class: 'eventform' }, h('b', {}, f.id ? 'Edit event' : 'New event'),
    h('label', {}, 'Title'), title,
    h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Date'), date), h('div', {}, h('label', {}, 'Time (optional)'), time)),
    h('label', {}, 'Where (optional)'), loc, h('label', {}, 'Notes (optional)'), notes,
    h('label', {}, yearly, ' Repeats every year'), err,
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: async () => {
      try {
        const body = { title: title.value, date: date.value, time: time.value || null, location: loc.value, notes: notes.value, yearly: yearly.checked };
        if (f.id) await api('PUT', '/api/events/' + f.id, body); else await api('POST', '/api/events', body);
        state.cal.form = null; state.cal.selected = date.value;
        const d = parseYmd(date.value); state.cal.month = new Date(d.getFullYear(), d.getMonth(), 1);
        loadCalendar();
      } catch (x) { err.textContent = x.message; }
    } }, 'Save'), h('button', { class: 'btn ghost sm', onclick: () => { state.cal.form = null; renderCalendar(); } }, 'Cancel')));
}

boot();
