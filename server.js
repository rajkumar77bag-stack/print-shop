#!/usr/bin/env node
/**
 * Lupte Computer - server
 *
 * Serves the customer site (index.html) and the admin panel (admin.html) and
 * stores orders, PAN / certificate applications, uploaded files and floor notes
 * on the server, so the admin sees what customers submit from ANY device.
 *
 * Your HTML files are not modified on disk. The server injects a small sync
 * script into each page when it is served.
 *
 * Run:   node server.js          (Node 18+, no npm install needed)
 *
 * Env:   PORT=3000  ADMIN_PASSWORD=...  DATA_DIR=./data  MAX_UPLOAD_MB=25
 *        TRUST_PROXY=1  (set when running behind nginx / Cloudflare)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- config
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public'); // optional: images, etc.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024;
const MAX_JSON = 8 * 1024 * 1024;
const TRUST_PROXY = !!process.env.TRUST_PROXY;

fs.mkdirSync(FILES_DIR, { recursive: true });

// Find the HTML files next to this script (index.html / admin.html, or e.g. index (1).html)
function findHtml(exact, pattern) {
  const names = fs.readdirSync(ROOT);
  const hit = names.includes(exact) ? exact : names.find(n => pattern.test(n));
  return hit ? path.join(ROOT, hit) : null;
}
const INDEX_FILE = findHtml('index.html', /^index.*\.html$/i);
const ADMIN_FILE = findHtml('admin.html', /^admin.*\.html$/i);

// Admin password: env var, else a random one saved to data/admin-password.txt
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
let passwordSource = 'ADMIN_PASSWORD env var';
if (!ADMIN_PASSWORD) {
  const f = path.join(DATA_DIR, 'admin-password.txt');
  try { ADMIN_PASSWORD = fs.readFileSync(f, 'utf8').trim(); passwordSource = f; }
  catch {
    ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(f, ADMIN_PASSWORD + '\n', { mode: 0o600 });
    passwordSource = f + ' (generated)';
  }
}

// ---------------------------------------------------------------- database (JSON file)
// localStorage key used by the pages -> [collection, id field]
const KEYS = {
  pe_orders_v2: ['orders', 'id'],
  pe_pan_apps_v1: ['pan', 'ref'],
  pe_cert_apps_v1: ['cert', 'ref'],
};
const ID_FIELD = { orders: 'id', pan: 'ref', cert: 'ref' };
const ORDER_STATUSES = ['New', 'In Printing', 'Ready', 'Completed'];

let db = { rev: 1, notes: '', orders: [], pan: [], cert: [], files: {}, tomb: { orders: {}, pan: {}, cert: {} } };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* first run */ }

let saving = Promise.resolve();
function persist() {
  saving = saving.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db));
    await fsp.rename(tmp, DB_FILE);
  }).catch(e => console.error('Could not save database:', e));
}
function touch() { db.rev++; persist(); }
const snapshot = () => ({ orders: db.orders, pan: db.pan, cert: db.cert, notes: db.notes, rev: db.rev, now: Date.now() });

// ---------------------------------------------------------------- input cleaning
// Customer data ends up inside the admin page's HTML, so strip characters that can
// break out of HTML attributes / tags and insist on safe-looking ids.
const SAFE_KEY = /^[A-Za-z0-9_-]{1,40}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const SAFE_FILE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const DATA_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]*$/;

