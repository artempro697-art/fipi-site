'use strict';
const http = require('http');
const zlib = require('zlib');
const extra = require('./extra.js');
const assign = require('./assign.js');

function compress(req, res) {
  if (req.method !== 'GET' || !/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return;
  const wh = res.writeHead, we = res.end, ww = res.write;
  let pend = null;
  res.writeHead = function (code, a, b) {
    const h = (a && typeof a === 'object') ? a : (b && typeof b === 'object' ? b : {});
    pend = { code, h };
    return res;
  };
  res.write = function () {
    res.writeHead = wh; res.end = we; res.write = ww;
    if (pend) { const p = pend; pend = null; wh.call(res, p.code, p.h); }
    return ww.apply(res, arguments);
  };
  res.end = function (data, enc, cb) {
    const p = pend; pend = null;
    res.writeHead = wh; res.end = we; res.write = ww;
    if (p) {
      const ct = String(p.h['Content-Type'] || p.h['content-type'] || '');
      const buf = typeof data === 'string' ? Buffer.from(data) : (Buffer.isBuffer(data) ? data : null);
      if (p.code === 200 && buf && buf.length > 1024 && /text|javascript|json/.test(ct)) {
        try {
          const z = zlib.gzipSync(buf);
          const h = Object.assign({}, p.h);
          delete h['Content-Length']; delete h['content-length'];
          h['Content-Encoding'] = 'gzip';
          h['Vary'] = 'Accept-Encoding';
          h['Content-Length'] = z.length;
          wh.call(res, 200, h);
          return we.call(res, z);
        } catch (e) {}
      }
      wh.call(res, p.code, p.h);
    }
    return we.call(res, data, enc, cb);
  };
}

const orig = http.createServer;
http.createServer = function (...args) {
  const i = args.findIndex(a => typeof a === 'function');
  if (i >= 0) {
    const h = args[i];
    const self = this;
    args[i] = function (req, res) {
      try { compress(req, res); } catch (e) {}
      let mod = null;
      try {
        if (assign.isMine(req)) mod = assign;
        else if (extra.isMine(req)) mod = extra;
      } catch (e) {}
      if (!mod) return h.call(self, req, res);
      mod.handle(req, res, () => h.call(self, req, res)).catch(e => {
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