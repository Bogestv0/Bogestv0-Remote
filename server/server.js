'use strict';
/**
 * Bogestv0 REMOTE — сервер сигнализации.
 *
 * Что делает:
 *  - выдаёт и закрепляет за устройством 9-значный ID (ID ↔ секретный токен устройства);
 *  - знает, кто в сети (presence);
 *  - пересылает служебные сообщения (WebRTC offer/answer/ICE) от одного устройства другому;
 *  - выдаёт временные TURN-реквизиты для relay, когда прямое соединение невозможно.
 *
 * Чего НЕ делает: не видит ни экран, ни ввод, ни звук — они идут напрямую между устройствами
 * (или через TURN) в зашифрованном DTLS-SRTP виде. Пароли сюда не передаются.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8443;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USE_TLS = process.env.TLS !== '0';
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL = 24 * 3600;
const NEW_IDS_PER_HOUR_PER_IP = Number(process.env.NEW_IDS_PER_HOUR) || 30;

const ID_RE = /^\d{9}$/;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- хранилище ID (хэш токена, не сам токен) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const IDS_FILE = path.join(DATA_DIR, 'ids.json');
let ids = {};
try { ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch { ids = {}; }
let saveTimer = null;
function saveIds() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(IDS_FILE + '.tmp', JSON.stringify(ids), (e) => {
      if (!e) fs.rename(IDS_FILE + '.tmp', IDS_FILE, () => {});
    });
  }, 500);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- ограничения ----------
const newIdLog = new Map(); // ip -> [timestamps]
function allowNewId(ip) {
  const now = Date.now();
  const arr = (newIdLog.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= NEW_IDS_PER_HOUR_PER_IP) { newIdLog.set(ip, arr); return false; }
  arr.push(now); newIdLog.set(ip, arr); return true;
}
setInterval(() => { // чистка
  const now = Date.now();
  for (const [ip, arr] of newIdLog) if (!arr.some((t) => now - t < 3600e3)) newIdLog.delete(ip);
}, 600e3).unref();

// ---------- TURN ----------
function iceServers(id) {
  if (!TURN_HOST || !TURN_SECRET) return [{ urls: ['stun:stun.l.google.com:19302'] }];
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${id}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [
    { urls: [`stun:${TURN_HOST}:${TURN_PORT}`] },
    { urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`], username, credential },
  ];
}

// ---------- HTTP(S) + WebSocket ----------
function handler(req, res) {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(404); res.end();
}
let server;
let fingerprint = '';
if (USE_TLS) {
  const cert = fs.readFileSync(path.join(DATA_DIR, 'cert.pem'));
  const key = fs.readFileSync(path.join(DATA_DIR, 'key.pem'));
  fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, handler);
} else {
  server = http.createServer(handler);
}
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
const online = new Map(); // id -> ws

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  ws.ip = ip; ws.id = null; ws.name = ''; ws.alive = true;
  ws.bucket = { tokens: 100, ts: Date.now() };
  const helloTimer = setTimeout(() => { if (!ws.id) ws.terminate(); }, 10000);

  ws.on('pong', () => { ws.alive = true; });
  ws.on('close', (code) => {
    clearTimeout(helloTimer);
    if (ws.id) log('offline', ws.id, ip, 'код', code);
    if (ws.id && online.get(ws.id) === ws) online.delete(ws.id);
  });
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    // token bucket: 40 сообщений/с, всплеск до 100
    const now = Date.now();
    ws.bucket.tokens = Math.min(100, ws.bucket.tokens + ((now - ws.bucket.ts) / 1000) * 40);
    ws.bucket.ts = now;
    if (--ws.bucket.tokens < 0) return ws.close(4008, 'rate');

    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

    switch (m.t) {
      case 'hello': {
        if (ws.id) return;
        const { id, token } = m;
        if (!ID_RE.test(id || '') || typeof token !== 'string' || token.length < 16 || token.length > 128) {
          return send({ t: 'error', code: 'bad-hello' });
        }
        const rec = ids[id];
        if (rec) {
          const a = Buffer.from(rec.h, 'hex'); const b = Buffer.from(sha(token), 'hex');
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send({ t: 'id-taken' });
        } else {
          if (!allowNewId(ip)) return send({ t: 'error', code: 'rate' });
          ids[id] = { h: sha(token), created: Date.now() };
        }
        ids[id].seen = Date.now(); saveIds();
        const prev = online.get(id);
        if (prev && prev !== ws) { log('REPLACED', id, 'старое', prev.ip, '→ новое', ip); prev.id = null; prev.close(4000, 'replaced'); }
        ws.id = id; ws.name = String(m.name || '').slice(0, 64);
        online.set(id, ws);
        clearTimeout(helloTimer);
        log('online', id, ip);
        return send({ t: 'welcome', id, ice: iceServers(id), ttl: TURN_TTL });
      }
      case 'ping': return send({ t: 'pong' });
      default: break;
    }
    if (!ws.id) return; // всё остальное — только после hello

    switch (m.t) {
      case 'ice': return send({ t: 'ice', ice: iceServers(ws.id), ttl: TURN_TTL });
      case 'query': {
        const list = Array.isArray(m.ids) ? m.ids.slice(0, 100) : [];
        return send({ t: 'presence', online: list.filter((x) => ID_RE.test(x) && online.has(x)) });
      }
      case 'signal': {
        if (!ID_RE.test(m.to || '')) return;
        const peer = online.get(m.to);
        const kind = m.data && m.data.k;
        if (!peer || peer.readyState !== 1) { log('signal', kind, ws.id, '→', m.to, 'НЕ ДОСТАВЛЕНО: адресат не в сети'); return send({ t: 'error', code: 'offline', to: m.to }); }
        if (kind !== 'ice') log('signal', kind, ws.id, '→', m.to);
        return peer.send(JSON.stringify({ t: 'signal', from: ws.id, name: ws.name, data: m.data }));
      }
      default: return;
    }
  });
});

const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000);
beat.unref();

server.listen(PORT, () => {
  log(`Bogestv0 REMOTE signaling: ${USE_TLS ? 'wss' : 'ws'}://0.0.0.0:${PORT}`);
  if (fingerprint) log(`FINGERPRINT (SHA-256): ${fingerprint}`);
  if (!TURN_HOST || !TURN_SECRET) log('ВНИМАНИЕ: TURN не настроен (TURN_HOST/TURN_SECRET) — за строгим NAT соединения могут не устанавливаться');
});

module.exports = { server, wss, close: () => { clearInterval(beat); wss.close(); server.close(); } };
