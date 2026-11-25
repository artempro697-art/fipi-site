'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SU = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SK = (process.env.SUPABASE_KEY || '').trim();
const FILE = path.join(__dirname, 'assign.json');

const now = () => Date.now();
let db = { items: {} };
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
      const r = await fetch(SU + '/rest/v1/kv?k=eq.assign&select=v', { headers: sbHeaders() });
      if (!r.ok) throw new Error('Supabase ' + r.status);
      const j = await r.json();
      v = j[0] ? j[0].v : null;
    } else if (fs.existsSync(FILE)) {
      v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
    if (v && v.items) db = v;
    loaded = true;
  } catch (e) {
    console.error('Задания: не удалось загрузить данные:', e.message);
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
          body: JSON.stringify({ k: 'assign', v: db })
        });
        if (!r.ok) throw new Error('Supabase ' + r.status);
      } else {
        fs.writeFileSync(FILE, JSON.stringify(db));
      }
    } catch (e) {
      console.error('Задания: не удалось сохранить:', e.message);
      dirty = true;
      setTimeout(save, 10000);
    }
  }, 1500);
}

// ---------- утилиты ----------
function pathOf(req) { try { return new URL(req.url, 'http://x').pathname; } catch (e) { return '/'; } }
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req, max) {
  max = max || 30000;
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
const lc = x => String(x == null ? '' : x).toLowerCase();

// ---------- кто пользователь ----------
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
          id: x.id == null ? '' : String(x.id),
          name: String(x.name || ''),
          email: lc(x.email),
          role: x.role === 'teacher' ? 'teacher' : x.role === 'student' ? 'student' : String(x.role || 'user')
        };
      }
    }
  } catch (e) {}
  if (meCache.size > 3000) meCache.clear();
  meCache.set(ck, { u, exp: now() + 60000 });
  return u;
}
const userKeys = u => [u.email, u.id].filter(Boolean).map(lc);