function clean(v, depth = 0, key = '') {
  if (typeof v === 'string') {
    if (key === 'thumbnail') return v.length < 600000 && DATA_IMG.test(v) ? v : '';
    return v.slice(0, 5000).replace(/[<>"`\\]/g, '');
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean' || v === null) return v;
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => clean(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (SAFE_KEY.test(k)) o[k] = clean(x, depth + 1, k);
    return o;
  }
  return null;
}

function validRecord(col, rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (!SAFE_ID.test(String(rec[ID_FIELD[col]] || ''))) return false;
  const nested = [...Object.values(rec.docs || {}), ...(rec.files || [])];
  return nested.every(n => !n || !n.id || SAFE_FILE_ID.test(String(n.id)));
}

// Customers can only ADD new records. They can never edit or delete existing ones.
function submit(col, items) {
  const idKey = ID_FIELD[col];
  const seen = new Set(db[col].map(x => x[idKey]));
  let added = 0;
  if (db[col].length > 50000) return 0;
  for (const raw of items.slice(0, 300)) {
    const rec = clean(raw);
    if (!validRecord(col, rec)) continue;
    const id = rec[idKey];
    if (seen.has(id) || db.tomb[col][id]) continue;
    if (col === 'orders') { if (!ORDER_STATUSES.includes(rec.status)) rec.status = 'New'; }
    else rec.status = 'Received';
    rec._rcv = Date.now();
    db[col].unshift(rec);
    seen.add(id);
    added++;
  }
  if (added) touch();
  return added;
}

// Admin sends the full list it is looking at. Records the admin has not seen yet
// (received after `syncedAt`) are kept; records the admin removed are deleted.
function adminReplace(col, items, syncedAt) {
  const idKey = ID_FIELD[col];
  const incoming = [];
  const ids = new Set();
  for (const raw of items.slice(0, 50000)) {
    const rec = clean(raw);
    if (!validRecord(col, rec) || ids.has(rec[idKey])) continue;
    ids.add(rec[idKey]);
    incoming.push(rec);
  }
  const keep = [];
  for (const old of db[col]) {
    if (ids.has(old[idKey])) continue;
    if ((old._rcv || 0) > syncedAt) keep.push(old);
    else db.tomb[col][old[idKey]] = Date.now();
  }
  db[col] = [...keep, ...incoming].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  touch();
}

// ---------------------------------------------------------------- browser scripts
// These two functions are NOT run by the server. Their source is injected into the
// pages. They must not reference anything outside themselves.

function customerShim() {
  const MAP = { pe_orders_v2: 1, pe_pan_apps_v1: 1, pe_cert_apps_v1: 1 };
  const rawSet = Storage.prototype.setItem;
  const timers = {};
  const post = (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  // Whenever the page saves orders / applications locally, send new ones to the server.
  function send(key, attempt) {
    const raw = localStorage.getItem(key);
    if (!raw || raw === '[]') return;
    post('/api/submit/' + key, raw)
      .then(r => { if (r.status >= 500 || r.status === 429) throw new Error('retry'); })
      .catch(() => { if (attempt < 5) setTimeout(() => send(key, attempt + 1), 4000 * (attempt + 1)); });
  }
  Storage.prototype.setItem = function (k, v) {
    const r = rawSet.apply(this, arguments);
    if (this === window.localStorage && MAP[k]) {
      clearTimeout(timers[k]);
      timers[k] = setTimeout(() => send(k, 0), 400);
    }
    return r;
  };
  window.addEventListener('load', () => Object.keys(MAP).forEach(k => send(k, 0)));

  window.addEventListener('DOMContentLoaded', () => {
    // 1. Upload every file the customer attaches (print files and application documents)
    if (typeof saveFileBlob === 'function') {
      const orig = saveFileBlob;
      window.saveFileBlob = async function (id, file) {
        await orig.apply(this, arguments);
        for (let i = 0; i < 3; i++) {
          try {
            const r = await fetch('/api/files/' + encodeURIComponent(id), {
              method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
            });
            if (r.ok) return;
            if (r.status === 413) break;
          } catch (e) { /* retry */ }
          await new Promise(s => setTimeout(s, 1500 * (i + 1)));
        }
        if (typeof showToast === 'function') {
          showToast('Could not send "' + (file.name || 'file') + '" to the shop. Check the file size and your connection.');
        }
      };
    }

    // 2. "Check status" lookups work from any device: fetch the record by reference + mobile
    const val = id => ((document.getElementById(id) || {}).value || '').trim();
    const pull = async (kind, ref, mobile, list, save) => {
      if (!ref || !mobile) return;
      try {
        const r = await post('/api/lookup', { kind, ref, mobile });
        if (!r.ok) return;
        const { item } = await r.json();
        if (!item) return;
        const i = list.findIndex(x => x.ref === item.ref);
        if (i < 0) list.unshift(item); else Object.assign(list[i], item);
        save();
      } catch (e) { /* offline: fall back to local data */ }
    };
    if (typeof lookupPanStatus === 'function') {
      const orig = lookupPanStatus;
      window.lookupPanStatus = async function () {
        await pull('pan', val('panLookupRef').toUpperCase(), val('panLookupMobile'), panApps, savePanApps);
        return orig.apply(this, arguments);
      };
    }
    if (typeof lookupCertStatus === 'function') {
      const orig = lookupCertStatus;
      window.lookupCertStatus = async function (svc) {
        await pull('cert', val(svc + '_lookupRef').toUpperCase(), val(svc + '_lookupMobile'), certApps, saveCertApps);
        return orig.apply(this, arguments);
      };
    }

    // 3. Pick up status changes made by the shop for this customer's own records
    async function refreshStatuses() {
      try {
        const body = {
          orders: (state.orders || []).map(o => o.id),
          pan: (panApps || []).map(a => a.ref),
          cert: (certApps || []).map(a => a.ref),
        };
        if (!body.orders.length && !body.pan.length && !body.cert.length) return;
        const r = await post('/api/status', body);
        if (!r.ok) return;
        const s = await r.json();
        let changed = false;
        const apply = (list, map, key) => (list || []).forEach(x => {
          const st = map && map[x[key]];
          if (st && st !== x.status) { x.status = st; changed = true; }
        });
        apply(state.orders, s.orders, 'id');
        apply(panApps, s.pan, 'ref');
        apply(certApps, s.cert, 'ref');
        if (state.activeTrackingOrder && s.orders && s.orders[state.activeTrackingOrder.id]) {
          state.activeTrackingOrder.status = s.orders[state.activeTrackingOrder.id];
        }
        if (changed) { saveState(); savePanApps(); saveCertApps(); }
      } catch (e) { /* ignore */ }
    }
    setTimeout(refreshStatuses, 1500);
    setInterval(refreshStatuses, 15000);
  });
}

function adminShim(SEED) {
  const K = { orders: 'pe_orders_v2', pan: 'pe_pan_apps_v1', cert: 'pe_cert_apps_v1' };
  const COL = { pe_orders_v2: 'orders', pe_pan_apps_v1: 'pan', pe_cert_apps_v1: 'cert' };
  const rawSet = Storage.prototype.setItem;
  const set = (k, v) => rawSet.call(localStorage, k, v);
  const S = { rev: SEED.rev, at: SEED.now, dirty: {}, flight: {}, held: null };
  const timers = {};

  // One-time import of anything this browser stored locally before the server existed
  try {
    if (!localStorage.getItem('pe_server_migrated')) {
      Object.values(K).forEach(k => {
        const v = localStorage.getItem(k);
        if (v && v.length > 2) {
          fetch('/api/submit/' + k, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: v }).catch(() => {});
        }
      });
      set('pe_server_migrated', '1');
    }
  } catch (e) { /* ignore */ }

  // Seed the page's storage from the server BEFORE the page's own code runs
  Object.keys(K).forEach(c => set(K[c], JSON.stringify(SEED[c])));
  set('pe_floor_notes', SEED.notes || '');

  const inDetail = () => { try { return state.currentView === 'admin-detail'; } catch (e) { return false; } };
  const busy = () => Object.keys(S.dirty).length > 0 || Object.keys(S.flight).length > 0;
  const differs = d => Object.keys(K).some(c => localStorage.getItem(K[c]) !== JSON.stringify(d[c]));

  function applyRemote(d) {
    S.held = null; S.rev = d.rev; S.at = d.now;
    if (!differs(d)) return;
    Object.keys(K).forEach(c => set(K[c], JSON.stringify(d[c])));
    window.dispatchEvent(new Event('storage')); // the admin page re-reads storage and re-renders
  }
  // Never swap data under the admin while they are editing / viewing an order
  function tryApply(d) {
    if (d.rev < S.rev) return;
    if (inDetail() || busy()) { S.held = d; return; }
    applyRemote(d);
  }

  function push(c) {
    if (S.flight[c]) { S.dirty[c] = 1; return; }
    delete S.dirty[c];
    let data;
    try { data = JSON.parse(localStorage.getItem(K[c]) || '[]'); } catch (e) { return; }
    S.flight[c] = 1;
    fetch('/api/admin/state/' + c, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, syncedAt: S.at }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed'); return r.json(); })
      .then(res => { delete S.flight[c]; if (S.dirty[c]) push(c); else tryApply(res); })
      .catch(() => { delete S.flight[c]; S.dirty[c] = 1; setTimeout(() => push(c), 5000); });
  }
  function pushNotes() {
    fetch('/api/admin/state/notes', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: localStorage.getItem('pe_floor_notes') || '' }),
    }).catch(() => {});
  }

  Storage.prototype.setItem = function (k, v) {
    const r = rawSet.apply(this, arguments);
    if (this === window.localStorage) {
      const c = COL[k];
      if (c) { S.dirty[c] = 1; clearTimeout(timers[c]); timers[c] = setTimeout(() => push(c), 350); }
      else if (k === 'pe_floor_notes') { clearTimeout(timers.n); timers.n = setTimeout(pushNotes, 600); }
    }
    return r;
  };

  function poll() {
    if (document.hidden) return;
    if (S.held && !inDetail() && !busy()) { applyRemote(S.held); return; }
    if (busy()) return;
    fetch('/api/admin/state?since=' + S.rev)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && !d.unchanged) tryApply(d); })
      .catch(() => {});
  }
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', poll);

  // Customer documents live on the server, not in this browser
  window.addEventListener('DOMContentLoaded', () => {
    if (typeof getFileBlob !== 'function') return;
    const orig = getFileBlob;
    window.getFileBlob = async function (id) {
      const local = await orig.apply(this, arguments);
      if (local) return local;
      try {
        const r = await fetch('/api/admin/files/' + encodeURIComponent(id));
        if (r.ok) { const b = await r.blob(); fileStore[id] = b; return b; }
      } catch (e) { /* ignore */ }
      return null;
    };
  });
}

