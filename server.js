const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INVITE = process.env.INVITE_CODE || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const FREE_LIMIT = 20; // сколько первых учителей получают бесплатный доступ
const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_KEY = (process.env.SUPABASE_KEY || '').trim();
const USE_SB = !!(SB_URL && SB_KEY);
const FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const KEYS = ['users', 'sessions', 'tasks', 'homeworks', 'submissions', 'classes', 'starts', 'requests', 'feedback'];
const DEF = { users: [], sessions: {}, tasks: [], homeworks: [], submissions: [], classes: [], starts: {}, requests: [], feedback: [] };

let db = {};
const dirty = new Set();
let timer = null;

/* ---------- хранилище ---------- */
function sbHeaders(extra) {
  const h = Object.assign({ apikey: SB_KEY }, extra || {});
  if (SB_KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + SB_KEY;
  return h;
}
async function sbReq(p, opt) {
  opt = opt || {};
  const r = await fetch(SB_URL + '/rest/v1/' + p, Object.assign({}, opt, { headers: sbHeaders(opt.headers) }));
  if (!r.ok) throw new Error('Supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}
async function load() {
  if (USE_SB) {
    const r = await sbReq('kv?select=k,v&k=in.(' + KEYS.join(',') + ')');
    for (const x of await r.json()) db[x.k] = x.v;
  } else if (fs.existsSync(FILE)) {
    try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { console.error('data.json повреждён'); process.exit(1); }
  }
  for (const k of KEYS) if (db[k] === undefined || db[k] === null) db[k] = JSON.parse(JSON.stringify(DEF[k]));
  if (!USE_SB && !db.images) db.images = {};
}
function save(...ks) {
  ks.forEach(k => dirty.add(k));
  if (!timer) timer = setTimeout(flush, 300);
}
async function flush() {
  timer = null;
  const ks = [...dirty]; dirty.clear();
  try {
    if (USE_SB) {
      await sbReq('kv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(ks.map(k => ({ k, v: db[k] })))
      });
    } else {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    }
  } catch (e) {
    console.error('Ошибка сохранения:', e.message);
    ks.forEach(k => dirty.add(k));
    timer = setTimeout(flush, 5000);
  }
}

/* ---------- картинки ---------- */
async function putImg(d) {
  d = String(d || '');
  if (/^\/img\/[a-f0-9]{40}$/.test(d)) return d;
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(d) || d.length > 4e6) return '';
  const h = crypto.createHash('sha1').update(d).digest('hex');
  if (USE_SB) {
    await sbReq('kv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ k: 'img:' + h, v: { d } }])
    });
  } else { db.images[h] = d; save('images'); }
  return '/img/' + h;
}
async function getImg(h) {
  if (USE_SB) {
    const r = await sbReq('kv?select=v&k=eq.img:' + h);
    const rows = await r.json();
    return rows[0] && rows[0].v && rows[0].v.d;
  }
  return db.images[h];
}

