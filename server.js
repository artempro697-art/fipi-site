const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const INVITE = process.env.INVITE_CODE || '';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const AH = { apikey: KEY, Authorization: 'Bearer ' + KEY };

function send(res, code, body, type, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8' }, headers || {}));
  res.end(body);
}
const json = (res, code, obj, h) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', h);
const err = (res, code, msg) => json(res, code, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

async function kvGet(k) {
  const r = await fetch(SB + '/rest/v1/kv?k=eq.' + encodeURIComponent(k) + '&select=v', { headers: AH });
  if (!r.ok) throw new Error('DB GET ' + r.status);
  const rows = await r.json();
  return rows.length ? rows[0].v : null;
}
async function kvSet(k, v) {
  const r = await fetch(SB + '/rest/v1/kv', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, AH), body: JSON.stringify([{ k: k, v: v }]) });
  if (!r.ok) throw new Error('DB SET ' + r.status);
}
async function kvDel(k) {
  await fetch(SB + '/rest/v1/kv?k=eq.' + encodeURIComponent(k), { method: 'DELETE', headers: AH });
}
const load = async (k, d) => { const v = await kvGet(k); return v == null ? d : v; };

const nid = n => crypto.randomBytes(n).toString('hex');
const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/,/g, '.');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const csvEsc = s => { s = String(s == null ? '' : s); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function genCode() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += a[crypto.randomInt(a.length)];
  return s;
}
function getCookie(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o.sid || '';
}
async function newSession(userId) {
  const t = nid(24);
  await kvSet('sess:' + t, { userId: userId });
  return t;
}
const cookieHdr = t => ({ 'Set-Cookie': 'sid=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' });
function guestCookie(req) {
  const t = getCookie(req);
  if (t) return [t, null];
  const nt = nid(24);
  return [nt, cookieHdr(nt)];
}
async function getUser(req) {
  const t = getCookie(req);
  if (!t) return null;
  const s = await kvGet('sess:' + t);
  if (!s) return null;
  const users = await load('users', []);
  return users.find(u => u.id === s.userId) || null;
}
function makeSub(h, tlist, answers, user, startedAt, name) {
  const details = tlist.map(t => {
    const given = answers && answers[t.id] != null ? String(answers[t.id]) : '';
    const ok = String(t.answer || '').split('|').map(norm).includes(norm(given));
    return { ok: ok, text: t.text || '', given: given, correct: t.answer || '' };
  });
  const now = Date.now();
  return {
    id: nid(8), hwId: h.id, userId: user ? user.id : null,
    name: user ? user.name : (name || 'Гость'), registered: !!user,
    score: details.filter(d => d.ok).length, total: details.length, details: details, date: now,
    late: !!(h.deadline && now > h.deadline),
    overtime: !!(h.timeLimit && startedAt && now > startedAt + h.timeLimit * 60000)
  };
}
const strip1 = t => ({ id: t.id, text: t.text, image: t.image || '', options: t.options || [] });