// ---------------------------------------------------------------- http helpers
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, over = false;
    req.on('data', c => { n += c.length; if (n > limit) over = true; else chunks.push(c); });
    req.on('end', () => over ? reject(httpErr(413, 'Request too large')) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpErr(400, 'Invalid JSON'); }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = req.headers['x-forwarded-for'];
    if (f) return String(f).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Tiny in-memory rate limiter
const hits = new Map();
function limited(ip, bucket, max) {
  const k = bucket + '|' + ip, now = Date.now();
  const h = (hits.get(k) || []).filter(t => now - t < 60000);
  h.push(now);
  hits.set(k, h);
  return h.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (!h.length || now - h[h.length - 1] > 60000) hits.delete(k);
}, 60000).unref();

// Admin auth: HTTP Basic (any username, password = ADMIN_PASSWORD)
const sha = s => crypto.createHash('sha256').update(s).digest();
function requireAdmin(req, res, ip) {
  if (limited(ip, 'auth-fail-check', 600)) throw httpErr(429, 'Too many requests');
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
    if (crypto.timingSafeEqual(sha(pass), sha(ADMIN_PASSWORD))) return true;
    if (limited(ip, 'auth-bad', 10)) throw httpErr(429, 'Too many failed attempts. Try again in a minute.');
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Lupte Admin", charset="UTF-8"', 'Content-Type': 'text/plain' });
  res.end('Admin login required');
  return false;
}

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

