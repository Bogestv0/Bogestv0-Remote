'use strict';
// E2E: два экземпляра настоящего интерфейса в Chromium + настоящий сервер сигнализации.
// Слой Electron (bridge) подменён; экран и звук — синтетические (canvas + осциллятор).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const WebSocket = require('../../server/node_modules/ws');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs'); const os = require('os'); const path = require('path');

const PORT = 19000 + Math.floor(Math.random() * 500);
const URL_ = 'file://' + path.join(__dirname, '../src/renderer/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000, what = '') => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(100); } };

const INIT = `(() => {
  const L = {}; window.__emit = (ch, ...a) => (L[ch] || []).forEach((f) => f(...a));
  const on = (ch, cb) => { (L[ch] = L[ch] || []).push(cb); return () => {}; };
  const call = (m, ...a) => window.__bridge(m, a);
  window.bridge = {
    cfg: { get: () => call('cfg.get'), set: (p) => call('cfg.set', p), setPassword: (p) => call('cfg.setPassword', p), getSecret: () => call('cfg.getSecret') },
    sig: { reconnect: () => call('sig.reconnect'), send: (o) => call('sig.send', o), state: () => call('sig.state'), ice: () => call('sig.ice'), onMsg: (cb) => on('sig:msg', cb), onState: (cb) => on('sig:state', cb), onIce: (cb) => on('sig:ice', cb) },
    updater: { state: () => call('updater.state'), check: () => call('updater.check'), update: () => call('updater.update'), onState: (cb) => on('updater:state', cb) },
    dev: { savePw: (id, pw, admin) => call('dev.savePw', id, pw, admin), getPw: (id) => call('dev.getPw', id), clearPw: (id) => call('dev.clearPw', id) },
    log: { add: (e) => call('log.add', e) },
    app: { chatNotify: (t, b) => call('app.chatNotify', t, b), readClipboard: () => call('app.readClipboard'), ready: () => call('app.ready'), attention: (t, b) => call('app.attention', t, b), notify: (t, b) => call('app.notify', t, b), setActive: (v) => call('app.setActive', v), copy: (t) => call('app.copy', t), onNavigate: (cb) => on('nav', cb), onKick: (cb) => on('app:kick', cb) },
    screen: { source: (id) => call('screen.source', id), list: () => call('screen.list') },
    input: { send: (ev) => { call('input.send', ev); }, release: () => { call('input.release'); } },
    win: { hide: () => call('win.hide'), setFullScreen: (on) => call('win.fs', on), onFullscreen: (cb) => on('win:fs-state', cb) },
    admin: { start: (m) => call('admin.start', m), stop: () => call('admin.stop'), onDesktop: (cb) => on('helper:desktop', cb), onFrame: (cb) => on('helper:frame', cb), capture: () => {} },
  };
  // синтетический экран (canvas, анимация) + звук (осциллятор)
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360; const g = cv.getContext('2d'); let n = 0;
    setInterval(() => { g.fillStyle = 'hsl(' + (n * 3 % 360) + ',60%,40%)'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText('REMOTE ' + n++, 40, 180); }, 33);
    const s = cv.captureStream(30);
    if (c && c.audio) { const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); d.stream.getAudioTracks().forEach((t) => s.addTrack(t)); }
    return s;
  };
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'm1', label: 'Fake Mic' }, { kind: 'audiooutput', deviceId: 'default', label: 'Def' }];
})();`;

class Peer {
  constructor(browser, name, port) { (global.PEERS = global.PEERS || []).push(this); this.name = name; this.port = port; this.browser = browser; this.id = String(100000000 + crypto.randomInt(0, 899999999)); this.token = crypto.randomBytes(32).toString('hex');
    this.cfg = { id: this.id, name, hostname: name, version: '0.1.0', platform: 'win32', savedDevices: {}, autostartState: { supported: true, set: true, willLaunch: true }, customServer: false, custom: { host: '', port: 8443, fingerprint: '' }, unattended: false, hasPassword: false, allowedIds: [], autostart: false, minimizeToTray: true, server: { host: '127.0.0.1', port, fingerprint: '' }, devices: [], log: [], injector: true };
    this.password = ''; this.inputs = []; this.releases = 0; this.adminStarts = 0; this.adminResult = { ok: true }; this.attention = []; this.notifies = []; this.ice = []; this.sigState = { connected: false, id: this.id, error: '' }; this.sigQueue = []; }
  async start() {
    this.ctx = await this.browser.newContext({ viewport: { width: 1100, height: 800 } });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', (e) => console.log(`[${this.name}] PAGEERROR`, e.message));
    this.page.on('console', (m) => { if (m.type() === 'error') console.log(`[${this.name}] console.error`, m.text()); });
    await this.page.exposeFunction('__bridge', (m, a) => this.handle(m, a));
    await this.page.addInitScript(INIT); await this.page.addInitScript('window.__dbgLog = [];');
    await new Promise((resolve) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', id: this.id, token: this.token, name: this.name })));
      this.ws.on('close', (c, r) => this.tr('WS CLOSE ' + c + ' ' + r)); this.ws.on('error', (e) => this.tr('WS ERROR ' + e.message));
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.t === 'welcome') { this.ice = m.ice; this.sigState = { connected: true, id: this.id, error: '' }; resolve(); }
        else if (m.t === 'pong') {}
        else this.forward(m);
      });
    });
    await this.page.goto(URL_);
    await this.page.waitForSelector('#statusText');
  }
  async reload() { this.ready = false; await this.page.reload(); await this.page.waitForSelector('#statusText'); }
  tr(s) { (this.trace = this.trace || []).push(((Date.now() - (global.T0 || 0)) / 1000).toFixed(2) + ' ' + this.name + ' ' + s); }
  forward(m) { this.tr('RECV(' + (this.ready ? 'deliver' : 'QUEUED') + ') ' + (m.t === 'signal' ? m.data.k : m.t)); if (!this.ready) { this.sigQueue.push(m); return; } this.page.evaluate((m) => window.__emit('sig:msg', m), m).catch(() => {}); }
  async handle(m, a) {
    switch (m) {
      case 'screen.list': return [{ id: '1', primary: true, w: 640, h: 360, label: 'Монитор 1 (основной) · 640×360' }, { id: '2', primary: false, w: 640, h: 360, label: 'Монитор 2 · 640×360' }];
      case 'screen.source': this.screenCalls = [...(this.screenCalls || []), a[0] || null]; return { id: 'fake', displayId: a[0] || '1', width: 640, height: 360 };
      case 'app.readClipboard': return this.clipboard || '';
      case 'app.copy': this.clipboard = a[0]; return;
      case 'app.ready': this.tr('READY (flush ' + this.sigQueue.length + ')'); this.ready = true; for (const q of this.sigQueue.splice(0)) this.forward(q); return;
      case 'cfg.get': return { ...this.cfg, sig: this.sigState };
      case 'cfg.set': Object.assign(this.cfg, a[0]); return { ok: true };
      case 'cfg.setPassword': this.password = a[0]; this.cfg.hasPassword = !!a[0]; return { ok: true };
      case 'cfg.getSecret': return this.password;
      case 'sig.send': this.tr('SEND ' + (a[0].t === 'signal' ? a[0].data.k : a[0].t)); this.ws.send(JSON.stringify(a[0])); return true;
      case 'sig.state': return this.sigState;
      case 'sig.ice': return this.ice;
      case 'log.add': this.cfg.log.unshift({ ...a[0], ts: Date.now() }); return this.cfg.log;
      case 'app.attention': this.attention.push(a); return;
      case 'app.notify': this.notifies.push(a); return;
      case 'input.send': this.inputs.push(a[0]); return;
      case 'input.release': this.releases++; return;
      case 'admin.start': this.adminStarts++; this.adminMeta = a[0]; return this.adminResult;
      case 'admin.stop': return true;
      case 'updater.state': return { status: 'idle', canAuto: false };
      case 'app.chatNotify': (this.chatNotifies = this.chatNotifies || []).push(a); return;
      case 'dev.savePw': this.devPw = this.devPw || {}; this.devPw[a[0]] = { pw: a[1], admin: !!a[2] }; this.cfg.savedDevices = { ...(this.cfg.savedDevices || {}), [a[0]]: { admin: !!a[2] } }; return true;
      case 'dev.getPw': return (this.devPw || {})[a[0]] || null;
      case 'dev.clearPw': if (this.devPw) delete this.devPw[a[0]]; if (this.cfg.savedDevices) delete this.cfg.savedDevices[a[0]]; return true;
      case 'win.hide': this.hides = (this.hides || 0) + 1; return;
      case 'win.fs': this.fsCalls = [...(this.fsCalls || []), !!a[0]]; return;
      default: return;
    }
  }
  S(expr) { return this.page.evaluate(`(() => { const S = window.__S; return ${expr}; })()`); }
  async close() { try { this.ws.close(); } catch {} await this.ctx.close(); }
}