/* ---------- утилиты ---------- */
const rid = (n = 8) => crypto.randomBytes(n).toString('hex').slice(0, n);
const str = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let c;
  do { c = ''; for (const x of crypto.randomBytes(6)) c += AL[x % AL.length]; }
  while (db.classes.some(k => k.code === c));
  return c;
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), String(salt), 64).toString('hex');
function pwOk(u, pw) {
  try {
    if (!u || !u.salt || !u.hash) return false;
    const a = Buffer.from(hashPw(pw == null ? '' : pw, u.salt), 'hex'), c = Buffer.from(String(u.hash), 'hex');
    return a.length === c.length && crypto.timingSafeEqual(a, c);
  } catch (e) { return false; }
}
function send(res, code, obj, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 30e6) {
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > limit) { no(new Error('big')); req.destroy(); } else c.push(d); });
    req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c).toString()) : {}); } catch (e) { no(new Error('bad')); } });
    req.on('error', no);
  });
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
  if (s.exp < Date.now()) { delete db.sessions[sid]; save('sessions'); return null; }
  return db.users.find(u => u.id === s.uid) || null;
}
function startSession(req, u) {
  const sid = crypto.randomBytes(24).toString('hex');
  db.sessions[sid] = { uid: u.id, exp: Date.now() + 30 * 864e5 };
  save('sessions');
  const sec = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return 'sid=' + sid + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000' + sec;
}
const active = u => u.role === 'teacher' && (u.plan === 'free' || (u.plan === 'pro' && (!u.proUntil || u.proUntil > Date.now())));
const pub = u => ({
  id: u.id, email: u.email, name: u.name, role: u.role, created: u.created || 0,
  teacherCode: u.teacherCode || null, seq: u.seq || null, plan: u.plan || null, proUntil: u.proUntil || 0,
  active: u.role === 'teacher' ? active(u) : true
});
const nameOf = id => { const u = db.users.find(x => x.id === id); return u ? u.name : '—'; };
function stats() {
  const t = db.users.filter(u => u.role === 'teacher').length;
  const s = db.users.filter(u => u.role === 'student').length;
  return { teachers: t, students: s, freeLimit: FREE_LIMIT, freeLeft: Math.max(0, FREE_LIMIT - t) };
}
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, '').replace(/,/g, '.');
const isRight = (given, right) => { const g = norm(given); return g !== '' && String(right).split('|').some(v => norm(v) === g); };

/* приведение старых данных к новому формату */
function migrate() {
  let u = false, c = false, h = false, s = false;
  db.homeworks.forEach(x => { if (!Array.isArray(x.items)) { x.items = []; h = true; } });
  db.submissions.forEach(x => { if (!Array.isArray(x.details)) { x.details = []; s = true; } });
  db.classes.forEach(x => { if (!Array.isArray(x.students)) { x.students = []; c = true; } });
  const ts = db.users.filter(x => x.role === 'teacher').sort((a, b) => (a.created || 0) - (b.created || 0));
  let maxSeq = Math.max(0, ...ts.map(x => x.seq || 0));
  for (const t of ts) {
    if (!t.seq) { t.seq = ++maxSeq; u = true; }
    if (!t.plan) { t.plan = t.seq <= FREE_LIMIT ? 'free' : 'none'; u = true; }
    if (!t.teacherCode) {
      t.teacherCode = genCode();
      db.classes.push({ id: rid(), teacherId: t.id, name: 'Мои ученики', code: t.teacherCode, students: [], created: Date.now() });
      u = true; c = true;
    }
  }
  if (u) save('users');
  if (c) save('classes');
  if (h) save('homeworks');
  if (s) save('submissions');
  if (u || c || h || s) console.log('Старые данные приведены к новому формату.');
}

const fails = {};
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function checkPw(req, res, u, pw) {
  const ip = ipOf(req), f = fails[ip];
  if (f && f.until > Date.now()) { send(res, 429, { error: 'Слишком много попыток. Подождите 10 минут.' }); return false; }
  if (pwOk(u, pw)) { delete fails[ip]; return true; }
  const x = fails[ip] || (fails[ip] = { n: 0, until: 0 });
  if (++x.n >= 10) { x.until = Date.now() + 600000; x.n = 0; }
  send(res, 401, { error: 'Неверный пароль' });
  return false;
}

