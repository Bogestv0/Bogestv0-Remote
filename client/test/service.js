'use strict';
const assert = require('assert');
const net = require('net');
const { StreamParser, frameHeader } = require('../src/linefmt');
const { createService } = require('../src/service/service-main');
const { run } = require('../src/service/helper-system');
const w32 = require('../src/service/win32');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) размеры структур WinAPI (x64)
assert.deepEqual(w32.sizes(), { STARTUPINFOW: 104, PROCESS_INFORMATION: 24, BITMAPINFOHEADER: 40, BITMAPINFO: 44 });
console.log('ok: размеры структур WinAPI');

// 2) разбор потока: строки и кадры, дробление по байтам
{
  const p = new StreamParser(); const got = []; p.on('line', (m) => got.push(['l', m])); p.on('frame', (h, b) => got.push(['f', h.w, b.length, b[0], b[b.length - 1]]));
  const body = Buffer.alloc(100, 7); body[0] = 1;
  const all = Buffer.concat([Buffer.from('{"ev":"desktop","name":"Winlogon","secure":true}\n'), frameHeader(5, 5, 100), body, Buffer.from('{"ok":1}\n')]);
  for (let i = 0; i < all.length; i += 3) p.feed(all.subarray(i, i + 3));
  assert.equal(got.length, 3); assert.equal(got[0][1].secure, true); assert.deepEqual(got[1], ['f', 5, 100, 1, 7]); assert.equal(got[2][1].ok, 1);
  const bad = new StreamParser(1000); let err = false; bad.on('error', () => (err = true)); bad.feed(frameHeader(1, 1, 5000)); assert(err);
  console.log('ok: разбор кадров/строк, защита от огромного кадра');
}

// 3) служба: согласие, лимиты, чужая сессия
(async () => {
  let t = 100000, consent = true, spawned = [], sessionOf = 1;
  const api = { activeSession: () => 1, sessionOfPid: () => sessionOf, consent: async () => consent, spawnInSession: (o) => { spawned.push(o); return { pid: 99 }; } };
  const svc = createService({ api, exePath: 'C:\\app.exe', helperScript: 'h.js', rand: () => 'T'.repeat(48), now: () => t, pickPort: () => 49500 });
  let r = await svc.startHelper({ from: '123456789', name: 'X' }, 10);
  assert(r.ok && r.token.length === 48 && r.port === 49500 && spawned.length === 1);
  assert.deepEqual(spawned[0].args, ['h.js', '49500', r.token]); assert.equal(spawned[0].session, 1);
  r = await svc.startHelper({}, 10); assert.equal(r.err, 'rate'); assert.equal(spawned.length, 1);
  t += 6000; consent = false; r = await svc.startHelper({}, 10); assert.equal(r.err, 'denied'); assert.equal(spawned.length, 1);
  t += 6000; consent = true; sessionOf = 5; r = await svc.startHelper({}, 10); assert.equal(r.err, 'wrong-session');
  sessionOf = 1; t += 6000; api.consent = () => new Promise((res) => setTimeout(() => res(true), 100));
  const [a, b] = await Promise.all([svc.startHelper({}, 10), svc.startHelper({}, 10)]);
  assert(a.ok && b.err === 'busy');
  console.log('ok: служба — подтверждение обязательно, лимит частоты, чужая сессия, одновременные запросы');

  // 4) helper-system: токен, ввод, кадры при защищённом столе, выход
  const calls = []; let secure = false;
  const desk = { dpiAware() {}, sync: () => ({ name: secure ? 'Winlogon' : 'Default', changed: false }), capture: () => ({ w: 2, h: 2, rgba: Buffer.alloc(16, 9) }) };
  const inj = { available: true, move: (x, y) => calls.push(['m', x, y]), button() {}, wheel() {}, key: (c, d) => calls.push(['k', c, d]), releaseAll: () => calls.push(['rel']) };
  let exited = null; const port = 26000 + Math.floor(Math.random() * 2000);
  const hp = run({ port, token: 'tk', desk, inj, exit: (c) => { exited = c; }, fps: 40 });
  await sleep(150);
  const badS = net.connect(port, '127.0.0.1'); badS.write('{"token":"no"}\n'); await new Promise((r2) => badS.on('close', r2));
  const s = net.connect(port, '127.0.0.1'); const p = new StreamParser(); const ev = []; let frames = 0;
  p.on('line', (m) => ev.push(m)); p.on('frame', () => frames++); s.on('data', (d) => p.feed(d));
  s.write('{"token":"tk"}\n'); await sleep(200);
  assert(ev[0].ok && ev[0].system); assert.equal(frames, 0, 'на обычном столе кадров нет');
  s.write('{"k":"move","x":3,"y":4}\n{"k":"key","code":"KeyA","down":true}\n'); await sleep(100);
  assert.deepEqual(calls.slice(0, 2), [['m', 3, 4], ['k', 'KeyA', true]]);
  secure = true; await sleep(300);
  assert(ev.some((m) => m.ev === 'desktop' && m.secure), 'событие о смене стола'); assert(frames > 2, 'кадры идут на защищённом столе');
  secure = false; await sleep(200); const f0 = frames; await sleep(200); assert.equal(frames, f0, 'после возврата кадры прекращаются');
  s.write('{"k":"capture","on":true}\n'); await sleep(200); assert(frames > f0, 'принудительный захват включается');
  s.destroy(); await sleep(200); assert.equal(exited, 0); hp.stop();
  console.log('ok: helper-system — токен, ввод, кадры только на защищённом столе, выход');
  console.log('\nТЕСТЫ СЛУЖБЫ ПРОЙДЕНЫ'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