async function sendPage(res, file, shim, args) {
  if (!file) throw httpErr(500, 'HTML file not found. Put index.html and admin.html next to server.js.');
  let html = await fsp.readFile(file, 'utf8');
  const script = '<script>(' + shim.toString() + ')(' +
    args.map(a => JSON.stringify(a).replace(/</g, '\\u003c')).join(',') + ');</script>';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + script) : script + html;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { throw httpErr(400, 'Bad URL'); } }

// ---------------------------------------------------------------- routes
async function route(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const m = req.method;
  const ip = clientIp(req);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  // Block cross-site writes (admin uses cached Basic auth, so this matters)
  if (m !== 'GET' && m !== 'HEAD' && req.headers.origin) {
    let host = '';
    try { host = new URL(req.headers.origin).host; } catch { /* ignore */ }
    if (host !== req.headers.host) throw httpErr(403, 'Cross-origin request blocked');
  }

  if (p === '/healthz') return json(res, 200, { ok: true });

  // ----- pages
  if (m === 'GET' && (p === '/' || p === '/index.html')) return sendPage(res, INDEX_FILE, customerShim, []);
  if (m === 'GET' && (p === '/admin' || p === '/admin/' || p === '/admin.html')) {
    if (!requireAdmin(req, res, ip)) return;
    return sendPage(res, ADMIN_FILE, adminShim, [snapshot()]);
  }

  // ----- public API (customers)
  if (m === 'POST' && p.startsWith('/api/submit/')) {
    const def = KEYS[p.slice('/api/submit/'.length)];
    if (!def) throw httpErr(404, 'Unknown key');
    if (limited(ip, 'submit', 60)) throw httpErr(429, 'Too many requests');
    const items = await readJson(req, MAX_JSON);
    if (!Array.isArray(items)) throw httpErr(400, 'Expected an array');
    return json(res, 200, { ok: true, added: submit(def[0], items) });
  }

  if (m === 'POST' && p === '/api/status') {
    if (limited(ip, 'status', 30)) throw httpErr(429, 'Too many requests');
    const b = await readJson(req, 200000);
    const out = { orders: {}, pan: {}, cert: {} };
    for (const col of Object.keys(out)) {
      const want = new Set((Array.isArray(b[col]) ? b[col] : []).slice(0, 300).map(String));
      for (const rec of db[col]) if (want.has(rec[ID_FIELD[col]])) out[col][rec[ID_FIELD[col]]] = rec.status;
    }
    return json(res, 200, out);
  }

  // Look up one application by reference + mobile number (both must match)
  if (m === 'POST' && p === '/api/lookup') {
    if (limited(ip, 'lookup', 20)) throw httpErr(429, 'Too many lookups. Try again in a minute.');
    const b = await readJson(req, 10000);
    const col = b.kind === 'pan' ? 'pan' : b.kind === 'cert' ? 'cert' : null;
    if (!col) throw httpErr(400, 'Bad kind');
    const rec = db[col].find(x => x.ref === String(b.ref || '').toUpperCase() && x.mobile === String(b.mobile || ''));
    if (!rec) return json(res, 200, { item: null });
    const { _rcv, ...item } = rec;
    return json(res, 200, { item });
  }

  if (m === 'PUT' && p.startsWith('/api/files/')) {
    const id = safeDecode(p.slice('/api/files/'.length));
    if (!SAFE_FILE_ID.test(id)) throw httpErr(400, 'Bad file id');
    if (limited(ip, 'upload', 60)) throw httpErr(429, 'Too many uploads');
    if ((+req.headers['content-length'] || 0) > MAX_UPLOAD) {
      res.setHeader('Connection', 'close');
      throw httpErr(413, `File too large (max ${MAX_UPLOAD / 1048576} MB)`);
    }
    if (db.files[id]) { req.resume(); return json(res, 200, { ok: true, existed: true }); } // never overwrite
    const buf = await readBody(req, MAX_UPLOAD);
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    await fsp.writeFile(path.join(FILES_DIR, id), buf);
    db.files[id] = { type: ALLOWED_TYPES.has(ct) ? ct : 'application/octet-stream', size: buf.length, at: Date.now() };
    persist();
    return json(res, 200, { ok: true });
  }

  // ----- admin API
  if (p.startsWith('/api/admin/')) {
    if (!requireAdmin(req, res, ip)) return;

    if (m === 'GET' && p === '/api/admin/state') {
      const since = +new URL(req.url, 'http://x').searchParams.get('since');
      if (since === db.rev) return json(res, 200, { unchanged: true });
      return json(res, 200, snapshot());
    }

    if (m === 'PUT' && p.startsWith('/api/admin/state/')) {
      const col = p.slice('/api/admin/state/'.length);
      const b = await readJson(req, MAX_JSON);
      if (col === 'notes') {
        db.notes = String(b.data || '').slice(0, 100000);
        persist();
        return json(res, 200, { ok: true });
      }
      if (!ID_FIELD[col]) throw httpErr(404, 'Unknown collection');
      if (!Array.isArray(b.data)) throw httpErr(400, 'Expected data array');
      adminReplace(col, b.data, +b.syncedAt || 0);
      return json(res, 200, snapshot());
    }

    if (m === 'GET' && p.startsWith('/api/admin/files/')) {
      const id = safeDecode(p.slice('/api/admin/files/'.length));
      const meta = SAFE_FILE_ID.test(id) && db.files[id];
      if (!meta) throw httpErr(404, 'File not found');
      res.writeHead(200, {
        'Content-Type': meta.type, 'Content-Length': meta.size,
        'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline',
      });
      return fs.createReadStream(path.join(FILES_DIR, id)).on('error', () => res.destroy()).pipe(res);
    }
    throw httpErr(404, 'Not found');
  }

  if (p.startsWith('/api/')) throw httpErr(404, 'Not found');

  // ----- optional static files from ./public
  if (m === 'GET' && fs.existsSync(PUBLIC_DIR)) {
    const f = path.join(PUBLIC_DIR, path.normalize(safeDecode(p)));
    if (f.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      return fs.createReadStream(f).pipe(res);
    }
  }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  throw httpErr(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  try { await route(req, res); }
  catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('\nLupte Computer server is running\n');
  console.log(`  Customer site : http://localhost:${PORT}/`);
  console.log(`  Admin panel   : http://localhost:${PORT}/admin   (any username)`);
  console.log(`  Admin password: ${ADMIN_PASSWORD}   [from ${passwordSource}]`);
  console.log(`  Data folder   : ${DATA_DIR}`);
  if (!INDEX_FILE) console.log('\n  ! index.html not found next to server.js');
  if (!ADMIN_FILE) console.log('\n  ! admin.html not found next to server.js');
  console.log('');
});

function shutdown() {
  console.log('\nSaving and shutting down...');
  server.close();
  saving.finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