// ---------- данные из основного сервера ----------
async function coreGet(p, ck) {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + p, { headers: { cookie: ck || '' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
function normStudent(s) {
  if (s == null) return null;
  if (typeof s !== 'object') {
    const v = String(s).trim();
    return v ? { k: [lc(v)], name: v } : null;
  }
  const k = [s.email, s.id, s.sid, s.userId, s.login].filter(Boolean).map(lc);
  if (!k.length) return null;
  return { k: Array.from(new Set(k)), name: String(s.name || s.fullName || s.email || 'Ученик') };
}
async function getClasses(ck) {
  const raw = await coreGet('/api/classes', ck);
  const arr = Array.isArray(raw) ? raw : (raw && (raw.classes || raw.items)) || null;
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const c of arr) {
    if (!c || c.id == null) continue;
    let st = c.students;
    if (!Array.isArray(st)) {
      const r = await coreGet('/api/classes/' + encodeURIComponent(c.id) + '/students', ck);
      st = Array.isArray(r) ? r : (r && r.students) || [];
    }
    const seen = new Set();
    const students = [];
    for (const s of st) {
      const n = normStudent(s);
      if (n && !seen.has(n.k[0])) { seen.add(n.k[0]); students.push(n); }
    }
    out.push({ id: String(c.id), name: String(c.name || c.title || 'Класс'), students });
  }
  return out;
}
async function getHw(ck) {
  const raw = await coreGet('/api/homeworks', ck);
  const arr = Array.isArray(raw) ? raw : (raw && (raw.homeworks || raw.items)) || null;
  if (!Array.isArray(arr)) return null;
  return arr.filter(h => h && h.id != null).map(h => ({
    id: String(h.id),
    title: String(h.title || h.name || ('Домашка ' + h.id)),
    exam: String(h.exam || ''),
    n: Array.isArray(h.items) ? h.items.length : (h.count || 0)
  }));
}

// ---------- статусы ----------
function mark(u, hwId, kind) {
  const mk = userKeys(u);
  let ch = false;
  for (const a of Object.values(db.items)) {
    if (String(a.hwId) !== String(hwId)) continue;
    for (const r of a.to) {
      if (!r.k.some(x => mk.includes(x))) continue;
      if (kind === 'open' && !r.opened) { r.opened = now(); ch = true; }
      if (kind === 'submit') { if (!r.opened) r.opened = now(); r.submitted = now(); r.reviewed = 0; ch = true; }
    }
  }
  if (ch) save();
}
async function track(req, res, next, p, m) {
  try {
    if ((req.headers.cookie || '').includes('sid=')) {
      const mm = p.match(/^\/api\/hw\/([^\/]+)(?:\/(start|submit))?$/);
      if (mm) {
        const kind = ((m === 'GET' && !mm[2]) || (m === 'POST' && mm[2] === 'start')) ? 'open'
          : (m === 'POST' && mm[2] === 'submit' ? 'submit' : null);
        if (kind) {
          const u = await whoami(req);
          if (u && u.role === 'student' && (await load())) {
            const hid = decodeURIComponent(mm[1]);
            if (kind === 'open') mark(u, hid, 'open');
            else {
              const e = res.end;
              res.end = function () {
                try { if (res.statusCode < 400) mark(u, hid, 'submit'); } catch (_) {}
                return e.apply(this, arguments);
              };
            }
          }
        }
      }
    }
  } catch (e) {}
  return next();
}

// ---------- основной обработчик ----------
function isMine(req) {
  const p = pathOf(req);
  return p === '/assign' || p === '/assign/' || p.startsWith('/x/a/') || p.startsWith('/api/hw/');
}

async function handle(req, res, next) {
  const p = pathOf(req), m = req.method;
  if (p === '/assign' || p === '/assign/') return serveFile(res, 'assign.html', 'text/html; charset=utf-8');
  if (p.startsWith('/api/hw/')) return track(req, res, next, p, m);

  const u = await whoami(req);
  if (!(await load())) return send(res, 503, { error: 'Данные временно недоступны, повторите через минуту' });
  const ck = req.headers.cookie || '';
  const isT = !!u && u.role === 'teacher';
  const isS = !!u && u.role === 'student';

  if (p === '/x/a/me' && m === 'GET') {
    if (!u) return send(res, 200, { role: 'guest' });
    let n = 0;
    if (isS) {
      const mk = userKeys(u);
      for (const a of Object.values(db.items)) for (const r of a.to) if (r.k.some(x => mk.includes(x)) && !r.opened) n++;
    } else if (isT) {
      for (const a of Object.values(db.items)) if (a.teacher === u.email) for (const r of a.to) if (r.submitted && !r.reviewed) n++;
    }
    return send(res, 200, { role: u.role, name: u.name, n });
  }

  // ---------- ученик ----------
  if (p === '/x/a/my' && m === 'GET') {
    if (!isS) return send(res, 403, { error: 'Только для учеников' });
    const mk = userKeys(u);
    const list = [];
    for (const a of Object.values(db.items)) {
      for (const r of a.to) {
        if (!r.k.some(x => mk.includes(x))) continue;
        list.push({
          id: a.id, hwId: a.hwId, title: a.hwTitle, teacher: a.teacherName, note: a.note || '',
          created: a.created, opened: r.opened, submitted: r.submitted, reviewed: r.reviewed, comment: r.comment || ''
        });
      }
    }
    list.sort((x, y) => y.created - x.created);
    return send(res, 200, { items: list });
  }

  // ---------- учитель ----------
  if (p.startsWith('/x/a/')) {
    if (!isT) return send(res, 403, { error: 'Только для учителей. Войдите на сайт как учитель.' });

    if (p === '/x/a/classes' && m === 'GET') {
      const cl = await getClasses(ck);
      if (!cl) return send(res, 502, { error: 'Не удалось получить список классов. Проверьте подписку.' });
      return send(res, 200, { classes: cl });
    }
    if (p === '/x/a/homeworks' && m === 'GET') {
      const hw = await getHw(ck);
      if (!hw) return send(res, 502, { error: 'Не удалось получить список домашек. Проверьте подписку.' });
      return send(res, 200, { homeworks: hw });
    }
    if (p === '/x/a/raw' && m === 'GET') {
      return send(res, 200, {
        classes: await coreGet('/api/classes', ck),
        homeworks: await coreGet('/api/homeworks', ck)
      });
    }
    if (p === '/x/a/sent' && m === 'GET') {
      const list = Object.values(db.items).filter(a => a.teacher === u.email).sort((x, y) => y.created - x.created);
      return send(res, 200, { items: list });
    }

    if (p === '/x/a/create' && m === 'POST') {
      const b = await body(req);
      const cl = await getClasses(ck);
      const c = (cl || []).find(x => x.id === String(b.classId));
      if (!c) return send(res, 404, { error: 'Класс не найден' });
      const hws = await getHw(ck);
      const h = (hws || []).find(x => x.id === String(b.hwId));
      if (!h) return send(res, 404, { error: 'Домашка не найдена' });
      const want = new Set((Array.isArray(b.students) ? b.students : []).map(lc));
      const chosen = c.students.filter(s => want.has(s.k[0]));
      if (!chosen.length) return send(res, 400, { error: 'Выберите учеников' });
      let a = Object.values(db.items).find(x => x.teacher === u.email && String(x.hwId) === h.id);
      if (!a) {
        const id = crypto.randomBytes(5).toString('hex');
        a = db.items[id] = { id, teacher: u.email, teacherName: u.name, hwId: h.id, hwTitle: h.title, created: now(), note: '', to: [] };
      }
      a.hwTitle = h.title;
      a.teacherName = u.name;
      const note = String(b.note || '').trim().slice(0, 500);
      if (note) a.note = note;
      let added = 0;
      for (const s of chosen) {
        if (!a.to.some(r => r.k[0] === s.k[0])) {
          a.to.push({ k: s.k, name: s.name, cls: c.name, opened: 0, submitted: 0, reviewed: 0, comment: '' });
          added++;
        }
      }
      save();
      return send(res, 200, { ok: true, added, id: a.id });
    }

    if (p === '/x/a/review' && m === 'POST') {
      const b = await body(req);
      const a = db.items[String(b.id || '')];
      if (!a || a.teacher !== u.email) return send(res, 404, { error: 'Не найдено' });
      const r = a.to.find(x => x.k[0] === lc(b.key));
      if (!r) return send(res, 404, { error: 'Ученик не найден' });
      if (b.on) { r.reviewed = now(); r.comment = String(b.comment || '').trim().slice(0, 500); }
      else { r.reviewed = 0; r.comment = ''; }
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/x/a/remove' && m === 'POST') {
      const b = await body(req);
      const a = db.items[String(b.id || '')];
      if (!a || a.teacher !== u.email) return send(res, 404, { error: 'Не найдено' });
      if (b.key) {
        a.to = a.to.filter(x => x.k[0] !== lc(b.key));
        if (!a.to.length) delete db.items[a.id];
      } else delete db.items[a.id];
      save();
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'not found' });
}

load().catch(() => {});
module.exports = { isMine, handle };