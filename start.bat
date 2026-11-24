const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function kvGet(key) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/kv?k=eq.' + encodeURIComponent(key), {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
  });
  if (!r.ok) throw new Error('Supabase GET ' + r.status);
  const rows = await r.json();
  return rows.length ? rows[0].v : null;
}

async function kvSet(key, value) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/kv', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([{ k: key, v: value }]),
  });
  if (!r.ok) throw new Error('Supabase POST ' + r.status);
  return value;
}

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://localhost').pathname;

    if (p.startsWith('/api/kv/')) {
      const key = decodeURIComponent(p.slice('/api/kv/'.length));
      if (!key) return send(res, 400, 'no key');
      if (req.method === 'GET') {
        const v = await kvGet(key);
        return send(res, 200, JSON.stringify(v), 'application/json; charset=utf-8');
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req);
        let value;
        try { value = JSON.parse(raw); } catch { value = raw; }
        await kvSet(key, value);
        return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
      }
      return send(res, 405, 'method not allowed');
    }

    const file = p === '/' ? '/index.html' : p;
    const filePath = path.join(__dirname, path.normalize(file));
    if (!filePath.startsWith(__dirname)) return send(res, 403, 'forbidden');
    fs.readFile(filePath, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, data, TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    });
  } catch (e) {
    send(res, 500, 'Server error: ' + e.message);
  }
});

server.listen(PORT, () => console.log('Server running on port ' + PORT));