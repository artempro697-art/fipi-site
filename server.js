'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const INVITE_CODE = process.env.INVITE_CODE || '';
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'index.html');

/* ---------- база ---------- */
let db = { users: [], sessions: {}, tasks: [], homeworks: [], submissions: [], classes: [], starts: {} };
try { Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
for (const k of ['users', 'tasks', 'homeworks', 'submissions', 'classes']) if (!Array.isArray(db[k])) db[k] = [];
if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
if (!db.starts || typeof db.starts !== 'object') db.starts = {};
db.users.forEach(u => { if (!u.role) u.role = 'teacher'; if (!Array.isArray(u.joined)) u.joined = []; });
db.homeworks.forEach(h => {
  if (!Array.isArray(h.tasks)) {
    h.tasks = (h.taskIds || []).map(id => db.tasks.find(t => t.id === id)).filter(Boolean)
      .map(t => ({ id: t.id, text: t.text, answer: t.answer, options: [], image: '', topic: '' }));
  }
  if (h.classId === undefined) h.classId = null;
  if (h.deadline === undefined) h.deadline = null;
  if (h.timeLimit === undefined) h.timeLimit = 0;
});

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- утилиты ---------- */
const rid = n => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const norm = s => String(s).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, '').replace(/,/g, '.');
function fail(code, msg) { const e = new Error(msg); e.code = code; return e; }

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function checkPw(u, pw) {
  if (!u.salt || !u.hash) return false;
  const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) {} }
  });
  return o;
}
function getUser(req) {
  const sid = cookies(req).sid;
  const s = sid && db.sessions[sid];
  if (!s) return null;
  if (now() - s.created > 30 * 864e5) { delete db.sessions[sid]; return null; }
  return db.users.find(u => u.id === s.userId) || null;
}
function startSession(req, res, u) {
  const sid = rid(24);
  db.sessions[sid] = { userId: u.id, created: now() };
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { tooBig = true; return; } chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return reject(fail(413, 'Слишком большой запрос'));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(fail(400, 'Неверный запрос')); }
    });
    req.on('error', reject);
  });
}
function need(u, role) {
  if (!u) throw fail(401, 'Нужно войти');
  if (role && u.role !== role) throw fail(403, 'Нет доступа');
}

/* ---------- вспомогательная логика ---------- */
const fails = {};
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

function cleanTask(b) {
  const text = str(b.text, 2000), answer = str(b.answer, 200), topic = str(b.topic, 40);
  let image = '';
  if (b.image) {
    if (typeof b.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(b.image) || b.image.length > 900000)
      throw fail(400, 'Картинка неподходящая или слишком большая');
    image = b.image;
  }
  if (!text && !image) throw fail(400, 'Введите условие или добавьте картинку');
  if (!answer) throw fail(400, 'Введите ответ');
  const options = Array.isArray(b.options) ? b.options.map(o => str(o, 100)).filter(Boolean).slice(0, 8) : [];
  if (options.length) {
    const acc = answer.split('|').map(norm);
    if (!options.some(o => acc.includes(norm(o)))) throw fail(400, 'Правильный ответ должен быть среди вариантов');
  }
  return { text, answer, topic, options, image };
}
const visibleTask = (u, t) => !t.owner || t.owner === u.id;

function ownHw(u, id) {
  const h = db.homeworks.find(x => x.id === id);
  if (!h || (h.owner && h.owner !== u.id)) throw fail(404, 'Не найдено');
  return h;
}
const pubTasks = h => h.tasks.map(t => ({ id: t.id, text: t.text, image: t.image || '', options: t.options || [] }));
const subSummary = s => ({ id: s.id, score: s.score, total: s.total, date: s.date, late: !!s.late, overtime: !!s.overtime, details: s.details });
const taskLabel = t => t.text || '[задание с картинкой]';

function grade(h, answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  let score = 0;
  const details = h.tasks.map(t => {
    const given = str(a[t.id], 300);
    const variants = String(t.answer).split('|');
    const ok = given !== '' && variants.map(norm).filter(Boolean).includes(norm(given));
    if (ok) score++;
    return { text: taskLabel(t), given, correct: variants.map(s => s.trim()).join(' или '), ok };
  });
  return { score, total: h.tasks.length, details };
}
function classCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)]; } while (db.classes.some(x => x.code === c));
  return c;
}
const userName = id => { const u = db.users.find(x => x.id === id); return u ? u.name : null; };
const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

