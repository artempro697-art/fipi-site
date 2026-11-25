'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SU = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SK = (process.env.SUPABASE_KEY || '').trim();
const FILE = path.join(__dirname, 'chat.json');

const now = () => Date.now();
let db = { threads: {} };
let loaded = false;
let loading = null;

function sbHeaders() {
  const h = { apikey: SK, 'Content-Type': 'application/json' };
  if (SK.startsWith('eyJ')) h.Authorization = 'Bearer ' + SK;
  return h;
}

async function doLoad() {
  try {
    let v = null;
    if (SU && SK) {
      const r = await fetch(SU + '/rest/v1/kv?k=eq.chat&select=v', { headers: sbHeaders() });
      if (!r.ok) throw new Error('Supabase ' + r.status);
      const j = await r.json();
      v = j[0] ? j[0].v : null;
    } else if (fs.existsSync(FILE)) {
      v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
    if (v && v.threads) db = v;
    loaded = true;
  } catch (e) {
    console.error('Чат: не удалось загрузить данные:', e.message);
  }
  return loaded;
}
function load() {
  if (loaded) return Promise.resolve(true);
  if (!loading) loading = doLoad().finally(() => { loading = null; });
  return loading;
}

let timer = null, dirty = false;
function save() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (!dirty || !loaded) return;
    dirty = false;
    try {
      if (SU && SK) {
        const r = await fetch(SU + '/rest/v1/kv', {
          method: 'POST',
          headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, sbHeaders()),
          body: JSON.stringify({ k: 'chat', v: db })
        });
        if (!r.ok) throw new Error('Supabase ' + r.status);
      } else {
        fs.writeFileSync(FILE, JSON.stringify(db));
      }
    } catch (e) {
      console.error('Чат: не удалось сохранить:', e.message);
      dirty = true;
      setTimeout(save, 10000);
    }
  }, 1500);
}

function capThreads() {
  const ks = Object.keys(db.threads);
  if (ks.length <= 3000) return;
  ks.filter(k => k.startsWith('g:'))
    .sort((a, b) => db.threads[a].updated - db.threads[b].updated)
    .slice(0, ks.length - 3000)
    .forEach(k => delete db.threads[k]);
}
function getThread(key, info, create) {
  let t = db.threads[key];
  if (!t && create) {
    t = db.threads[key] = { key, name: '', email: '', role: 'guest', contact: '', msgs: [], unreadAdmin: 0, unreadUser: 0, updated: now() };
    capThreads();
  }
  if (t && info) {
    if (info.name) t.name = info.name;
    if (info.email) t.email = info.email;
    if (info.role) t.role = info.role;
    if (info.contact) t.contact = info.contact;
  }
  return t;
}
function addMsg(t, from, text) {
  t.msgs.push({ id: crypto.randomBytes(5).toString('hex'), from, text, t: now() });
  if (t.msgs.length > 300) t.msgs.splice(0, t.msgs.length - 300);
  t.updated = now();
  if (from === 'user') t.unreadAdmin = (t.unreadAdmin || 0) + 1;
  else t.unreadUser = (t.unreadUser || 0) + 1;
  save();
}

// ---------- утилиты ----------
function pathOf(req) { try { return new URL(req.url, 'http://x').pathname; } catch (e) { return '/'; } }
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req, max) {
  max = max || 8000;
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > max) { req.destroy(); bad(new Error('big')); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
    req.on('error', bad);
  });
}
function serveFile(res, name, type) {
  try {
    const data = fs.readFileSync(path.join(__dirname, name));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Файл ' + name + ' не найден на сервере');
  }
}
function cidOf(x) { const c = String(x || ''); return /^[A-Za-z0-9]{8,40}$/.test(c) ? c : ''; }

// ---------- кто пользователь (через ваш же /api/me) ----------
const meCache = new Map();
async function whoami(req) {
  const ck = req.headers.cookie || '';
  if (!ck.includes('sid=')) return null;
  const c = meCache.get(ck);
  if (c && c.exp > now()) return c.u;
  let u = null;
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/me', { headers: { cookie: ck } });
    if (r.ok) {
      const j = await r.json();
      const x = (j && j.user) || j;
      if (x && x.email) {
        u = {
          name: String(x.name || ''),
          email: String(x.email).toLowerCase(),
          role: x.role === 'teacher' ? 'teacher' : x.role === 'student' ? 'student' : String(x.role || 'user')
        };
      }
    }
  } catch (e) {}
  if (meCache.size > 3000) meCache.clear();
  meCache.set(ck, { u, exp: now() + 60000 });
  return u;
}
const keyOf = (u, cid) => u ? u.email : 'g:' + cid;