async function apiRoute(req, res, p) {
  const m = req.method;
  let body = null;
  if (m === 'POST' || m === 'PUT') { try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; } }
  const user = await getUser(req);
  let mm;

  if (p === '/api/config' && m === 'GET') return json(res, 200, { inviteRequired: !!INVITE });

  if (p === '/api/me' && m === 'GET') return user ? json(res, 200, { user: pub(user) }) : err(res, 401, 'Вы не вошли');

  if (p === '/api/register' && m === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim();
    const role = body.role === 'teacher' ? 'teacher' : 'student';
    if (!email || email.indexOf('@') < 0) return err(res, 400, 'Введите email');
    if (password.length < 6) return err(res, 400, 'Пароль минимум 6 символов');
    if (!name) return err(res, 400, 'Введите имя');
    if (role === 'teacher' && INVITE && String(body.invite || '') !== INVITE) return err(res, 400, 'Неверный код приглашения');
    const users = await load('users', []);
    if (users.some(x => x.email === email)) return err(res, 400, 'Такой email уже зарегистрирован');
    const nu = { id: nid(8), email: email, pass: hash(password), name: name, role: role, hwIds: [] };
    users.push(nu); await kvSet('users', users);
    return json(res, 200, { user: pub(nu) }, cookieHdr(await newSession(nu.id)));
  }

  if (p === '/api/login' && m === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    const users = await load('users', []);
    const u2 = users.find(x => x.email === email);
    if (!u2 || u2.pass !== hash(String(body.password || ''))) return err(res, 400, 'Неверный email или пароль');
    return json(res, 200, { user: pub(u2) }, cookieHdr(await newSession(u2.id)));
  }

  if (p === '/api/logout' && m === 'POST') {
    const t = getCookie(req);
    if (t) await kvDel('sess:' + t);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }

  if (p === '/api/my' && m === 'GET') {
    if (!user) return err(res, 401, 'Вы не вошли');
    const r = await Promise.all([load('homeworks', []), load('submissions', []), load('classes', [])]);
    const hws = r[0], subs = r[1], classes = r[2];
    const myClasses = classes.filter(c => (c.students || []).some(s => s.id === user.id));
    const myClassIds = myClasses.map(c => c.id);
    const mySubs = subs.filter(s => s.userId === user.id);
    const subHw = {}; mySubs.forEach(s => subHw[s.hwId] = 1);
    const todo = hws.filter(h => ((h.classId && myClassIds.indexOf(h.classId) >= 0) || (user.hwIds || []).indexOf(h.id) >= 0) && !subHw[h.id])
      .map(h => ({ id: h.id, title: h.title, count: (h.taskIds || []).length, timeLimit: h.timeLimit || 0, deadline: h.deadline || null }));
    const done = mySubs.sort((a, b) => b.date - a.date).map(s => {
      const h = hws.find(x => x.id === s.hwId);
      return { title: h ? h.title : 'Домашка удалена', score: s.score, total: s.total, date: s.date, details: s.details, late: s.late, overtime: s.overtime };
    });
    return json(res, 200, { todo: todo, done: done, classes: myClasses.map(c => ({ id: c.id, name: c.name })) });
  }

  if (p === '/api/classes/join' && m === 'POST') {
    if (!user) return err(res, 401, 'Вы не вошли');
    const code = String(body.code || '').trim().toUpperCase();
    const classes = await load('classes', []);
    const c = classes.find(x => x.code === code);
    if (!c) return err(res, 400, 'Класс с таким кодом не найден');
    if (!(c.students || []).some(s => s.id === user.id)) {
      c.students = c.students || [];
      c.students.push({ id: user.id, name: user.name, email: user.email });
      await kvSet('classes', classes);
    }
    return json(res, 200, { name: c.name });
  }
  if ((mm = p.match(/^\/api\/classes\/([^/]+)\/leave$/)) && m === 'POST') {
    if (!user) return err(res, 401, 'Вы не вошли');
    const classes = await load('classes', []);
    const c = classes.find(x => x.id === mm[1]);
    if (c) { c.students = (c.students || []).filter(s => s.id !== user.id); await kvSet('classes', classes); }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/tasks' && m === 'GET') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const tasks = await load('tasks', []);
    return json(res, 200, tasks.filter(t => t.owner === user.id));
  }
  if (p === '/api/tasks' && m === 'POST') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const tasks = await load('tasks', []);
    const t = { id: nid(8), text: String(body.text || ''), answer: String(body.answer || ''), topic: String(body.topic || ''), options: Array.isArray(body.options) ? body.options : [], image: String(body.image || ''), owner: user.id };
    tasks.unshift(t); await kvSet('tasks', tasks);
    return json(res, 200, t);
  }
  if (p === '/api/tasks/bulk' && m === 'POST') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const lines = String(body.text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const tasks = await load('tasks', []);
    let added = 0, bad = 0;
    for (const l of lines) {
      const parts = l.split(';').map(s => s.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) { bad++; continue; }
      tasks.unshift({ id: nid(8), text: parts[0], answer: parts[1], topic: String(body.topic || parts[2] || ''), options: [], image: '', owner: user.id });
      added++;
    }
    await kvSet('tasks', tasks);
    return json(res, 200, { added: added, bad: bad });
  }
  if ((mm = p.match(/^\/api\/tasks\/([^/]+)$/)) && m === 'PUT') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const tasks = await load('tasks', []);
    const t = tasks.find(x => x.id === mm[1] && x.owner === user.id);
    if (!t) return err(res, 404, 'Не найдено');
    if (body.text != null) t.text = String(body.text);
    if (body.answer != null) t.answer = String(body.answer);
    if (body.topic != null) t.topic = String(body.topic);
    if (Array.isArray(body.options)) t.options = body.options;
    if (body.image != null) t.image = String(body.image);
    await kvSet('tasks', tasks);
    return json(res, 200, t);
  }
  if ((mm = p.match(/^\/api\/tasks\/([^/]+)$/)) && m === 'DELETE') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    let tasks = await load('tasks', []);
    tasks = tasks.filter(x => !(x.id === mm[1] && x.owner === user.id));
    await kvSet('tasks', tasks);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/homeworks' && m === 'GET') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const r = await Promise.all([load('homeworks', []), load('submissions', []), load('classes', [])]);
    const hws = r[0], subs = r[1], classes = r[2];
    return json(res, 200, hws.filter(h => h.owner === user.id).map(h => {
      const c = h.classId ? classes.find(x => x.id === h.classId) : null;
      return { id: h.id, title: h.title, count: (h.taskIds || []).length, submitted: subs.filter(s => s.hwId === h.id).length, className: c ? c.name : '', timeLimit: h.timeLimit || 0, deadline: h.deadline || null };
    }));
  }
  if (p === '/api/homeworks' && m === 'POST') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const hws = await load('homeworks', []);
    const h = { id: nid(8), title: String(body.title || 'Домашка'), classId: body.classId || null, deadline: body.deadline ? Number(body.deadline) : null, timeLimit: Number(body.timeLimit) || 0, taskIds: Array.isArray(body.taskIds) ? body.taskIds : [], owner: user.id };
    hws.unshift(h); await kvSet('homeworks', hws);
    return json(res, 200, h);
  }
  if ((mm = p.match(/^\/api\/homeworks\/([^/]+)\/results$/)) && m === 'GET') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const r = await Promise.all([load('homeworks', []), load('submissions', []), load('tasks', []), load('classes', [])]);
    const hws = r[0], subs = r[1], tasks = r[2], classes = r[3];
    const h = hws.find(x => x.id === mm[1] && x.owner === user.id);
    if (!h) return err(res, 404, 'Не найдено');
    const rs = subs.filter(s => s.hwId === h.id);
    const tlist = (h.taskIds || []).map(tid => tasks.find(t => t.id === tid));
    const taskTexts = tlist.map(t => t ? (t.text || '[задание с картинкой]') : '');
    const taskImages = tlist.map(t => t && t.image ? t.image : null);
    const avg = rs.length ? Math.round(rs.reduce((s, x) => s + (x.total ? x.score / x.total * 100 : 0), 0) / rs.length) : 0;
    let missing = [];
    if (h.classId) {
      const c = classes.find(x => x.id === h.classId);
      if (c) missing = (c.students || []).filter(st => !rs.some(s => s.userId === st.id)).map(st => st.name);
    }
    return json(res, 200, { title: h.title, results: rs, missing: missing, avg: avg, taskTexts: taskTexts, taskImages: taskImages });
  }
  if ((mm = p.match(/^\/api\/homeworks\/([^/]+)\/export$/)) && m === 'GET') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const r = await Promise.all([load('homeworks', []), load('submissions', []), load('tasks', [])]);
    const hws = r[0], subs = r[1], tasks = r[2];
    const h = hws.find(x => x.id === mm[1] && x.owner === user.id);
    if (!h) return err(res, 404, 'Не найдено');
    const rs = subs.filter(s => s.hwId === h.id);
    const tlist = (h.taskIds || []).map(tid => tasks.find(t => t.id === tid));
    let csv = '\uFEFFИмя;Балл;Из;Процент;Дата';
    tlist.forEach((t, i) => csv += ';Задание ' + (i + 1));
    csv += '\r\n';
    for (const s of rs) {
      const pr = s.total ? Math.round(s.score / s.total * 100) : 0;
      csv += [csvEsc(s.name), s.score, s.total, pr + '%', new Date(s.date).toLocaleString('ru-RU')].join(';');
      (s.details || []).forEach(d => csv += ';' + csvEsc(d.given) + (d.ok ? ' (верно)' : ' (неверно, верно: ' + csvEsc(d.correct) + ')'));
      csv += '\r\n';
    }
    return send(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="results.csv"' });
  }
  if ((mm = p.match(/^\/api\/homeworks\/([^/]+)$/)) && m === 'DELETE') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    let hws = await load('homeworks', []);
    hws = hws.filter(x => !(x.id === mm[1] && x.owner === user.id));
    await kvSet('homeworks', hws);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/classes' && m === 'GET') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const classes = await load('classes', []);
    return json(res, 200, classes.filter(c => c.owner === user.id));
  }
  if (p === '/api/classes' && m === 'POST') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const classes = await load('classes', []);
    const c = { id: nid(8), name: String(body.name || 'Класс'), code: genCode(), owner: user.id, students: [] };
    classes.unshift(c); await kvSet('classes', classes);
    return json(res, 200, c);
  }
  if ((mm = p.match(/^\/api\/classes\/([^/]+)\/students\/([^/]+)$/)) && m === 'DELETE') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    const classes = await load('classes', []);
    const c = classes.find(x => x.id === mm[1] && x.owner === user.id);
    if (c) { c.students = (c.students || []).filter(s => s.id !== mm[2]); await kvSet('classes', classes); }
    return json(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/classes\/([^/]+)$/)) && m === 'DELETE') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    let classes = await load('classes', []);
    classes = classes.filter(x => !(x.id === mm[1] && x.owner === user.id));
    await kvSet('classes', classes);
    return json(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/hw\/([^/]+)$/)) && m === 'GET') {
    const r = await Promise.all([load('homeworks', []), load('tasks', []), load('submissions', []), load('starts', {})]);
    const hws = r[0], tasks = r[1], subs = r[2], starts = r[3];
    const h = hws.find(x => x.id === mm[1]);
    if (!h) return err(res, 404, 'Домашка не найдена');
    const teacher = !!(user && user.role === 'teacher' && h.owner === user.id);
    const role = teacher ? 'teacher' : (user ? 'student' : 'guest');
    const tlist = (h.taskIds || []).map(tid => tasks.find(t => t.id === tid)).filter(Boolean);
    const gc = guestCookie(req); const ukey = user ? user.id : gc[0]; const ghdr = gc[1];
    if (user && user.role === 'student') {
      const users = await load('users', []);
      const me2 = users.find(x => x.id === user.id);
      if (me2 && (me2.hwIds || []).indexOf(h.id) < 0) { me2.hwIds = me2.hwIds || []; me2.hwIds.push(h.id); await kvSet('users', users); }
    }
    let mine = user ? (subs.find(s => s.hwId === h.id && s.userId === user.id) || null) : null;
    const startedAt = starts[h.id + ':' + ukey];
    if (!teacher && !mine && h.timeLimit && startedAt && Date.now() > startedAt + h.timeLimit * 60000) {
      mine = makeSub(h, tlist, {}, user, startedAt);
      subs.push(mine); await kvSet('submissions', subs);
    }
    const out = { id: h.id, title: h.title, count: tlist.length, timeLimit: h.timeLimit || 0, deadline: h.deadline || null, role: role };
    if (mine) { out.mine = mine; return json(res, 200, out, ghdr); }
    if (teacher) { out.tasks = tlist.map(strip1); return json(res, 200, out, ghdr); }
    if (h.timeLimit && !startedAt) { out.needStart = true; return json(res, 200, out, ghdr); }
    out.tasks = tlist.map(strip1);
    if (h.timeLimit && startedAt) out.timeLeft = Math.max(0, Math.round(h.timeLimit * 60 - (Date.now() - startedAt) / 1000));
    return json(res, 200, out, ghdr);
  }
  if ((mm = p.match(/^\/api\/hw\/([^/]+)\/start$/)) && m === 'POST') {
    const r = await Promise.all([load('homeworks', []), load('tasks', []), load('starts', {})]);
    const hws = r[0], tasks = r[1], starts = r[2];
    const h = hws.find(x => x.id === mm[1]);
    if (!h) return err(res, 404, 'Не найдено');
    const gc = guestCookie(req); const ukey = user ? user.id : gc[0]; const ghdr = gc[1];
    if (!starts[h.id + ':' + ukey]) { starts[h.id + ':' + ukey] = Date.now(); await kvSet('starts', starts); }
    const tlist = (h.taskIds || []).map(tid => tasks.find(t => t.id === tid)).filter(Boolean);
    const left = Math.max(0, Math.round((h.timeLimit || 0) * 60 - (Date.now() - starts[h.id + ':' + ukey]) / 1000));
    return json(res, 200, { tasks: tlist.map(strip1), timeLeft: left }, ghdr);
  }
  if ((mm = p.match(/^\/api\/hw\/([^/]+)\/submit$/)) && m === 'POST') {
    const r = await Promise.all([load('homeworks', []), load('tasks', []), load('submissions', []), load('starts', {})]);
    const hws = r[0], tasks = r[1], subs = r[2], starts = r[3];
    const h = hws.find(x => x.id === mm[1]);
    if (!h) return err(res, 404, 'Не найдено');
    if (user && user.role === 'teacher' && h.owner === user.id) return err(res, 400, 'Это предпросмотр, ответы не сохраняются');
    const tlist = (h.taskIds || []).map(tid => tasks.find(t => t.id === tid)).filter(Boolean);
    const ukey = user ? user.id : getCookie(req);
    const startedAt = starts[h.id + ':' + ukey] || 0;
    let sub;
    if (user) {
      const i = subs.findIndex(s => s.hwId === h.id && s.userId === user.id);
      sub = makeSub(h, tlist, body.answers || {}, user, startedAt);
      if (i >= 0) subs[i] = sub; else subs.push(sub);
    } else {
      sub = makeSub(h, tlist, body.answers || {}, null, startedAt, body.name);
      subs.push(sub);
    }
    await kvSet('submissions', subs);
    return json(res, 200, sub);
  }

  if ((mm = p.match(/^\/api\/submissions\/([^/]+)$/)) && m === 'DELETE') {
    if (!user || user.role !== 'teacher') return err(res, 401, 'Только для учителя');
    let subs = await load('submissions', []);
    const s = subs.find(x => x.id === mm[1]);
    if (s) {
      const hws = await load('homeworks', []);
      const h = hws.find(x => x.id === s.hwId);
      if (!h || h.owner !== user.id) return err(res, 403, 'Нет доступа');
      subs = subs.filter(x => x.id !== mm[1]);
      await kvSet('submissions', subs);
    }
    return json(res, 200, { ok: true });
  }

  return err(res, 404, 'Неизвестный запрос');
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (p.startsWith('/api/')) return await apiRoute(req, res, p);
    let file = p === '/' ? '/index.html' : p;
    if (p.startsWith('/h/')) file = '/index.html';
    const fp = path.join(__dirname, path.normalize(file));
    if (!fp.startsWith(__dirname)) return send(res, 403, 'forbidden');
    fs.readFile(fp, (e, data) => {
      if (e) return send(res, 404, 'Not found');
      send(res, 200, data, TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream');
    });
  } catch (e) { err(res, 500, 'Server error: ' + e.message); }
});

server.listen(PORT, () => console.log('Server running on port ' + PORT));