/* ---------- регистрация / вход ---------- */
function register(req, res, b) {
  const email = str(b.email, 100).toLowerCase(), name = str(b.name, 40), pw = String(b.password || '');
  const role = b.role === 'teacher' ? 'teacher' : b.role === 'student' ? 'student' : '';
  if (!role) return send(res, 400, { error: 'Выберите роль' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Укажите корректный email' });
  if (name.length < 2) return send(res, 400, { error: 'Укажите имя (от 2 символов)' });
  if (pw.length < 6) return send(res, 400, { error: 'Пароль — минимум 6 символов' });
  if (db.users.some(u => u.email === email)) return send(res, 409, { error: 'Этот email уже зарегистрирован' });
  if (role === 'teacher' && INVITE && b.invite !== INVITE) return send(res, 403, { error: 'Неверный код приглашения' });
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: rid(10), email, name, role, salt, hash: hashPw(pw, salt), created: Date.now() };
  if (role === 'teacher') {
    const ts = db.users.filter(x => x.role === 'teacher');
    u.seq = Math.max(0, ...ts.map(x => x.seq || 0)) + 1;
    u.plan = ts.length < FREE_LIMIT ? 'free' : 'none';
    u.teacherCode = genCode();
    db.classes.push({ id: rid(), teacherId: u.id, name: 'Мои ученики', code: u.teacherCode, students: [], created: Date.now() });
    save('classes');
  }
  db.users.push(u); save('users');
  send(res, 200, { user: pub(u) }, { 'Set-Cookie': startSession(req, u) });
}
function login(req, res, b) {
  const ip = ipOf(req), f = fails[ip];
  if (f && f.until > Date.now()) return send(res, 429, { error: 'Слишком много попыток. Подождите 10 минут.' });
  const u = db.users.find(x => String(x.email || '').toLowerCase() === str(b.email, 100).toLowerCase());
  const ok = !!u && pwOk(u, b.password);
  if (!ok) {
    const x = fails[ip] || (fails[ip] = { n: 0, until: 0 });
    if (++x.n >= 10) { x.until = Date.now() + 600000; x.n = 0; }
    return send(res, 401, { error: 'Неверный email или пароль' });
  }
  delete fails[ip];
  send(res, 200, { user: pub(u) }, { 'Set-Cookie': startSession(req, u) });
}

/* ---------- аккаунт ---------- */
function removeUser(u) {
  if (u.role === 'teacher') {
    const hwIds = db.homeworks.filter(h => h.teacherId === u.id).map(h => h.id);
    db.homeworks = db.homeworks.filter(h => h.teacherId !== u.id);
    db.submissions = db.submissions.filter(s => !hwIds.includes(s.hwId));
    db.tasks = db.tasks.filter(t => t.teacherId !== u.id);
    db.classes = db.classes.filter(c => c.teacherId !== u.id);
  } else {
    db.submissions = db.submissions.filter(s => s.userId !== u.id);
    db.classes.forEach(c => { c.students = c.students.filter(x => x !== u.id); });
  }
  db.users = db.users.filter(x => x !== u);
  for (const k in db.sessions) if (db.sessions[k].uid === u.id) delete db.sessions[k];
  save('homeworks', 'submissions', 'tasks', 'classes', 'users', 'sessions');
}

/* ---------- админ ---------- */
function admin(res, p, url) {
  if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) return send(res, 403, { error: 'Нет доступа' });
  if (p === '/api/admin/stats') {
    return send(res, 200, {
      stats: stats(),
      users: db.users.map(u => ({ email: u.email, name: u.name, role: u.role, passwordOk: !!(u.salt && u.hash), plan: u.plan || '', created: u.created || 0 })),
      requests: db.requests,
      feedback: db.feedback.slice().reverse()
    });
  }
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  const u = db.users.find(x => String(x.email || '').toLowerCase() === email);
  if (!u) return send(res, 404, { error: 'Пользователь с таким email не найден' });
  if (p === '/api/admin/setpass') {
    const pw = String(url.searchParams.get('password') || '');
    if (pw.length < 6) return send(res, 400, { error: 'Пароль — минимум 6 символов' });
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashPw(pw, u.salt);
    for (const k in db.sessions) if (db.sessions[k].uid === u.id) delete db.sessions[k];
    save('users', 'sessions');
    return send(res, 200, { ok: true, email: u.email, message: 'Пароль изменён. Войдите с новым паролем.' });
  }
  if (u.role !== 'teacher') return send(res, 400, { error: 'Это не учитель' });
  if (p === '/api/admin/grant') {
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    u.plan = 'pro'; u.proUntil = days > 0 ? Date.now() + days * 864e5 : 0;
    save('users');
    return send(res, 200, { ok: true, email: u.email, plan: u.plan, proUntil: u.proUntil });
  }
  if (p === '/api/admin/revoke') {
    u.plan = 'none'; save('users');
    return send(res, 200, { ok: true, email: u.email, plan: u.plan });
  }
  send(res, 404, { error: 'Нет такого действия' });
}