async function uiConnect(v, host, { mode, password, admin }) {
  await v.page.evaluate(() => (location.hash = 'devices'));
  await until(() => v.page.$(`[data-action=connect][data-id="${host.id}"]:not([disabled])`), 15000, 'кнопка подключения активна (presence)');
  await v.page.click(`[data-action=connect][data-id="${host.id}"]`);
  await v.page.click(`.radio-card[data-mode=${mode}]`);
  if (password) await v.page.fill('#mPw', password);
  if (admin) await v.page.check('#mAdmin');
  await v.page.click('.modal [data-ok]');
}
const pcInfo = (p) => p.evaluate(() => { const s = window.__sess; const f = (x) => x && x.pc ? { conn: x.pc.connectionState, ice: x.pc.iceConnectionState, gather: x.pc.iceGatheringState, sig: x.pc.signalingState, ctl: x.ctl && x.ctl.readyState, remoteSet: x.remoteSet, sdpSent: x.sdpSent, pending: x.pendingIce.length, outQ: (x.outIceQ || []).length } : null; return JSON.stringify({ in: f(s.incoming), out: f(s.outgoing) }); });
const diag = async (H, V) => `PC host=${await pcInfo(H.page)} viewer=${await pcInfo(V.page)} :: host: inSess=${JSON.stringify(await H.S('S.inSess && S.inSess.state'))} prompts=${await H.S('S.prompts.length')} | viewer: out=${JSON.stringify(await V.S('S.out && S.out.state'))} toasts=${await V.page.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join('|'))}`;
const outEnded = async (v, reason) => { let last = '';
  try { await until(async () => { const t = await v.page.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join('|')); last = t + ' | out=' + JSON.stringify(await v.S('S.out && S.out.state')); return t.includes(reason) && !(await v.S('!!S.out')); }, 20000, 'viewer завершил: ' + reason); }
  catch (e) { const H = v.peerRef && v.peerRef.H; throw new Error(e.message + ' — на экране: ' + last + ' :: ' + (H ? await diag(H, v) : '') + '\nDBG host:\n' + (H ? (await H.page.evaluate(() => window.__dbgLog.slice(-14))).join('\n') : '') + '\nDBG viewer:\n' + (await v.page.evaluate(() => window.__dbgLog.slice(-14))).join('\n') + '\nTRACE:\n' + [...(H ? H.trace || [] : []), ...(v.trace || [])].filter((l) => !/ice$/.test(l)).sort((a, b) => parseFloat(a) - parseFloat(b)).slice(-22).join('\n')); } };