// ---------- онлайн ----------
const online = new Map();
function touch(k, u, cid, page) {
  online.set(k, { name: u ? u.name : '', email: u ? u.email : '', role: u ? u.role : 'guest', page, seen: now() });
}
function onlineInfo() {
  const cut = now() - 70000;
  const list = [];
  for (const [k, v] of online) {
    if (v.seen < now() - 600000) { online.delete(k); continue; }
    if (v.seen >= cut) list.push(v);
  }
  list.sort((a, b) => b.seen - a.seen);
  return {
    total: list.length,
    teachers: list.filter(x => x.role === 'teacher').length,
    students: list.filter(x => x.role === 'student').length,
    guests: list.filter(x => x.role === 'guest').length,
    list: list.map(x => ({ name: x.name, email: x.email, role: x.role, page: x.page, ago: Math.round((now() - x.seen) / 1000) }))
  };
}

// ---------- лимиты ----------
const rl = new Map();
function limited(ip) {
  let e = rl.get(ip);
  if (!e || e.reset < now()) e = { n: 0, reset: now() + 3600000 };
  e.n++;
  rl.set(ip, e);
  if (rl.size > 5000) rl.clear();
  return e.n > 30;
}
const fails = new Map();
function adminOk(req, res) {
  if (!ADMIN_KEY) { send(res, 503, { error: 'На сервере не задан ADMIN_KEY' }); return false; }
  const ip = ipOf(req);
  const f = fails.get(ip);
  if (f && f.n >= 10 && f.until > now()) { send(res, 429, { error: 'Слишком много попыток. Подождите 10 минут.' }); return false; }
  const a = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const b = Buffer.from(ADMIN_KEY);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    const g = (f && f.until > now()) ? f : { n: 0 };
    g.n++; g.until = now() + 600000;
    fails.set(ip, g);
    send(res, 401, { error: 'Неверный ключ' });
    return false;
  }
  fails.delete(ip);
  return true;
}

// ---------- вызов ваших админ-ссылок изнутри ----------
async function core(action, params) {
  const q = new URLSearchParams(Object.assign({ key: ADMIN_KEY }, params || {}));
  const r = await fetch('http://127.0.0.1:' + PORT + '/api/admin/' + action + '?' + q.toString());
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, j };
}

