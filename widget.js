(function () {
  if (window.__cw) return;
  window.__cw = 1;

  var cid = '';
  try { cid = localStorage.getItem('cid') || ''; } catch (e) {}
  if (!/^[A-Za-z0-9]{8,40}$/.test(cid)) {
    cid = '';
    for (var i = 0; i < 24; i++) cid += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
    try { localStorage.setItem('cid', cid); } catch (e) {}
  }

  var css =
    '#cw{position:fixed;right:18px;bottom:18px;z-index:9999;display:flex;gap:8px;align-items:center;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#141c2b}' +
    '#cw [hidden]{display:none!important}' +
    '#cw *{box-sizing:border-box}' +
    '#cw-btn{background:#10203a;color:#fff;border:0;border-radius:24px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(16,32,58,.35);position:relative}' +
    '#cw-as{background:#fff;color:#10203a;border:1px solid #c7cfdd;border-radius:24px;padding:11px 16px;font-weight:600;text-decoration:none;box-shadow:0 4px 14px rgba(16,32,58,.2);position:relative}' +
    '#cw-badge,#cw-ab{position:absolute;top:-6px;right:-6px;background:#d92d20;color:#fff;border-radius:10px;min-width:20px;height:20px;padding:0 5px;font-size:12px;line-height:20px;text-align:center}' +
    '#cw-box{position:absolute;right:0;bottom:52px;width:340px;max-width:calc(100vw - 36px);background:#fff;border:1px solid #d5dbe6;border-radius:10px;box-shadow:0 8px 28px rgba(16,32,58,.25);display:flex;flex-direction:column;overflow:hidden}' +
    '#cw-head{background:#10203a;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;font-weight:600}' +
    '#cw-x{background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}' +
    '#cw-msgs{height:260px;max-height:45vh;overflow:auto;padding:10px;background:#f3f5f9}' +
    '.cw-m{max-width:85%;padding:7px 10px;margin:0 0 8px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word}' +
    '.cw-u{background:#1f5fc9;color:#fff;margin-left:auto}' +
    '.cw-a{background:#fff;border:1px solid #d5dbe6}' +
    '.cw-h{color:#5b6679;font-size:13px;padding:4px}' +
    '#cw-foot{padding:10px;border-top:1px solid #e3e7ef}' +
    '#cw input,#cw textarea{width:100%;border:1px solid #c7cfdd;border-radius:6px;padding:8px;margin-bottom:6px;font:16px/1.3 inherit;font-family:inherit;background:#fff;color:#141c2b;-webkit-text-fill-color:#141c2b}' +
    '#cw textarea{resize:none;height:64px}' +
    '#cw-send{width:100%;background:#1f5fc9;color:#fff;border:0;border-radius:6px;padding:9px;font:inherit;font-weight:600;cursor:pointer}' +
    '#cw-send:disabled{opacity:.6}' +
    '#cw-err{color:#d92d20;font-size:13px;min-height:0;margin-bottom:4px}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var root = document.createElement('div');
  root.id = 'cw';
  root.innerHTML =
    '<div id="cw-box" hidden>' +
      '<div id="cw-head"><span>Написать администратору</span><button id="cw-x" type="button" aria-label="Закрыть">×</button></div>' +
      '<div id="cw-msgs"></div>' +
      '<div id="cw-foot">' +
        '<div id="cw-guest"><input id="cw-name" placeholder="Ваше имя" maxlength="60"><input id="cw-contact" placeholder="Ваш email (чтобы мы вас узнали)" maxlength="100"></div>' +
        '<textarea id="cw-text" placeholder="Вопрос, идея или проблема со входом…" maxlength="2000"></textarea>' +
        '<div id="cw-err"></div>' +
        '<button id="cw-send" type="button">Отправить</button>' +
      '</div>' +
    '</div>' +
    '<a id="cw-as" href="/assign" hidden></a>' +
    '<button id="cw-btn" type="button">✉ Написать админу<span id="cw-badge" hidden></span></button>';
  document.body.appendChild(root);

  var box = document.getElementById('cw-box'),
      msgs = document.getElementById('cw-msgs'),
      badge = document.getElementById('cw-badge'),
      err = document.getElementById('cw-err'),
      text = document.getElementById('cw-text'),
      sendBtn = document.getElementById('cw-send'),
      guest = document.getElementById('cw-guest'),
      asBtn = document.getElementById('cw-as'),
      logged = false;

  function j(url, opt) {
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('Ошибка ' + r.status));
        return d;
      });
    });
  }
  function setBadge(n) {
    if (n > 0 && box.hidden) { badge.textContent = n; badge.hidden = false; }
    else badge.hidden = true;
  }
  function render(list) {
    msgs.innerHTML = '';
    if (!list.length) {
      var h = document.createElement('div');
      h.className = 'cw-h';
      h.textContent = logged
        ? 'Напишите вопрос или идею — ответ придёт сюда.'
        : 'Не получается войти? Укажите имя и email и опишите проблему — администратор ответит прямо в этом окне.';
      msgs.appendChild(h);
    }
    list.forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'cw-m ' + (m.from === 'admin' ? 'cw-a' : 'cw-u');
      d.textContent = m.text;
      msgs.appendChild(d);
    });
    msgs.scrollTop = msgs.scrollHeight;
  }
  function load() {
    return j('/x/chat?cid=' + cid).then(function (d) {
      logged = !!d.logged;
      guest.hidden = logged;
      render(d.msgs || []);
      setBadge(0);
    }).catch(function () {});
  }
  function tasks() {
    if (location.pathname === '/assign') { asBtn.hidden = true; return; }
    j('/x/a/me').then(function (d) {
      if (d.role === 'teacher' || d.role === 'student') {
        asBtn.innerHTML = (d.role === 'teacher' ? '📚 Задания' : '📚 Мои задания') +
          (d.n > 0 ? '<span id="cw-ab">' + d.n + '</span>' : '');
        asBtn.hidden = false;
      } else asBtn.hidden = true;
    }).catch(function () {});
  }
  function ping() {
    if (document.hidden) return;
    j('/x/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid: cid, page: location.pathname + location.hash })
    }).then(function (d) {
      if (d.unread > 0) { if (box.hidden) setBadge(d.unread); else load(); }
    }).catch(function () {});
    tasks();
  }
  function send() {
    var t = text.value.trim();
    if (!t) return;
    err.textContent = '';
    sendBtn.disabled = true;
    j('/x/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cid: cid, text: t,
        name: document.getElementById('cw-name').value,
        contact: document.getElementById('cw-contact').value
      })
    }).then(function () { text.value = ''; return load(); })
      .catch(function (e) { err.textContent = e.message; })
      .then(function () { sendBtn.disabled = false; });
  }

  document.getElementById('cw-btn').onclick = function () {
    box.hidden = !box.hidden;
    if (!box.hidden) { load(); setTimeout(function () { text.focus(); }, 50); }
  };
  document.getElementById('cw-x').onclick = function () { box.hidden = true; };
  sendBtn.onclick = send;
  text.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  });

  setInterval(ping, 25000);
  setInterval(function () { if (!box.hidden && !document.hidden) load(); }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) ping(); });
  ping();
})();