(async () => {
  global.T0 = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-e2e-'));
  const srv = global.SRV = spawn('node', [path.join(__dirname, '../../server/server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, TLS: '0' } });
  await until(() => new Promise((r) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}`); w.on('open', () => { w.close(); r(true); }); w.on('error', () => r(false)); }), 8000, 'server up');

  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
  const H = new Peer(browser, 'Рабочий ПК', PORT), V = new Peer(browser, 'MacBook', PORT);
  await H.start(); await V.start();
  V.peerRef = { H }; V.cfg.devices = [{ id: H.id, name: 'Рабочий ПК' }];
  await V.reload();
  const PW = 'correct-horse-1';
  H.password = PW; H.cfg.hasPassword = true; H.cfg.unattended = true;
  await H.reload();
  let ok = (s) => console.log('ok:', s);

  // ---- 1. UI: статусы и presence
  assert((await V.page.textContent('#statusText')).includes('В сети'));
  ok('верхняя панель показывает «В сети · ID»');

  // ---- 2. неверный пароль
  await uiConnect(V, H, { mode: 'password', password: 'wrong-password' });
  await outEnded(V, 'Неверный пароль');
  await until(async () => !(await H.S('!!S.inSess')), 5000, 'host закрыл неудавшуюся сессию'); assert.equal(H.inputs.length, 0);
  assert(!H.cfg.log.some((e) => e.kind === 'password'), 'сессия не должна стать активной');
  assert(H.cfg.log.some((e) => e.kind === 'bad-password'));
  ok('неверный пароль отклонён, на хосте запись в журнале');

  // ---- 3. верный пароль → видео, звук, ввод
  await uiConnect(V, H, { mode: 'password', password: PW });
  await until(async () => (await V.S("S.out && S.out.state === 'active'")), 25000, 'viewer active');
  await until(() => V.page.evaluate(() => { const v = document.querySelector('#stageWrap video'); return v && v.videoWidth > 0 && v.currentTime > 0; }), 20000, 'видео идёт');
  const dims = await V.page.evaluate(() => { const v = document.querySelector('#stageWrap video'); return [v.videoWidth, v.videoHeight]; });
  assert.deepEqual(dims, [640, 360]);
  ok('вход по паролю без подтверждения: видео ' + dims.join('×') + ' идёт');
  assert.equal(await H.S("S.inSess && S.inSess.mode"), 'password');
  assert(H.notifies.some((n) => n[1].includes('MacBook')), 'host обязан показать уведомление и при входе по паролю');
  ok('хост показал уведомление о подключении (даже без подтверждения)');
  await until(() => (H.hides || 0) >= 1, 4000, 'окно хоста спрятано в трей');
  ok('пункт 5: при подключении окно программы на хосте само уходит в трей');
  const audioFlowing = await until(() => V.page.evaluate(() => { const a = document.getElementById('aSpk'); return a.srcObject && a.srcObject.getAudioTracks().length === 1; }), 8000, 'аудио-трек');
  ok('аудио-трек динамиков получен');
  assert((await V.S("S.out.info.mics.length")) === 1); ok('список микрофонов хоста передан');

  // ввод
  const box = await V.page.locator('#stageWrap video').boundingBox();
  await V.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await V.page.mouse.down(); await V.page.mouse.up();
  await V.page.keyboard.down('KeyA'); await V.page.keyboard.up('KeyA');
  await V.page.mouse.wheel(0, 120);
  await until(() => ['mm', 'md', 'mu', 'kd', 'ku', 'wh'].every((k) => H.inputs.some((e) => e.k === k)), 8000, 'события ввода на хосте');
  const md = H.inputs.find((e) => e.k === 'md');
  assert(Math.abs(md.x - 0.5) < 0.03 && Math.abs(md.y - 0.5) < 0.03, 'нормированные координаты по центру: ' + JSON.stringify(md));
  assert(H.inputs.find((e) => e.k === 'kd').code === 'KeyA');
  ok('мышь/клавиатура/колесо дошли до хоста, координаты нормированы (' + md.x.toFixed(2) + ',' + md.y.toFixed(2) + ')');

  // режим «только просмотр»
  await V.page.click('[data-action=t-control]'); const n0 = H.inputs.length;
  await V.page.mouse.move(box.x + 10, box.y + 10); await V.page.mouse.down(); await V.page.mouse.up(); await sleep(400);
  assert.equal(H.inputs.length, n0); await V.page.click('[data-action=t-control]');
  ok('режим «только просмотр» не отправляет ввод');

  // пункт 2: экран сессии занимает почти всё окно (окно теста 1100×800)
  const sb = await V.page.locator('#stageWrap').boundingBox();
  assert(sb.width > 1050 && sb.height > 480, 'экран сессии слишком маленький: ' + Math.round(sb.width) + '×' + Math.round(sb.height));
  { const sh = path.join(__dirname, 'shots'); fs.mkdirSync(sh, { recursive: true }); await V.page.screenshot({ path: path.join(sh, 'viewer-session.png') }); }
  ok('экран сессии большой: ' + Math.round(sb.width) + '×' + Math.round(sb.height) + ' (раньше ≤ 934×' + Math.round(0.68 * 800) + ')');

  // пункт 3: «во весь экран» — окно Electron уходит в fullscreen, окно сессии растягивается на всё окно, выход кнопкой и по Esc
  await V.page.click('[data-action=t-full]');
  await until(() => (V.fsCalls || []).at(-1) === true, 3000, 'окно переведено в полный экран');
  const fb = await V.page.locator('#stage').boundingBox();
  assert(fb.x === 0 && fb.y === 0 && fb.width >= 1099 && fb.height >= 799, 'stage должен занять всё окно: ' + JSON.stringify(fb));
  await sleep(1500); // перерисовки (статистика, presence) не должны выкидывать из полного экрана
  assert(await V.page.evaluate(() => document.body.classList.contains('stage-full') && !!document.querySelector('#stage video, #stageWrap video')));
  assert.equal(await V.page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).display), 'none');
  await V.page.click('[data-action=t-full]');
  await until(() => (V.fsCalls || []).at(-1) === false, 3000, 'выход из полного экрана кнопкой');
  assert(!(await V.page.evaluate(() => document.body.classList.contains('stage-full'))));
  await V.page.click('[data-action=t-full]'); await until(() => V.fsCalls.at(-1) === true, 3000, 'снова в полный экран');
  await V.page.click('[data-action=t-control]'); await V.page.keyboard.press('Escape'); // без управления Esc выходит из полного экрана
  await until(() => V.fsCalls.at(-1) === false, 3000, 'выход по Esc');
  await V.page.click('[data-action=t-control]');
  ok('кнопка «во весь экран»: входит, остаётся при перерисовках, выходит кнопкой и по Esc (при управлении Esc уходит на удалённый ПК)');

  // пункт 6: свой курсор над удалённым экраном виден по умолчанию, кнопка скрывает/показывает
  const cur = () => V.page.evaluate(() => getComputedStyle(document.querySelector('#stageWrap video')).cursor);
  assert.equal(await cur(), 'default');
  await V.page.click('[data-action=t-cursor]'); assert.equal(await cur(), 'none');
  assert.equal(await V.page.evaluate(() => localStorage.getItem('bg.localCursor')), '0');   // выбор запоминается
  await V.page.click('[data-action=t-cursor]'); assert.equal(await cur(), 'default');
  ok('пункт 6: курсор над экраном виден по умолчанию, кнопка скрывает/показывает его, выбор запоминается');
  // быстрый поток движений мыши: последнее положение обязательно доходит до хоста
  { const bx = await V.page.locator('#stageWrap video').boundingBox(); const n0 = H.inputs.length;
    for (let i = 0; i <= 40; i++) await V.page.mouse.move(bx.x + 100 + i * 5, bx.y + 100 + i * 2);
    await until(() => { const m = H.inputs.filter((e) => e.k === 'mm'); const l = m[m.length - 1]; return l && H.inputs.length - n0 >= 3 && Math.abs(l.y - ((bx.y + 180 - (bx.y + (bx.height - Math.min(bx.width / 640, bx.height / 360) * 360) / 2)) / (Math.min(bx.width / 640, bx.height / 360) * 360))) < 0.02; }, 4000, 'последнее положение мыши дошло до хоста');
    ok('быстрое движение мыши: отправлено ' + (H.inputs.length - n0) + ' событий, последнее положение дошло'); }

  // пункт 12: звук реально идёт (байты аудио приходят), стерео/128 кбит/с запрошены в SDP, ползунок громкости работает
  const audioBytes = () => V.page.evaluate(async () => { const rep = await window.__sess.outgoing.pc.getStats(); let b = 0; rep.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') b += r.bytesReceived || 0; }); return b; });
  const ab0 = await audioBytes(); await sleep(1200);
  assert((await audioBytes()) > ab0 + 500, 'звук динамиков должен реально приходить (байты аудио растут)');
  assert(await V.page.evaluate(() => window.__sess.outgoing.offerSdp.includes('stereo=1') && window.__sess.outgoing.offerSdp.includes('maxaveragebitrate=128000')), 'в SDP зрителя должны быть параметры качественного Opus');
  assert(await H.page.evaluate(() => window.__sess.incoming.offerSdp.includes('stereo=1')));
  await V.page.evaluate(() => (location.hash = 'audio')); await until(() => V.page.$('[data-vol=spk]'), 3000, 'ползунок громкости');
  await V.page.locator('[data-vol=spk]').evaluate((el) => { el.value = '35'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(Math.round((await V.page.evaluate(() => document.getElementById('aSpk').volume)) * 100), 35);
  // выбор источника звука: любое устройство ввода хоста и обратно — весь системный звук
  const hostSrc = () => H.page.evaluate(() => { const s = window.__sess.incoming; return { live: s.spkTrack.readyState === 'live', sent: s.sSender.track === s.spkTrack, id: s.spkTrack.id }; });
  const id0 = (await hostSrc()).id;
  assert.deepEqual(await V.page.$$eval('#spkSrc option', (o) => o.map((x) => x.value)), ['system', 'm1']);
  await V.page.selectOption('#spkSrc', 'm1');
  await until(async () => (await V.S("S.out.spkSrc")) === 'm1' && (await hostSrc()).id !== id0, 6000, 'источник звука переключён на устройство');
  assert.deepEqual({ ...(await hostSrc()), id: 0 }, { live: true, sent: true, id: 0 });
  const ab1 = await audioBytes(); await sleep(1200); assert((await audioBytes()) > ab1 + 500, 'звук с выбранного устройства должен идти');
  assert(H.cfg.log.some((e) => e.kind === 'audio'), 'смена источника звука попала в журнал хоста');
  await V.page.evaluate(() => (location.hash = 'audio')); await until(() => V.page.$eval('#spkSrc', (el) => el.value === 'm1'), 3000, 'выбранный источник остаётся выбранным');
  await V.page.selectOption('#spkSrc', 'system');
  await until(async () => (await V.S("S.out.spkSrc")) === 'system', 6000, 'обратно на системный звук');
  const ab2 = await audioBytes(); await sleep(1200); assert((await audioBytes()) > ab2 + 500, 'системный звук снова идёт');
  await V.page.click('[data-action=a-refresh-dev]'); await sleep(300);
  await V.page.evaluate(() => (location.hash = 'session'));
  ok('пункт 12: источник звука выбирается (системный / любое устройство ввода хоста), звук идёт с выбранного, смена — в журнале хоста');
  ok('пункт 12: звук идёт (байты растут), Opus стерео 128 кбит/с запрошен, ползунок громкости меняет громкость');

  // пункт 7: чат в обе стороны
  await V.page.click('[data-action=t-chat]');
  assert(await V.page.locator('#stage .chat').isVisible(), 'панель чата открывается справа');
  const cb = await V.page.locator('#stage .chat').boundingBox(); const wb = await V.page.locator('#stageWrap').boundingBox();
  assert(cb.x > wb.x, 'чат справа от экрана');
  await V.page.fill('#chatIn-out', 'привет с MacBook'); await V.page.press('#chatIn-out', 'Enter');
  await until(() => H.page.evaluate(() => [...document.querySelectorAll('#chatLog-in .chat-bubble')].some((b) => b.textContent === 'привет с MacBook')), 6000, 'сообщение зрителя дошло до хоста');
  await H.page.evaluate(() => (location.hash = 'session'));
  await H.page.fill('#chatIn-in', 'ответ хоста'); await H.page.press('#chatIn-in', 'Enter');
  await until(() => V.page.evaluate(() => [...document.querySelectorAll('#chatLog-out .chat-bubble')].some((b) => b.textContent === 'ответ хоста')), 6000, 'ответ хоста дошёл до зрителя');
  { const sh = path.join(__dirname, 'shots'); fs.mkdirSync(sh, { recursive: true }); await V.page.screenshot({ path: path.join(sh, 'viewer-chat.png') }); await H.page.screenshot({ path: path.join(sh, 'host-chat.png') }); }
  // текст в поле ввода переживает перерисовку окна сессии и скрипты в сообщениях не исполняются
  await V.page.fill('#chatIn-out', 'черновик');
  await V.page.evaluate(() => window.__emit('sig:msg', { t: 'noop' })); await V.page.click('[data-action=t-control]'); await V.page.click('[data-action=t-control]');
  assert.equal(await V.page.inputValue('#chatIn-out'), 'черновик');
  await V.page.fill('#chatIn-out', '<img src=x onerror=window.__xss=1>'); await V.page.press('#chatIn-out', 'Enter'); await sleep(300);
  assert.equal(await H.page.evaluate(() => window.__xss), undefined); assert.equal(await V.page.evaluate(() => window.__xss), undefined);
  await V.page.fill('#chatIn-out', ''); await V.page.click('[data-action=t-chat]');
  ok('пункт 7: чат справа, сообщения идут в обе стороны, черновик не пропадает, HTML в сообщениях не исполняется');

  // микрофон
  await V.page.click('[data-action=t-mic]');
  await until(async () => V.S("S.out.mic === true"), 5000, 'mic on');
  await until(() => H.page.evaluate(() => !!window.__sess.incoming.micTrack), 8000, 'host mic track');
  ok('включение микрофона хоста работает');

  // выбор монитора
  assert((await V.page.$$('#monSel option')).length === 2);
  await V.page.selectOption('#monSel', '2');
  await until(async () => V.S("S.out.info.monitor === '2'"), 10000, 'монитор переключён');
  assert(H.screenCalls.includes('2'), 'хост должен был захватить монитор 2: ' + JSON.stringify(H.screenCalls));
  const t1 = await V.page.evaluate(() => document.querySelector('#stageWrap video').currentTime); await sleep(700);
  assert(await V.page.evaluate((t1) => document.querySelector('#stageWrap video').currentTime > t1, t1), 'видео должно продолжать идти после смены монитора');
  ok('выбор монитора: переключение на лету, видео продолжает идти');

  // буфер обмена (явные кнопки, хост получает уведомление)
  V.clipboard = 'привет из буфера зрителя'; const nBefore = H.notifies.length;
  await V.page.click('[data-action=t-clip-send]');
  await until(() => H.clipboard === 'привет из буфера зрителя', 6000, 'буфер хоста записан');
  await until(() => H.notifies.length > nBefore && H.notifies.at(-1)[1].includes('записал текст'), 4000, 'уведомление о записи в буфер');
  H.clipboard = 'секрет хоста'; await V.page.click('[data-action=t-clip-get]');
  await until(() => V.clipboard === 'секрет хоста', 6000, 'буфер зрителя получен');
  await until(() => H.notifies.at(-1)[1].includes('прочитал текст'), 4000, 'уведомление о чтении буфера');
  await until(() => H.cfg.log.filter((e) => e.kind === 'clip').length === 2, 4000, 'две записи журнала о буфере');
  ok('буфер обмена: отправка и получение работают, хост уведомлён и в журнале 2 записи');

  // статистика
  await until(async () => V.S("S.out.stats && S.out.stats.fps > 0"), 8000, 'stats');
  ok('статистика: ' + JSON.stringify(await V.S("({fps:S.out.stats.fps, rtt:S.out.stats.rtt, route:S.out.stats.route})")));

  // ---- 4. занято
  const V2 = new Peer(browser, 'Third', PORT); await V2.start(); V2.cfg.devices = [{ id: H.id, name: 'Рабочий ПК' }]; await V2.reload();
  await uiConnect(V2, H, { mode: 'password', password: PW });
  await outEnded(V2, 'занято');
  ok('второй зритель получает «занято»'); await V2.close();

  // ---- 5. завершение со стороны зрителя
  await V.page.evaluate(() => (location.hash = 'session'));
  await V.page.click('.session-banner [data-action=hangup]');
  await until(async () => !(await H.S('!!S.inSess')), 8000, 'host закрыл сессию');
  assert(H.releases > 0); ok('hangup: хост закрыл сессию и отпустил зажатые клавиши');
  assert(H.cfg.log.some((e) => e.kind === 'ended'));

  // ---- 6. ask: отклонить, потом разрешить
  await uiConnect(V, H, { mode: 'ask' });
  await until(async () => (await H.S('S.prompts.length')) === 1, 15000, 'prompt на хосте');
  assert(H.attention.length > 0); assert((await H.page.textContent('#badge')) === '1');
  assert((await H.page.textContent('.prompt-name')).includes('MacBook'));
  ok('запрос с подтверждением: окно «Разрешить/Отклонить» на хосте, бейдж=1, окно выведено вперёд');
  await H.page.click('[data-action=deny]'); await outEnded(V, 'отклонено');
  ok('«Отклонить» → у зрителя «отклонено»');
  await sleep(500);
  await uiConnect(V, H, { mode: 'ask' });
  await until(async () => (await H.S('S.prompts.length')) === 1, 15000, 'prompt 2').catch(async (e) => { throw new Error(e.message + ' :: ' + await diag(H, V)); });
  await H.page.click('[data-action=allow]');
  await until(async () => V.S("S.out && S.out.state === 'active'"), 20000, 'ask → active');
  ok('«Разрешить» → сессия активна');
  await V.page.evaluate(() => window.__sess.hangup()); await until(async () => !(await H.S('!!S.inSess')), 8000, 'closed');

  // ---- 7. админ-доступ: отдельный запрос
  await sleep(500);
  await uiConnect(V, H, { mode: 'ask', admin: true });
  await until(async () => (await H.S('S.prompts.length')) === 1, 15000, 'prompt connect+admin').catch(async (e) => { throw new Error(e.message + ' :: ' + await diag(H, V)); });
  assert((await H.page.textContent('.scope-list')).includes('отдельное подтверждение'));
  await H.page.click('[data-action=allow]');
  await until(async () => (await H.S("S.prompts.length === 1 && S.prompts[0].kind === 'admin'")), 15000, 'второй, админский запрос');
  assert((await H.page.textContent('.prompt-name')).includes('просит права администратора'));
  assert.equal(H.adminStarts, 0, 'до подтверждения повышение не запускается');
  ok('админ-доступ = ОТДЕЛЬНЫЙ второй запрос после обычного «Разрешить»');
  H.adminResult = { ok: true, system: true };
  await H.page.click('[data-action=allow]');
  await until(async () => V.S('S.out && S.out.admin === true'), 15000, 'admin granted');
  assert.equal(H.adminStarts, 1); ok('после «Разрешить» запущен помощник (UAC) и зритель получил админ-доступ');
  // защищённый рабочий стол: подмена видеотрека на canvas с кадрами помощника и возврат обратно
  const trk = () => H.page.evaluate(() => { const s = window.__sess.incoming; return { sec: !!(s.secure && s.secure.on), isSecTrack: !!(s.secure && s.vSender.track === s.secure.track), isCap: !!(s.cap && s.vSender.track === s.cap.video) }; });
  assert.deepEqual(await trk(), { sec: false, isSecTrack: false, isCap: true });
  await H.page.evaluate(() => { window.__emit('helper:desktop', { name: 'Winlogon', secure: true }); });
  await until(async () => (await trk()).isSecTrack, 5000, 'трек подменён на защищённый стол');
  await H.page.evaluate(() => { const w = 4, h = 2; window.__emit('helper:frame', { w, h, data: new Uint8Array(w * h * 4).fill(200) }); });
  assert.equal((await H.page.evaluate(() => { const c = window.__sess.incoming.secure.canvas; return c.width + 'x' + c.height; })), '4x2');
  await H.page.evaluate(() => { window.__emit('helper:desktop', { name: 'Default', secure: false }); });
  await until(async () => (await trk()).isCap, 5000, 'возврат на обычный захват');
  ok('защищённый стол: видеотрек подменяется кадрами помощника и возвращается на обычный захват');
  H.adminResult = { ok: true };
  await V.page.evaluate(() => window.__sess.hangup()); await until(async () => !(await H.S('!!S.inSess')), 8000, 'closed');

  // повышение даже при входе по паролю — всё равно спрашивает
  await sleep(500);
  await uiConnect(V, H, { mode: 'password', password: PW, admin: true });
  await until(async () => (await H.S("S.prompts.length === 1 && S.prompts[0].kind === 'admin'")), 25000, 'admin prompt при входе по паролю');
  assert.equal(H.adminStarts, 1);
  ok('даже при входе по паролю права администратора требуют явного «Разрешить»');
  await H.page.click('[data-action=deny]');
  await until(async () => V.S("S.out && S.out.adminPending === false && S.out.admin === false"), 10000, 'admin denied');
  assert.equal(H.adminStarts, 1); ok('отказ в админ-доступе: сессия продолжается, повышения нет');
  await V.page.evaluate(() => window.__sess.hangup()); await until(async () => !(await H.S('!!S.inSess')), 8000, 'closed');

  // пункт 1: «вход по паролю сразу с правами администратора» — без запроса на хосте
  await sleep(500);
  H.cfg.passwordAdmin = true; await H.reload(); await sleep(800);
  const as0 = H.adminStarts; H.adminResult = { ok: true };
  await uiConnect(V, H, { mode: 'password', password: PW });          // галочку «админ» зритель НЕ ставит
  await until(async () => V.S('S.out && S.out.admin === true'), 25000, 'admin выдан автоматически');
  assert.equal(await H.S('S.prompts.length'), 0, 'запроса на хосте быть не должно');
  assert.equal(H.adminStarts, as0 + 1); assert.equal(H.adminMeta.silent, true, 'в main должен уйти признак silent');
  assert(H.cfg.log.some((e) => e.note && e.note.includes('автоматически')));
  ok('вход по паролю при включённой галочке: права администратора выданы сразу, без запроса, в журнале пометка');
  await H.page.evaluate(() => window.__emit('app:kick', true));   // «Отключить текущее подключение» из меню трея
  await until(async () => !(await H.S('!!S.inSess')), 8000, 'сессия отключена из трея');
  ok('меню трея: «Отключить текущее подключение» завершает сессию');
  // вход «с подтверждением» (не по паролю) по-прежнему просит отдельно, даже при включённой галочке
  await sleep(500);
  await uiConnect(V, H, { mode: 'ask', admin: true });
  await until(async () => (await H.S('S.prompts.length')) === 1, 15000, 'prompt ask+admin'); await H.page.click('[data-action=allow]');
  await until(async () => (await H.S("S.prompts.length === 1 && S.prompts[0].kind === 'admin'")), 15000, 'админ-запрос при входе «с подтверждением»');
  ok('режим «с подтверждением» при включённой галочке всё равно спрашивает админ-доступ отдельно');
  await H.page.click('[data-action=deny]'); await V.page.evaluate(() => window.__sess.hangup()); await until(async () => !(await H.S('!!S.inSess')), 8000, 'closed');
  H.cfg.passwordAdmin = false; await H.reload(); await sleep(800);

  // ---- 8. список разрешённых
  H.cfg.allowedIds = ['999999999']; await H.reload();
  await sleep(800);
  await uiConnect(V, H, { mode: 'password', password: PW });
  await outEnded(V, 'выключен вход по паролю');
  ok('ID вне списка разрешённых не может войти по паролю');
  H.cfg.allowedIds = []; await H.reload(); await sleep(800);

  // ---- 9. блокировка после 5 неверных паролей
  for (let i = 0; i < 5; i++) { await uiConnect(V, H, { mode: 'password', password: 'bad-' + i }); await outEnded(V, 'Неверный пароль'); await V.page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove())); await sleep(300); }
  await uiConnect(V, H, { mode: 'password', password: PW });
  await outEnded(V, 'Слишком много');
  ok('после 5 неверных паролей ID блокируется на 10 минут (даже с верным паролем)');

  // ---- пункт 12: состояние автозапуска из Windows показывается в «Безопасность»
  { await V.page.evaluate(() => { window.__S.cfg.autostart = true; location.hash = 'security'; }); await sleep(300);
    assert((await V.page.textContent('#view-security')).includes('запись в автозагрузке Windows есть'));
    await V.page.evaluate(() => { window.__S.cfg.autostartState = { supported: true, set: true, willLaunch: false }; window.__S.cfg.autostart = true; location.hash = 'devices'; location.hash = 'security'; }); await sleep(300);
    assert((await V.page.textContent('#view-security')).includes('Windows отключил автозапуск'));
    ok('пункт 12: автозапуск — реальное состояние из Windows (в т.ч. «отключён в Диспетчере задач») видно в настройках'); }

  // ---- пункт 10: кнопка «Обновить» перепроверяет, кто в сети
  await V.page.evaluate(() => (location.hash = 'devices'));
  await until(() => V.page.$('[data-action=refresh]'), 4000, 'кнопка Обновить');
  const at0 = await V.S('S.presenceAt'); await sleep(50);
  await V.page.click('[data-action=refresh]');
  await until(async () => (await V.S('S.presenceAt')) > at0 && !(await V.S('S.refreshing')), 6000, 'presence обновлён по кнопке');
  ok('пункт 10: «Обновить» заново проверяет, какие устройства в сети');

  // ---- пункт 9: сохранение пароля и вход одной кнопкой
  { const Vs = new Peer(browser, 'Saver', PORT); await Vs.start(); Vs.cfg.devices = [{ id: H.id, name: 'Рабочий ПК' }]; await Vs.reload();
    const cardBtn = `[data-action=connect][data-id="${H.id}"]:not([disabled])`;
    await until(() => Vs.page.$(cardBtn), 15000, 'кнопка подключения');
    await Vs.page.click(cardBtn); await Vs.page.click('.radio-card[data-mode=password]'); await Vs.page.fill('#mPw', PW);
    assert.equal(await Vs.page.isChecked('#mRemember'), false); await Vs.page.check('#mRemember'); await Vs.page.click('.modal [data-ok]');
    await until(async () => Vs.S("S.out && S.out.state === 'active'"), 25000, 'вход с сохранением пароля');
    assert.equal(Vs.devPw[H.id].pw, PW);
    await Vs.page.evaluate(() => window.__sess.hangup()); await until(async () => !(await H.S('!!S.inSess')), 8000, 'host закрыл'); await sleep(500);
    // второй раз: одна кнопка, без диалога
    await Vs.page.evaluate(() => (location.hash = 'devices'));
    await until(() => Vs.page.$(cardBtn), 15000, 'кнопка подключения (2)');
    assert((await Vs.page.textContent('.device-meta')).length > 0);
    await Vs.page.click(cardBtn);
    await until(async () => Vs.S("S.out && S.out.state === 'active'"), 25000, 'вход по сохранённому паролю без диалога');
    assert.equal(await Vs.page.locator('.modal').count(), 0, 'диалога быть не должно');
    ok('пункт 9: пароль сохранён, повторное подключение — одной кнопкой, без диалога и ввода пароля');
    await Vs.page.evaluate(() => window.__sess.hangup()); await until(async () => !(await H.S('!!S.inSess')), 8000, 'host закрыл (2)'); await sleep(500);
    // хозяин сменил пароль → сохранённый не подходит: забывается и открывается диалог
    H.password = 'completely-new-pass-7';
    await Vs.page.evaluate(() => (location.hash = 'devices'));
    await until(() => Vs.page.$(cardBtn), 15000, 'кнопка подключения (3)'); await Vs.page.click(cardBtn);
    await until(() => Vs.page.$('.modal .edgebar'), 25000, 'диалог после неверного сохранённого пароля');
    assert(!Vs.devPw[H.id], 'устаревший пароль должен быть забыт');
    ok('если сохранённый пароль устарел — он забывается и открывается диалог для нового');
    await Vs.close(); H.password = PW; }

  // ---- скриншоты интерфейса
  const shots = path.join(__dirname, 'shots'); fs.mkdirSync(shots, { recursive: true });
  for (const v of ['devices', 'security', 'audio', 'session', 'connect']) { await H.page.evaluate((v) => (location.hash = v), v); await sleep(300); await H.page.screenshot({ path: path.join(shots, v + '.png') }); }

  await H.close(); await V.close(); await browser.close(); srv.kill();
  console.log('\nВСЕ E2E-ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(0);
})().catch(async (e) => {
  console.error('\nFAIL:', e.message.split('\n')[0]); try { global.SRV.kill(); } catch {}
  for (const p of global.PEERS || []) { try { console.error('--- DBG ' + p.name + ':\n' + (await p.page.evaluate(() => window.__dbgLog.slice(-16))).join('\n') + '\n--- PC ' + await pcInfo(p.page)); console.error('--- TRACE ' + p.name + ':\n' + (p.trace || []).filter((l) => !/ice$/.test(l)).slice(-14).join('\n')); } catch {} }
  process.exit(1);
});