/* ---------- API ---------- */
async function handleApi(req, res, p, m) {
  let mt;
  const u = getUser(req);

  if (p === '/api/config' && m === 'GET') return sendJson(res, 200, { inviteRequired: !!INVITE_CODE });

  if (p === '/api/register' && m === 'POST') {
    const b = await readBody(req);
    const name = str(b.name, 60), email = str(b.email, 100).toLowerCase(), pw = String(b.password || '');
    const role = b.role === 'teacher' ? 'teacher' : 'student';
    if (!name) throw fail(400, 'Введите имя');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Введите корректный email');
    if (pw.length < 6) throw fail(400, 'Пароль — минимум 6 символов');
    if (role === 'teacher' && INVITE_CODE && b.invite !== INVITE_CODE) throw fail(403, 'Неверный код приглашения для учителей');
    if (db.users.some(x => x.email === email)) throw fail(400, 'Этот email уже зарегистрирован');
    const salt = rid(16);
    const nu = { id: rid(6), name, email, role, salt, hash: hashPw(pw, salt), joined: [], created: now() };
    db.users.push(nu);
    startSession(req, res, nu);
    save();
    return sendJson(res, 200, { user: pub(nu) });
  }

  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req);
    const ip = ipOf(req);
    const f = fails[ip];
    if (f && f.until && f.until > now()) throw fail(429, 'Слишком много попыток. Подождите 10 минут.');
    const email = str(b.email, 100).toLowerCase();
    const user = db.users.find(x => x.email === email);
    if (!user || !checkPw(user, String(b.password || ''))) {
      const x = fails[ip] || (fails[ip] = { n: 0, until: 0 });
      x.n++;
      if (x.n >= 10) { x.until = now() + 600000; x.n = 0; }
      throw fail(400, 'Неверный email или пароль');
    }
    delete fails[ip];
    startSession(req, res, user);
    save();
    return sendJson(res, 200, { user: pub(user) });
  }

  if (p === '/api/logout' && m === 'POST') {
    const sid = cookies(req).sid;
    if (sid) { delete db.sessions[sid]; save(); }
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/me' && m === 'GET') {
    need(u);
    return sendJson(res, 200, { user: pub(u) });
  }

  /* ----- страница домашки (ученик / гость / учитель) ----- */
  if ((mt = p.match(/^\/api\/hw\/([a-f0-9]+)(\/start|\/submit)?$/))) {
    const h = db.homeworks.find(x => x.id === mt[1]);
    if (!h) throw fail(404, 'Домашка не найдена или удалена');
    const isStudent = u && u.role === 'student';
    const key = u ? u.id + ':' + h.id : '';

    if (!mt[2] && m === 'GET') {
      if (isStudent && !u.joined.includes(h.id)) { u.joined.push(h.id); save(); }
      const mine = isStudent ? db.submissions.find(s => s.userId === u.id && s.hwId === h.id) : null;
      const out = {
        id: h.id, title: h.title, count: h.tasks.length, deadline: h.deadline, timeLimit: h.timeLimit,
        role: u ? u.role : 'guest', studentName: u ? u.name : ''
      };
      if (mine) out.mine = subSummary(mine);
      else if (h.timeLimit && isStudent) {
        const st = db.starts[key];
        if (st) { out.tasks = pubTasks(h); out.timeLeft = Math.max(0, h.timeLimit * 60 - (now() - st) / 1000); }
        else out.needStart = true;
      } else if (h.timeLimit && !u) out.needStart = true;
      else out.tasks = pubTasks(h);
      return sendJson(res, 200, out);
    }

    if (mt[2] === '/start' && m === 'POST') {
      if (u && u.role === 'teacher') throw fail(403, 'Учитель может только смотреть');
      if (isStudent && db.submissions.some(s => s.userId === u.id && s.hwId === h.id)) throw fail(400, 'Вы уже сдали эту домашку');
      let left = h.timeLimit * 60;
      if (isStudent) {
        if (!db.starts[key]) { db.starts[key] = now(); save(); }
        left = Math.max(0, h.timeLimit * 60 - (now() - db.starts[key]) / 1000);
      }
      return sendJson(res, 200, { tasks: pubTasks(h), timeLeft: left });
    }

    if (mt[2] === '/submit' && m === 'POST') {
      if (u && u.role === 'teacher') throw fail(403, 'Учитель не сдаёт домашки — это предпросмотр');
      const b = await readBody(req);
      let name = '';
      let overtime = false;
      if (isStudent) {
        if (db.submissions.some(s => s.userId === u.id && s.hwId === h.id)) throw fail(400, 'Вы уже сдали эту домашку');
        name = u.name;
        if (h.timeLimit) {
          const st = db.starts[key];
          if (!st) throw fail(400, 'Сначала нажмите «Начать»');
          if (now() - st > h.timeLimit * 60000 + 60000) overtime = true;
        }
      } else {
        name = str(b.name, 60);
        if (!name) throw fail(400, 'Введите ваше имя');
      }
      const g = grade(h, b.answers);
      const sub = {
        id: rid(6), hwId: h.id, hwTitle: h.title, userId: isStudent ? u.id : null, name,
        score: g.score, total: g.total, details: g.details, date: now(),
        late: !!(h.deadline && now() > h.deadline), overtime
      };
      db.submissions.push(sub);
      save();
      return sendJson(res, 200, subSummary(sub));
    }
  }

  /* ----- кабинет ученика ----- */
  if (p === '/api/my' && m === 'GET') {
    need(u, 'student');
    const myClasses = db.classes.filter(c => c.students.includes(u.id));
    const subs = db.submissions.filter(s => s.userId === u.id);
    const doneIds = new Set(subs.map(s => s.hwId));
    const todo = db.homeworks
      .filter(h => !doneIds.has(h.id) && (u.joined.includes(h.id) || (h.classId && myClasses.some(c => c.id === h.classId))))
      .map(h => ({ id: h.id, title: h.title, count: h.tasks.length, deadline: h.deadline, timeLimit: h.timeLimit, created: h.created }))
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    const done = subs.slice().sort((a, b) => b.date - a.date)
      .map(s => ({ id: s.id, hwId: s.hwId, title: s.hwTitle, score: s.score, total: s.total, date: s.date, late: !!s.late, overtime: !!s.overtime, details: s.details }));
    const classes = myClasses.map(c => ({ id: c.id, name: c.name }));
    return sendJson(res, 200, { todo, done, classes });
  }

  if (p === '/api/classes/join' && m === 'POST') {
    need(u, 'student');
    const b = await readBody(req);
    const code = String(b.code || '').toUpperCase().replace(/\s/g, '');
    const c = db.classes.find(x => x.code === code);
    if (!c) throw fail(404, 'Класс с таким кодом не найден');
    if (!c.students.includes(u.id)) { c.students.push(u.id); save(); }
    return sendJson(res, 200, { id: c.id, name: c.name });
  }
  if ((mt = p.match(/^\/api\/classes\/([a-f0-9]+)\/leave$/)) && m === 'POST') {
    need(u, 'student');
    const c = db.classes.find(x => x.id === mt[1]);
    if (c) { c.students = c.students.filter(id => id !== u.id); save(); }
    return sendJson(res, 200, { ok: true });
  }

  /* ----- всё ниже — только учитель ----- */
  if (p.startsWith('/api/tasks') || p.startsWith('/api/homeworks') || p.startsWith('/api/classes') || p.startsWith('/api/submissions')) need(u, 'teacher');

  /* задания */
  if (p === '/api/tasks' && m === 'GET')
    return sendJson(res, 200, db.tasks.filter(t => visibleTask(u, t)).slice().reverse());

  if (p === '/api/tasks' && m === 'POST') {
    const b = await readBody(req);
    const t = Object.assign({ id: rid(6), owner: u.id, created: now() }, cleanTask(b));
    db.tasks.push(t);
    save();
    return sendJson(res, 200, t);
  }

  if (p === '/api/tasks/bulk' && m === 'POST') {
    const b = await readBody(req, 1e6);
    const lines = String(b.text || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 500);
    let added = 0, bad = 0;
    for (const l of lines.reverse()) {
      const parts = l.split(/[;\t]/).map(s => s.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) { bad++; continue; }
      db.tasks.push({
        id: rid(6), owner: u.id, text: parts[0].slice(0, 2000), answer: parts[1].slice(0, 200),
        topic: str(parts[2] || b.topic, 40), options: [], image: '', created: now()
      });
      added++;
    }
    save();
    return sendJson(res, 200, { added, bad });
  }

  if ((mt = p.match(/^\/api\/tasks\/([a-f0-9]+)$/))) {
    const t = db.tasks.find(x => x.id === mt[1]);
    if (!t || !visibleTask(u, t)) throw fail(404, 'Задание не найдено');
    if (m === 'PUT') {
      const b = await readBody(req);
      Object.assign(t, cleanTask(b), { owner: u.id });
      save();
      return sendJson(res, 200, t);
    }
    if (m === 'DELETE') {
      db.tasks = db.tasks.filter(x => x.id !== t.id);
      save();
      return sendJson(res, 200, { ok: true });
    }
  }

  /* классы учителя */
  if (p === '/api/classes' && m === 'GET') {
    const list = db.classes.filter(c => c.owner === u.id).map(c => ({
      id: c.id, name: c.name, code: c.code,
      students: c.students.map(id => {
        const s = db.users.find(x => x.id === id);
        return s ? { id: s.id, name: s.name, email: s.email } : null;
      }).filter(Boolean)
    }));
    return sendJson(res, 200, list);
  }
  if (p === '/api/classes' && m === 'POST') {
    const b = await readBody(req);
    const name = str(b.name, 60);
    if (!name) throw fail(400, 'Введите название класса');
    const c = { id: rid(6), owner: u.id, name, code: classCode(), students: [], created: now() };
    db.classes.push(c);
    save();
    return sendJson(res, 200, c);
  }
  if ((mt = p.match(/^\/api\/classes\/([a-f0-9]+)(?:\/students\/([a-f0-9]+))?$/)) && m === 'DELETE') {
    const c = db.classes.find(x => x.id === mt[1] && x.owner === u.id);
    if (!c) throw fail(404, 'Класс не найден');
    if (mt[2]) c.students = c.students.filter(id => id !== mt[2]);
    else db.classes = db.classes.filter(x => x.id !== c.id);
    save();
    return sendJson(res, 200, { ok: true });
  }

  /* домашки */
  if (p === '/api/homeworks' && m === 'GET') {
    const list = db.homeworks.filter(h => !h.owner || h.owner === u.id).slice().reverse().map(h => ({
      id: h.id, title: h.title, count: h.tasks.length, classId: h.classId,
      className: (db.classes.find(c => c.id === h.classId) || {}).name || '',
      deadline: h.deadline, timeLimit: h.timeLimit, created: h.created,
      submitted: db.submissions.filter(s => s.hwId === h.id).length
    }));
    return sendJson(res, 200, list);
  }

  if (p === '/api/homeworks' && m === 'POST') {
    const b = await readBody(req);
    const ids = [...new Set(Array.isArray(b.taskIds) ? b.taskIds : [])];
    const tasks = ids.map(id => db.tasks.find(t => t.id === id && visibleTask(u, t))).filter(Boolean).slice(0, 100)
      .map(t => ({ id: t.id, text: t.text, answer: t.answer, options: t.options || [], image: t.image || '', topic: t.topic || '' }));
    if (!tasks.length) throw fail(400, 'Выберите хотя бы одно задание');
    let classId = null;
    if (b.classId) {
      const c = db.classes.find(x => x.id === b.classId && x.owner === u.id);
      if (!c) throw fail(400, 'Класс не найден');
      classId = c.id;
    }
    const dl = Number(b.deadline);
    const h = {
      id: rid(5), owner: u.id, title: str(b.title, 100) || 'Домашка', tasks, classId,
      deadline: Number.isFinite(dl) && dl > 0 ? dl : null,
      timeLimit: Math.max(0, Math.min(300, parseInt(b.timeLimit, 10) || 0)),
      created: now()
    };
    db.homeworks.push(h);
    save();
    return sendJson(res, 200, { id: h.id });
  }

  if ((mt = p.match(/^\/api\/homeworks\/([a-f0-9]+)$/)) && m === 'DELETE') {
    const h = ownHw(u, mt[1]);
    db.homeworks = db.homeworks.filter(x => x.id !== h.id);
    save();
    return sendJson(res, 200, { ok: true });
  }

  if ((mt = p.match(/^\/api\/homeworks\/([a-f0-9]+)\/results$/)) && m === 'GET') {
    const h = ownHw(u, mt[1]);
    const subs = db.submissions.filter(s => s.hwId === h.id).sort((a, b) => b.date - a.date);
    const cls = h.classId ? db.classes.find(c => c.id === h.classId) : null;
    const missing = cls ? cls.students.filter(id => !subs.some(s => s.userId === id)).map(userName).filter(Boolean) : [];
    const avg = subs.length ? Math.round(subs.reduce((a, s) => a + (s.total ? s.score / s.total : 0), 0) / subs.length * 100) : 0;
    return sendJson(res, 200, {
      title: h.title, avg, missing,
      taskTexts: h.tasks.map(taskLabel),
      taskImages: h.tasks.map(t => t.image || ''),
      results: subs.map(s => ({ id: s.id, name: s.name, score: s.score, total: s.total, date: s.date, late: !!s.late, overtime: !!s.overtime, registered: !!s.userId, details: s.details }))
    });
  }

  if ((mt = p.match(/^\/api\/homeworks\/([a-f0-9]+)\/export$/)) && m === 'GET') {
    const h = ownHw(u, mt[1]);
    const subs = db.submissions.filter(s => s.hwId === h.id).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const header = ['Имя', 'Баллы', 'Всего', 'Процент', 'Дата', 'Опоздание'];
    h.tasks.forEach((_, i) => header.push('№' + (i + 1)));
    const rows = [header];
    subs.forEach(s => rows.push([
      s.name, s.score, s.total, (s.total ? Math.round(s.score / s.total * 100) : 0) + '%',
      new Date(s.date).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
      (s.late ? 'срок ' : '') + (s.overtime ? 'время' : '')
    ].concat(s.details.map(d => d.ok ? 1 : 0))));
    const csv = '\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('результаты-' + h.title + '.csv')
    });
    return res.end(csv);
  }

  if ((mt = p.match(/^\/api\/submissions\/([a-f0-9]+)$/)) && m === 'DELETE') {
    const s = db.submissions.find(x => x.id === mt[1]);
    if (!s) throw fail(404, 'Не найдено');
    const h = db.homeworks.find(x => x.id === s.hwId);
    if (!h || (h.owner && h.owner !== u.id)) throw fail(404, 'Не найдено');
    db.submissions = db.submissions.filter(x => x.id !== s.id);
    if (s.userId) delete db.starts[s.userId + ':' + s.hwId];
    save();
    return sendJson(res, 200, { ok: true });
  }

  throw fail(404, 'Не найдено');
}

/* ---------- сервер ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, m = req.method;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (m === 'GET' && (p === '/' || /^\/h\/[a-f0-9]+$/.test(p))) {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (p.startsWith('/api/')) return await handleApi(req, res, p, m);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  } catch (e) {
    const code = Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) sendJson(res, code, { error: code === 500 ? 'Ошибка сервера' : e.message });
    else res.end();
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log('Порт ' + PORT + ' занят. Скорее всего, сервер уже запущен в другом чёрном окне. Закройте его и запустите заново.');
  else console.log(e);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Сервер работает: http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const k in nets) for (const n of nets[k]) {
    if (n.family === 'IPv4' && !n.internal) console.log('Для учеников в вашей Wi-Fi сети: http://' + n.address + ':' + PORT);
  }
  if (INVITE_CODE) console.log('Для регистрации учителей нужен код приглашения.');
  if (!process.env.PORT && process.platform === 'win32') exec('start "" http://localhost:' + PORT);
});