'use strict';
const http = require('http');
const extra = require('./extra.js');

const orig = http.createServer;
http.createServer = function (...args) {
  const i = args.findIndex(a => typeof a === 'function');
  if (i >= 0) {
    const h = args[i];
    const self = this;
    args[i] = function (req, res) {
      let mine = false;
      try { mine = extra.isMine(req); } catch (e) {}
      if (!mine) return h.call(self, req, res);
      extra.handle(req, res, () => h.call(self, req, res)).catch(e => {
        console.error('ОШИБКА ДОПОЛНЕНИЯ', e && e.stack || e);
        try {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"Ошибка сервера"}');
        } catch (_) {}
      });
    };
  }
  return orig.apply(this, args);
};

require('./core.js');