/* ---------- страница домашки (открыта и гостям) ---------- */
function resultOf(s) { return { score: s.score, maxScore: s.maxScore, date: s.date, details: s.details }; }
async function hwRoute(req, res, id, act, b, user) {
  const hw = db.homeworks.find(h => h.id === id);
  if (!hw) return send(res, 404, { error: 'Домашка не найдена' });
  const tasks = hw.items.map((x, i) => ({ i, text: x.text, img: x.img, auto: !!x.answer }));
  if (!act && req.method === 'GET') {
    const out = {
      homework: { id: hw.id, title: hw.title, exam: hw.exam || '', timeLimit: hw.timeLimit || 0, teacher: nameOf(hw.teacherId), count: hw.items.length, isOwner: !!(user && user.id === hw.teacherId) },
      tasks
    };
    if (user && user.role === 'student') {
      const s = db.submissions.find(x => x.hwId === id && x.userId === user.id);
      if (s) out.result = resultOf(s);
    }
    return send(res, 200, out);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Нельзя' });
  const key = user ? user.id : 'g:' + str(b.name, 40).toLowerCase();
  const sk = id + '|' + key;
  if (act === 'start') {
    if (!db.starts[sk]) { db.starts[sk] = Date.now(); save('starts'); }
    const rem = hw.timeLimit ? Math.max(0, hw.timeLimit * 60000 - (Date.now() - db.starts[sk])) : null;
    return send(res, 200, { remainingMs: rem });
  }
  if (act === 'submit') {
    if (user && user.role === 'teacher') return send(res, 403, { error: 'Учитель не может сдавать домашку' });
    const name = user ? user.name : str(b.name, 40);
    if (!name) return send(res, 400, { error: 'Введите имя' });
    if (user) {
      const old = db.submissions.find(x => x.hwId === id && x.userId === user.id);
      if (old) return send(res, 409, { error: 'Вы уже сдали эту домашку', alreadySubmitted: true, result: resultOf(old) });
    }
    const answers = b.answers || {};
    const details = hw.items.map((x, i) => {
      const given = str(answers[i], 200);
      if (!x.answer) return { correct: null, given, right: '' };
      return { correct: isRight(given, x.answer), given, right: x.answer };
    });
    const s = {
      id: rid(10), hwId: id, userId: user ? user.id : null, name,
      score: details.filter(d => d.correct === true).length,
      maxScore: hw.items.filter(x => x.answer).length,
      details, date: Date.now(),
      late: !!(hw.timeLimit && db.starts[sk] && Date.now() > db.starts[sk] + hw.timeLimit * 60000 + 30000)
    };
    db.submissions.push(s); save('submissions');
    return send(res, 200, { result: resultOf(s) });
  }
  send(res, 404, { error: 'Нет такого действия' });
}

/* ---------- результаты для учителя ---------- */
function buildResults(hw) {
  const subs = db.submissions.filter(s => s.hwId === hw.id);
  const errors = [];
  hw.items.forEach((x, i) => {
    if (!x.answer) return;
    const total = subs.filter(s => s.details[i]).length;
    const wrong = subs.filter(s => s.details[i] && s.details[i].correct === false).length;
    if (wrong > 0) errors.push({ i, total, wrong });
  });
  errors.sort((a, b) => b.wrong / b.total - a.wrong / a.total);
  let notSubmitted = [];
  if (hw.classId) {
    const c = db.classes.find(k => k.id === hw.classId);
    if (c) notSubmitted = c.students.filter(id => !subs.some(s => s.userId === id)).map(nameOf);
  }
  const avg = subs.length ? Math.round(subs.reduce((a, s) => a + (s.maxScore ? s.score / s.maxScore : 0), 0) / subs.length * 100) : 0;
  return {
    homework: { id: hw.id, title: hw.title, count: hw.items.length },
    results: subs.map(s => ({ id: s.id, name: s.name, score: s.score || 0, maxScore: s.maxScore || 0, date: s.date, late: s.late })),
    avg, errors, notSubmitted
  };
}

/* ---------- API ---------- */
async function api(req, res, p, m, url) {
  let b = {};
  if (m === 'POST' || m === 'PUT') {
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'Неверный запрос' }); }
  }
  const user = getUser(req);
  let r;

  if (p === '/api/config' && m === 'GET') return send(res, 200, { inviteRequired: !!INVITE });
  if (p === '/api/stats' && m === 'GET') return send(res, 200, stats());
  if (p === '/api/register' && m === 'POST') return register(req, res, b);
  if (p === '/api/login' && m === 'POST') return login(req, res, b);
  if (p === '/api/logout' && m === 'POST') {
    const sid = cookies(req).sid;
    if (sid && db.sessions[sid]) { delete db.sessions[sid]; save('sessions'); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }
  if (p === '/api/me') return send(res, 200, { user: user ? pub(user) : null });
  if (p.startsWith('/api/admin/')) return admin(res, p, url);
  if ((r = /^\/api\/hw\/(\w+)(?:\/(start|submit))?$/.exec(p))) return hwRoute(req, res, r[1], r[2], b, user);

  if (!user) return send(res, 401, { error: 'Нужно войти' });

  if (p === '/api/subscribe' && m === 'POST') {
    const contact = str(b.contact, 120);
    if (contact.length < 3) return send(res, 400, { error: 'Укажите телефон, Telegram или email' });
    db.requests.push({ userId: user.id, email: user.email, name: user.name, contact, date: Date.now() });
    save('requests');
    return send(res, 200, { ok: true });
  }

  /* --- аккаунт и пожелания (для всех ролей) --- */
  if (p === '/api/account' && m === 'PUT') {
    const name = str(b.name, 40);
    if (name.length < 2) return send(res, 400, { error: 'Имя — минимум 2 символа' });
    user.name = name;
    db.submissions.forEach(s => { if (s.userId === user.id) s.name = name; });
    save('users', 'submissions');
    return send(res, 200, { user: pub(user) });
  }
  if (p === '/api/account/email' && m === 'POST') {
    const email = str(b.email, 100).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Укажите корректный email' });
    if (db.users.some(u => u.email === email && u !== user)) return send(res, 409, { error: 'Этот email уже занят' });
    if (!checkPw(req, res, user, b.password)) return;
    user.email = email; save('users');
    return send(res, 200, { user: pub(user) });
  }
  if (p === '/api/account/password' && m === 'POST') {
    const np = String(b.password || '');
    if (np.length < 6) return send(res, 400, { error: 'Новый пароль — минимум 6 символов' });
    if (!checkPw(req, res, user, b.old)) return;
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = hashPw(np, user.salt);
    const cur = cookies(req).sid;
    for (const k in db.sessions) if (db.sessions[k].uid === user.id && k !== cur) delete db.sessions[k];
    save('users', 'sessions');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/account/delete' && m === 'POST') {
    if (!checkPw(req, res, user, b.password)) return;
    removeUser(user);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }
  if (p === '/api/feedback' && m === 'POST') {
    const text = str(b.text, 1000);
    if (text.length < 3) return send(res, 400, { error: 'Напишите хотя бы пару слов' });
    const dayAgo = Date.now() - 864e5;
    if (db.feedback.filter(f => f.userId === user.id && f.date > dayAgo).length >= 10) return send(res, 429, { error: 'Сегодня уже много сообщений. Попробуйте завтра.' });
    db.feedback.push({ id: rid(), userId: user.id, email: user.email, name: user.name, role: user.role, kind: str(b.kind, 30) || 'Идея', text, date: Date.now() });
    if (db.feedback.length > 2000) db.feedback.shift();
    save('feedback');
    return send(res, 200, { ok: true });
  }

  /* --- ученик --- */
  if (user.role === 'student') {
    if (p === '/api/my' && m === 'GET') {
      const cls = db.classes.filter(c => c.students.includes(user.id));
      const ids = cls.map(c => c.id);
      const mine = db.submissions.filter(s => s.userId === user.id);
      const todo = db.homeworks
        .filter(h => ids.includes(h.classId) && !mine.some(s => s.hwId === h.id))
        .sort((a, c) => c.created - a.created)
        .map(h => ({ id: h.id, title: h.title, exam: h.exam || '', count: h.items.length, timeLimit: h.timeLimit || 0, teacher: nameOf(h.teacherId) }));
      const done = mine.map(s => {
        const h = db.homeworks.find(x => x.id === s.hwId);
        return h ? { hwId: h.id, title: h.title, exam: h.exam || '', score: s.score || 0, maxScore: s.maxScore || 0, date: s.date } : null;
      }).filter(Boolean).sort((a, c) => c.date - a.date);
      return send(res, 200, { todo, done, classes: cls.map(c => ({ id: c.id, name: c.name, teacher: nameOf(c.teacherId) })) });
    }
    if (p === '/api/classes/join' && m === 'POST') {
      const code = str(b.code, 20).toUpperCase();
      const c = db.classes.find(k => k.code === code);
      if (!c) return send(res, 404, { error: 'Код не найден. Проверьте, что вводите код учителя без пробелов.' });
      if (!c.students.includes(user.id)) { c.students.push(user.id); save('classes'); }
      return send(res, 200, { ok: true });
    }
    if ((r = /^\/api\/classes\/(\w+)\/leave$/.exec(p)) && m === 'POST') {
      const c = db.classes.find(k => k.id === r[1]);
      if (c) { c.students = c.students.filter(x => x !== user.id); save('classes'); }
      return send(res, 200, { ok: true });
    }
    return send(res, 403, { error: 'Нет доступа' });
  }

  /* --- учитель --- */
  if (user.role !== 'teacher') return send(res, 403, { error: 'Нет доступа' });
  if (!active(user)) return send(res, 402, { error: 'Нужна подписка', paywall: true });

  if (p === '/api/overview' && m === 'GET') {
    const hws = db.homeworks.filter(h => h.teacherId === user.id);
    const ids = new Set(hws.map(h => h.id));
    const subs = db.submissions.filter(s => ids.has(s.hwId));
    const st = new Set();
    db.classes.filter(c => c.teacherId === user.id).forEach(c => c.students.forEach(x => st.add(x)));
    const avg = subs.length ? Math.round(subs.reduce((a, s) => a + (s.maxScore ? s.score / s.maxScore : 0), 0) / subs.length * 100) : 0;
    const recent = subs.slice().sort((a, c) => c.date - a.date).slice(0, 8).map(s => ({
      name: s.name, score: s.score || 0, maxScore: s.maxScore || 0, date: s.date, hwId: s.hwId,
      title: (hws.find(h => h.id === s.hwId) || {}).title || ''
    }));
    return send(res, 200, {
      homeworks: hws.length, tasks: db.tasks.filter(t => t.teacherId === user.id).length,
      students: st.size, submissions: subs.length, avg, recent
    });
  }

  if (p === '/api/tasks') {
    if (m === 'GET') return send(res, 200, { tasks: db.tasks.filter(t => t.teacherId === user.id) });
    if (m === 'POST') {
      const text = str(b.text, 3000), img = b.img ? await putImg(b.img) : '';
      if (!text && !img) return send(res, 400, { error: 'Добавьте текст или картинку' });
      const t = { id: rid(), teacherId: user.id, text, answer: str(b.answer, 200), img, topic: str(b.topic, 60), created: Date.now() };
      db.tasks.push(t); save('tasks');
      return send(res, 200, { task: t });
    }
  }
  if ((r = /^\/api\/tasks\/(\w+)$/.exec(p))) {
    const t = db.tasks.find(x => x.id === r[1] && x.teacherId === user.id);
    if (!t) return send(res, 404, { error: 'Не найдено' });
    if (m === 'DELETE') { db.tasks = db.tasks.filter(x => x !== t); save('tasks'); return send(res, 200, { ok: true }); }
    if (m === 'PUT') {
      if (b.text !== undefined) t.text = str(b.text, 3000);
      if (b.answer !== undefined) t.answer = str(b.answer, 200);
      if (b.topic !== undefined) t.topic = str(b.topic, 60);
      save('tasks');
      return send(res, 200, { task: t });
    }
  }

  if (p === '/api/classes') {
    if (m === 'GET') {
      return send(res, 200, {
        classes: db.classes.filter(c => c.teacherId === user.id).map(c => ({
          id: c.id, name: c.name, code: c.code, isMain: c.code === user.teacherCode,
          students: c.students.map(id => { const s = db.users.find(x => x.id === id); return s ? { id: s.id, name: s.name, email: s.email } : null; }).filter(Boolean)
        }))
      });
    }
    if (m === 'POST') {
      const name = str(b.name, 40);
      if (!name) return send(res, 400, { error: 'Введите название класса' });
      const c = { id: rid(), teacherId: user.id, name, code: genCode(), students: [], created: Date.now() };
      db.classes.push(c); save('classes');
      return send(res, 200, { class: c });
    }
  }
  if ((r = /^\/api\/classes\/(\w+)\/students\/(\w+)$/.exec(p)) && m === 'DELETE') {
    const c = db.classes.find(k => k.id === r[1] && k.teacherId === user.id);
    if (!c) return send(res, 404, { error: 'Не найдено' });
    c.students = c.students.filter(x => x !== r[2]); save('classes');
    return send(res, 200, { ok: true });
  }
  if ((r = /^\/api\/classes\/(\w+)$/.exec(p)) && m === 'DELETE') {
    const c = db.classes.find(k => k.id === r[1] && k.teacherId === user.id);
    if (!c) return send(res, 404, { error: 'Не найдено' });
    if (c.code === user.teacherCode) return send(res, 400, { error: 'Основной класс удалить нельзя — это ваш код учителя' });
    db.classes = db.classes.filter(k => k !== c); save('classes');
    return send(res, 200, { ok: true });
  }

  if (p === '/api/homeworks') {
    if (m === 'GET') {
      return send(res, 200, {
        homeworks: db.homeworks.filter(h => h.teacherId === user.id).sort((a, c) => c.created - a.created).map(h => {
          const c = db.classes.find(k => k.id === h.classId);
          return { id: h.id, title: h.title, exam: h.exam || '', count: h.items.length, classId: h.classId, className: c ? c.name : '', created: h.created, timeLimit: h.timeLimit || 0, done: db.submissions.filter(s => s.hwId === h.id).length };
        })
      });
    }
    if (m === 'POST') {
      let items = [];
      if (Array.isArray(b.items)) {
        for (const x of b.items.slice(0, 100)) {
          items.push({ text: str(x.text, 3000), img: x.img ? await putImg(x.img) : '', answer: str(x.answer, 200), topic: '' });
        }
      } else if (Array.isArray(b.taskIds)) {
        for (const id of b.taskIds.slice(0, 100)) {
          const t = db.tasks.find(x => x.id === id && x.teacherId === user.id);
          if (t) items.push({ text: t.text, img: t.img, answer: t.answer, topic: t.topic });
        }
      }
      items = items.filter(x => x.text || x.img);
      if (!items.length) return send(res, 400, { error: 'Нет заданий' });
      let classId = null;
      if (b.classId) {
        const c = db.classes.find(k => k.id === b.classId && k.teacherId === user.id);
        if (c) classId = c.id;
      }
      const hw = {
        id: rid(8), teacherId: user.id, title: str(b.title, 80) || 'Домашка', exam: str(b.exam, 40), items, classId,
        timeLimit: Math.max(0, Math.min(600, parseInt(b.timeLimit, 10) || 0)), created: Date.now()
      };
      db.homeworks.push(hw); save('homeworks');
      return send(res, 200, { homework: { id: hw.id } });
    }
  }
  if ((r = /^\/api\/homeworks\/(\w+)(?:\/(results|export))?$/.exec(p))) {
    const hw = db.homeworks.find(h => h.id === r[1] && h.teacherId === user.id);
    if (!hw) return send(res, 404, { error: 'Не найдено' });
    if (m === 'DELETE' && !r[2]) {
      db.homeworks = db.homeworks.filter(h => h !== hw);
      db.submissions = db.submissions.filter(s => s.hwId !== hw.id);
      save('homeworks', 'submissions');
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && r[2] === 'results') return send(res, 200, buildResults(hw));
    if (m === 'GET' && r[2] === 'export') {
      const subs = db.submissions.filter(s => s.hwId === hw.id);
      const rows = [['Имя', 'Баллы', 'Из', 'Дата'].concat(hw.items.map((_, i) => '№' + (i + 1)))];
      subs.forEach(s => rows.push([s.name, s.score, s.maxScore, new Date(s.date).toISOString().slice(0, 16).replace('T', ' ')].concat(s.details.map(d => d.correct === null ? '' : d.correct ? 1 : 0))));
      const cell = c => { c = String(c); if (/^[=+\-@]/.test(c)) c = "'" + c; return '"' + c.replace(/"/g, '""') + '"'; };
      const csv = '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="results.csv"' });
      return res.end(csv);
    }
  }
  if ((r = /^\/api\/submissions\/(\w+)$/.exec(p)) && m === 'DELETE') {
    const s = db.submissions.find(x => x.id === r[1]);
    const hw = s && db.homeworks.find(h => h.id === s.hwId && h.teacherId === user.id);
    if (!hw) return send(res, 404, { error: 'Не найдено' });
    db.submissions = db.submissions.filter(x => x !== s); save('submissions');
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Не найдено' });
}

/* ---------- сервер ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await api(req, res, p, req.method, url);
    if (p.startsWith('/img/')) {
      const h = p.slice(5);
      const d = /^[a-f0-9]{40}$/.test(h) ? await getImg(h) : null;
      const i = d ? d.indexOf(',') : -1;
      if (i < 0) { res.writeHead(404); return res.end(); }
      const mime = /^data:(image\/[\w+]+);base64/.exec(d.slice(0, i));
      res.writeHead(200, { 'Content-Type': mime ? mime[1] : 'image/jpeg', 'Cache-Control': 'public,max-age=31536000,immutable' });
      return res.end(Buffer.from(d.slice(i + 1), 'base64'));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  } catch (e) {
    console.error('ОШИБКА ЗАПРОСА', req.method, req.url.split('?')[0], e && e.stack || e);
    if (!res.headersSent) send(res, 500, { error: 'Ошибка сервера' }); else res.end();
  }
});

(async () => {
  try { await load(); }
  catch (e) { console.error('Не удалось загрузить данные:', e.message); process.exit(1); }
  const now = Date.now();
  for (const k in db.sessions) if (db.sessions[k].exp < now) delete db.sessions[k];
  migrate();
  console.log(USE_SB ? 'Данные хранятся в Supabase.' : 'Данные хранятся в файле ' + FILE);
  server.listen(PORT, () => console.log('Сервер работает: http://localhost:' + PORT));
  if (USE_SB) setInterval(() => sbReq('kv?select=k&limit=1').catch(e => console.error('ping', e.message)), 12 * 3600e3);
})();