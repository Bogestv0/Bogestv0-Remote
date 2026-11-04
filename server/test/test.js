'use strict';
// Интеграционный тест сервера: поднимает его на свободном порту и гоняет по протоколу.
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');

const PORT = 18443 + Math.floor(Math.random() * 500);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-srv-'));
const SECRET = 'testsecret';
function start(tls) {
  if (tls) execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ${dir}/key.pem -out ${dir}/cert.pem -days 2 -subj "/CN=t" 2>/dev/null`);
  const p = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dir, TLS: tls ? '1' : '0', TURN_HOST: '1.2.3.4', TURN_SECRET: SECRET },
  });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  return new Promise((res) => { const t = setInterval(() => { if (out.includes('signaling:')) { clearInterval(t); res({ p, get out() { return out; } }); } }, 50); });
}
function client(tls = false) {
  const ws = new WebSocket(`${tls ? 'wss' : 'ws'}://127.0.0.1:${PORT}`, { rejectUnauthorized: false });
  const q = []; let waiter = null;
  ws.on('message', (d) => { const m = JSON.parse(d); if (waiter) { const w = waiter; waiter = null; w(m); } else q.push(m); });
  return {
    ws,
    open: () => new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    next: (ms = 2000) => new Promise((res, rej) => {
      if (q.length) return res(q.shift());
      const t = setTimeout(() => { waiter = null; rej(new Error('timeout')); }, ms);
      waiter = (m) => { clearTimeout(t); res(m); };
    }),
  };
}
const tok = () => crypto.randomBytes(24).toString('hex');

(async () => {
  let s = await start(false);
  const A = client(), B = client();
  await Promise.all([A.open(), B.open()]);
  const tA = tok(), tB = tok();

  A.send({ t: 'signal', to: '222222222', data: {} });            // до hello — игнор
  A.send({ t: 'hello', id: '111111111', token: tA, name: 'PC-A' });
  let m = await A.next(); assert.equal(m.t, 'welcome'); assert.equal(m.id, '111111111');
  // TURN-креды валидны (HMAC-SHA1)
  const turn = m.ice.find((x) => x.username);
  assert.equal(crypto.createHmac('sha1', SECRET).update(turn.username).digest('base64'), turn.credential);
  assert(turn.username.endsWith(':111111111'));
  console.log('ok: hello + TURN creds');

  B.send({ t: 'hello', id: '222222222', token: tB, name: 'PC-B' });
  assert.equal((await B.next()).t, 'welcome');

  // чужой ID с другим токеном — отказ
  const C = client(); await C.open();
  C.send({ t: 'hello', id: '111111111', token: tok() });
  assert.equal((await C.next()).t, 'id-taken');
  console.log('ok: чужой токен не захватывает ID');

  // кривой hello
  const D = client(); await D.open(); D.send({ t: 'hello', id: 'abc', token: 'x' });
  assert.equal((await D.next()).code, 'bad-hello');

  // пересылка сигнала + имя отправителя
  A.send({ t: 'signal', to: '222222222', data: { k: 'offer', sdp: 'x' } });
  m = await B.next(); assert.deepEqual(m, { t: 'signal', from: '111111111', name: 'PC-A', data: { k: 'offer', sdp: 'x' } });
  console.log('ok: signal forwarded, from подставляет сервер (подделать нельзя)');
  B.send({ t: 'signal', to: '111111111', from: '999999999', data: { k: 'answer' } });
  m = await A.next(); assert.equal(m.from, '222222222');

  // офлайн / presence
  A.send({ t: 'signal', to: '333333333', data: {} });
  m = await A.next(); assert.deepEqual(m, { t: 'error', code: 'offline', to: '333333333' });
  A.send({ t: 'query', ids: ['222222222', '333333333', 'zzz'] });
  m = await A.next(); assert.deepEqual(m, { t: 'presence', online: ['222222222'] });
  console.log('ok: offline error + presence');

  // повторный вход с тем же ID вытесняет старое соединение
  const A2 = client(); await A2.open();
  const closed = new Promise((r) => A.ws.on('close', (c) => r(c)));
  A2.send({ t: 'hello', id: '111111111', token: tA });
  assert.equal((await A2.next()).t, 'welcome');
  assert.equal(await closed, 4000);
  console.log('ok: replaced');

  // ID переживает перезапуск
  await new Promise((r) => setTimeout(r, 800));
  s.p.kill(); await new Promise((r) => setTimeout(r, 300));
  s = await start(false);
  const E = client(); await E.open();
  E.send({ t: 'hello', id: '111111111', token: tA }); assert.equal((await E.next()).t, 'welcome');
  const F = client(); await F.open();
  F.send({ t: 'hello', id: '111111111', token: tok() }); assert.equal((await F.next()).t, 'id-taken');
  console.log('ok: persistence');
  s.p.kill(); await new Promise((r) => setTimeout(r, 300));

  // TLS + отпечаток в логе совпадает с реальным сертификатом
  s = await start(true);
  const T = client(true); await T.open();
  const peer = T.ws._socket.getPeerCertificate();
  assert(s.out.includes(peer.fingerprint256), 'отпечаток в логе должен совпасть');
  T.send({ t: 'hello', id: '444444444', token: tok() }); assert.equal((await T.next()).t, 'welcome');
  console.log('ok: TLS, fingerprint =', peer.fingerprint256);
  s.p.kill();
  console.log('\nВСЕ ТЕСТЫ СЕРВЕРА ПРОЙДЕНЫ');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