// ---------- публичные запросы (виджет) ----------
async function pub(req, res, p, m) {
  const sp = new URL(req.url, 'http://x').searchParams;
  const u = await whoami(req);

  if (p === '/x/ping' && m === 'POST') {
    const b = await body(req);
    const cid = cidOf(b.cid);
    if (!cid) return send(res, 400, { error: 'cid' });
    touch(keyOf(u, cid), u, cid, String(b.page || '').slice(0, 60));
    const t = loaded ? db.threads[keyOf(u, cid)] : null;
    return send(res, 200, { unread: t ? (t.unreadUser || 0) : 0 });
  }

  if (!(await load())) return send(res, 503, { error: 'Чат временно недоступен' });

  if (p === '/x/chat' && m === 'GET') {
    const cid = cidOf(sp.get('cid'));
    if (!cid) return send(res, 400, { error: 'cid' });
    const t = db.threads[keyOf(u, cid)];
    if (t && t.unreadUser) { t.unreadUser = 0; save(); }
    return send(res, 200, { msgs: t ? t.msgs.slice(-100) : [], logged: !!u, name: u ? u.name : '' });
  }

  if (p === '/x/chat' && m === 'POST') {
    const b = await body(req);
    const cid = cidOf(b.cid);
    if (!cid) return send(res, 400, { error: 'cid' });
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!text) return send(res, 400, { error: 'Напишите сообщение' });
    if (limited(ipOf(req))) return send(res, 429, { error: 'Слишком много сообщений. Попробуйте позже.' });
    const key = keyOf(u, cid);
    const old = db.threads[key];
    if (old && old.msgs.length) {
      const last = old.msgs[old.msgs.length - 1];
      if (last.from === 'user' && now() - last.t < 800) return send(res, 429, { error: 'Не так быстро' });
    }
    const t = getThread(key, {
      name: u ? u.name : String(b.name || '').trim().slice(0, 60),
      email: u ? u.email : '',
      role: u ? u.role : 'guest',
      contact: u ? '' : String(b.contact || '').trim().slice(0, 100)
    }, true);
    addMsg(t, 'user', text);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- админские запросы ----------
async function admin(req, res, p, m) {
  if (!adminOk(req, res)) return;
  if (!(await load())) return send(res, 503, { error: 'Чат ещё не загрузился, повторите через минуту' });
  const sp = new URL(req.url, 'http://x').searchParams;

  if (p === '/x/admin/overview' && m === 'GET') {
    let c = null, coreError = '';
    try {
      const r = await core('stats');
      if (r.ok) c = r.j; else coreError = 'stats вернул ' + r.status;
    } catch (e) { coreError = e.message; }
    const threads = Object.values(db.threads)
      .sort((a, b) => b.updated - a.updated)
      .map(t => ({
        key: t.key, name: t.name, email: t.email, role: t.role, contact: t.contact,
        unread: t.unreadAdmin || 0, updated: t.updated,
        last: t.msgs.length ? String(t.msgs[t.msgs.length - 1].text).slice(0, 80) : ''
      }));
    const unread = threads.reduce((s, t) => s + t.unread, 0);
    return send(res, 200, { online: onlineInfo(), threads, unread, core: c, coreError });
  }

  if (p === '/x/admin/thread' && m === 'GET') {
    const t = db.threads[String(sp.get('key') || '')];
    if (t && t.unreadAdmin) { t.unreadAdmin = 0; save(); }
    return send(res, 200, { thread: t || null });
  }

  if (p === '/x/admin/reply' && m === 'POST') {
    const b = await body(req);
    const key = String(b.key || '').slice(0, 120);
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!key || !text) return send(res, 400, { error: 'Пустое сообщение' });
    let t = db.threads[key];
    if (!t) {
      if (key.startsWith('g:')) return send(res, 404, { error: 'Диалог не найден' });
      t = getThread(key, { name: String(b.name || '').slice(0, 60), email: key, role: String(b.role || 'user') }, true);
    }
    addMsg(t, 'admin', text);
    return send(res, 200, { ok: true });
  }

  if (p === '/x/admin/delete' && m === 'POST') {
    const b = await body(req);
    delete db.threads[String(b.key || '')];
    save();
    return send(res, 200, { ok: true });
  }

  if (p === '/x/admin/act' && m === 'POST') {
    const b = await body(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!email) return send(res, 400, { error: 'Нет email' });
    let r;
    if (b.action === 'grant') r = await core('grant', { email, days: String(parseInt(b.days, 10) || 0) });
    else if (b.action === 'revoke') r = await core('revoke', { email });
    else if (b.action === 'setpass') r = await core('setpass', { email, password: String(b.password || '') });
    else return send(res, 400, { error: 'Неизвестное действие' });
    return send(res, 200, { ok: r.ok, status: r.status, result: r.j });
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- маршрутизация ----------
function isMine(req) {
  const p = pathOf(req);
  if (p === '/admin' || p === '/admin/' || p.startsWith('/x/')) return true;
  if (req.method === 'GET' && (p === '/' || p === '/index.html' || p.startsWith('/h/'))) return true;
  return false;
}

async function handle(req, res, next) {
  const p = pathOf(req), m = req.method;
  if (p === '/admin' || p === '/admin/') return serveFile(res, 'admin.html', 'text/html; charset=utf-8');
  if (p === '/x/widget.js') return serveFile(res, 'widget.js', 'application/javascript; charset=utf-8');
  if (p.startsWith('/x/admin/')) return admin(req, res, p, m);
  if (p.startsWith('/x/')) return pub(req, res, p, m);

  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); } catch (e) { return next(); }
  const tag = '<script src="/x/widget.js" defer></script>';
  const i = html.lastIndexOf('</body>');
  html = i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

load().catch(() => {});
module.exports = { isMine, handle };