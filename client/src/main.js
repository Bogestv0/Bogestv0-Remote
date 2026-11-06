'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, desktopCapturer, screen, nativeImage, session, safeStorage, clipboard, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Store } = require('./store');
const { Signaling } = require('./signaling');
const { createInjector } = require('./input');
const { Updater } = require('./updater');
const single = require('./single');

const HIDDEN = process.argv.includes('--hidden');
const R = (f) => path.join(__dirname, 'renderer', f);
const trayIcon = (active) => R(`tray-${active ? 'active' : 'idle'}.${process.platform === 'win32' ? 'ico' : 'png'}`); // .ico — несколько размеров для разных DPI
let win = null, tray = null, quitting = false, sessionActive = false;
let store, sig, injector, updater;
// Сообщения от сервера, пришедшие пока интерфейс ещё грузится (например, сразу после автозапуска), копим и отдаём по готовности.
const pending = { ready: false, queue: [] };
function toRenderer(ch, payload) {
  if (!win || win.isDestroyed()) return;
  if (!pending.ready) { pending.queue.push({ ch, payload, t: Date.now() }); if (pending.queue.length > 100) pending.queue.shift(); return; }
  win.webContents.send(ch, payload);
}
const helper = { sock: null, buf: '' };
let selectedDisplay = null; // id выбранного монитора; null = основной
const currentDisplay = () => screen.getAllDisplays().find((d) => d.id === selectedDisplay) || screen.getPrimaryDisplay();

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => showWindow(null, true));

// ---------------------------------------------------------------- окно / трей
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    show: !HIDDEN, autoHideMenuBar: true, backgroundColor: '#eef0f6',
    title: 'Bogestv0 REMOTE', icon: R('logo.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  // Очередь «пока интерфейс грузится» включаем только при настоящей (не внутристраничной) загрузке окна.
  // Раньше сюда попадала и смена location.hash при переходе на экран подключения: ready сбрасывался и больше не возвращался,
  // поэтому answer и ICE-кандидаты копились в очереди и не доходили до окна зрителя.
  win.webContents.on('did-start-navigation', (...a) => {
    const d = a[0] || {};
    const isMain = typeof d.isMainFrame === 'boolean' ? d.isMainFrame : a[3];
    const same = typeof d.isSameDocument === 'boolean' ? d.isSameDocument : a[2];
    if (isMain && !same) pending.ready = false;
  });
  // Страховка: если какая-то внутристраничная навигация всё же сбросила ready — возвращаем и отдаём накопленное.
  win.webContents.on('did-navigate-in-page', () => {
    if (pending.ready) return;
    pending.ready = true;
    const now = Date.now();
    for (const q of pending.queue.splice(0)) if (now - q.t < 30000) win.webContents.send(q.ch, q.payload);
  });
  // Выход из полного экрана средствами системы (F11, Alt+Enter и т.п.) — сообщаем интерфейсу, чтобы он вернул обычный вид
  win.on('leave-full-screen', () => { if (!win.isDestroyed()) win.webContents.send('win:fs-state', false); });
  win.loadFile(R('index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    // Во время подключения крестик всегда прячет окно в трей: иначе приложение завершилось бы и оборвало сессию
    if (!quitting && (store.data.minimizeToTray || sessionActive)) { e.preventDefault(); win.hide(); }
  });
}
/** raise — повторный запуск пользователем: развернуть из свёрнутого/трея и вывести поверх (обычный focus() Windows может лишь мигнуть в панели задач). */
function showWindow(view, raise) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (raise) { win.setAlwaysOnTop(true); win.show(); win.focus(); win.setAlwaysOnTop(false); }
  else { win.show(); win.focus(); }
  if (view) win.webContents.send('nav', view);
}
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Открыть окно', click: () => showWindow() },
    { label: 'Отключить текущее подключение', enabled: sessionActive, click: () => toRenderer('app:kick', true) },
    { type: 'separator' },
    { label: 'Выйти полностью', click: () => { quitting = true; app.quit(); } },
  ]);
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(trayIcon(false)));
  tray.setToolTip('Bogestv0 REMOTE — в сети');
  tray.setContextMenu(trayMenu());
  tray.on('double-click', () => showWindow());
}
function setTrayActive(active) {
  sessionActive = !!active;
  if (!tray) return;
  tray.setContextMenu(trayMenu());
  tray.setImage(nativeImage.createFromPath(trayIcon(active)));
  tray.setToolTip(active ? 'Bogestv0 REMOTE — идёт подключение' : 'Bogestv0 REMOTE — в сети');
}
const LOGIN_ARGS = ['--hidden'];
const loginPath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
function applyAutostart() {
  if (!app.isPackaged) return; // из исходников не трогаем автозагрузку
  app.setLoginItemSettings({ openAtLogin: !!store.data.autostart, path: loginPath(), args: LOGIN_ARGS });
}
/** Что реально записано в Windows: set — запись в автозагрузке есть; willLaunch — и Windows её не отключил (Диспетчер задач → Автозагрузка). */
function autostartStatus() {
  if (!app.isPackaged || process.platform !== 'win32') return { supported: false };
  try {
    const s = app.getLoginItemSettings({ path: loginPath(), args: LOGIN_ARGS });
    return { supported: true, set: !!s.openAtLogin, willLaunch: s.executableWillLaunchAtLogin !== false };
  } catch { return { supported: true, set: false, willLaunch: false }; }
}

// ---------------------------------------------------------------- администратор (UAC)
function helperSend(o) { if (helper.sock) helper.sock.write(JSON.stringify(o) + '\n'); }
// Общий разбор: подключение к помощнику, кадры и смена стола идут в окно.
const { StreamParser } = require('./linefmt');
function attachHelper(sock, firstBuf, reply) {
  helper.sock = sock;
  const parser = new StreamParser();
  parser.on('line', (m) => { if (m && m.ev === 'desktop') toRenderer('helper:desktop', m); });
  parser.on('frame', (h, body) => toRenderer('helper:frame', { w: h.w, h: h.h, data: body }));
  parser.on('error', () => { try { sock.destroy(); } catch {} });
  sock.removeAllListeners('data');
  sock.setEncoding(null);
  sock.on('data', (d) => parser.feed(d));
  const gone = () => { if (helper.sock === sock) { helper.sock = null; toRenderer('helper:desktop', { name: '', secure: false, gone: true }); } };
  sock.on('close', gone); sock.on('error', gone);
  if (firstBuf && firstBuf.length) parser.feed(firstBuf);
  return { ok: true, injector: reply.injector, system: !!reply.system };
}
function tryConnect(port, token, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0); let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    s.on('connect', () => s.write(JSON.stringify({ token }) + '\n'));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]); const i = buf.indexOf(0x0a);
      if (i < 0) return;
      let reply; try { reply = JSON.parse(buf.subarray(0, i).toString('utf8')); } catch { return fin(null); }
      fin({ s, reply, rest: buf.subarray(i + 1) });
    });
    s.on('error', () => fin(null));
    setTimeout(() => { if (!buf.length) { s.destroy(); fin(null); } }, timeoutMs);
  });
}
// Служба (если установлена): сама покажет системное окно «Да/Нет» и запустит SYSTEM-помощника.
function serviceCall(msg, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const s = net.connect(47931, '127.0.0.1'); let buf = ''; let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify({ ...msg, pid: process.pid }) + '\n'));
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { try { fin(JSON.parse(buf.split('\n')[0])); } catch { fin(null); } } });
    s.on('error', () => fin(null));
    s.setTimeout(timeoutMs, () => fin(null));
  });
}
// silent — «вход по паролю сразу с правами администратора»: служба пропустит своё окно согласия, только если владелец
// ранее подтвердил этот режим на самом компьютере; здесь дополнительно сверяемся с настройкой приложения.
const askService = (meta) => serviceCall({ cmd: 'start-helper', from: meta && meta.from, name: meta && meta.name, silent: !!(meta && meta.silent && store.data.passwordAdmin) });
/** Включить/выключить «молчаливый» админ-режим в службе. Включение службе подтверждает системное окно на компьютере. */
async function serviceSetSilent(on) {
  const st = await serviceStatus();
  if (!st.installed) return { installed: false };
  const r = await serviceCall({ cmd: 'set-silent', on: !!on }, 45000);
  return { installed: true, ok: !!(r && r.ok), err: r && r.err };
}
async function serviceStatus() {
  if (process.platform !== 'win32') return { installed: false };
  return new Promise((resolve) => {
    const s = net.connect(47931, '127.0.0.1'); let buf = ''; let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify({ cmd: 'status' }) + '\n'));
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { try { fin({ installed: !!JSON.parse(buf.split('\n')[0]).service }); } catch { fin({ installed: false }); } } });
    s.on('error', () => fin({ installed: false }));
    setTimeout(() => fin({ installed: false }), 1200);
  });
}
async function startHelper(meta) {
  if (helper.sock) return { ok: true, already: true };
  if (process.platform !== 'win32') return { ok: false, error: 'Повышение прав поддерживается только в Windows' };
  const svc = await askService(meta);
  if (svc && svc.ok) {
    for (let i = 0; i < 40; i++) {                      // помощник стартует за доли секунды
      const res = await tryConnect(svc.port, svc.token);
      if (res && res.reply && res.reply.ok) return attachHelper(res.s, res.rest, res.reply);
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, error: 'Помощник службы не запустился' };
  }
  if (svc && (svc.err === 'denied')) return { ok: false, error: 'Запрос отклонён' };
  if (svc && svc.err && svc.err !== 'bad-cmd') return { ok: false, error: 'Служба: ' + svc.err };
  // службы нет — запасной путь через UAC
  const port = 20000 + crypto.randomInt(0, 30000);
  const token = crypto.randomBytes(24).toString('hex');
  const scriptDir = __dirname.replace('app.asar', 'app.asar.unpacked');
  const script = path.join(scriptDir, 'helper.js');
  const cmdFile = path.join(os.tmpdir(), `bg-elev-${crypto.randomBytes(6).toString('hex')}.cmd`);
  fs.writeFileSync(cmdFile, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}" ${port} ${token}\r\n`);
  const ps = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    `Start-Process -FilePath '${cmdFile.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden`], { windowsHide: true });
  let declined = false;
  ps.on('exit', (code) => { if (code !== 0) declined = true; });
  const cleanup = () => fs.unlink(cmdFile, () => {});
  const deadline = Date.now() + 45000; // время на нажатие «Да» в окне UAC
  while (Date.now() < deadline && !declined) {
    const res = await tryConnect(port, token);
    if (res && res.reply && res.reply.ok) { cleanup(); return attachHelper(res.s, res.rest, res.reply); }
    await new Promise((r) => setTimeout(r, 500));
  }
  cleanup();
  return { ok: false, error: declined ? 'Запрос UAC отклонён' : 'Помощник не запустился за 45 секунд' };
}
function stopHelper() {
  if (helper.sock) { try { helperSend({ k: 'release' }); helper.sock.end(); } catch {} helper.sock = null; }
}

// ---------------------------------------------------------------- ввод
function toPhysical(nx, ny) {
  const d = currentDisplay(); const b = d.bounds;
  const dip = { x: b.x + Math.min(1, Math.max(0, nx)) * (b.width - 1), y: b.y + Math.min(1, Math.max(0, ny)) * (b.height - 1) };
  try { return screen.dipToScreenPoint(dip); } catch { return { x: dip.x * d.scaleFactor, y: dip.y * d.scaleFactor }; }
}
function inject(ev) {
  const viaHelper = !!helper.sock;
  const move = (x, y) => { const p = toPhysical(x, y); viaHelper ? helperSend({ k: 'move', x: p.x, y: p.y }) : injector.move(p.x, p.y); };
  switch (ev.k) {
    case 'mm': return move(ev.x, ev.y);
    case 'md': case 'mu': {
      move(ev.x, ev.y); const down = ev.k === 'md';
      return viaHelper ? helperSend({ k: 'btn', b: ev.b, down }) : injector.button(ev.b, down);
    }
    case 'wh': return viaHelper ? helperSend({ k: 'wheel', dx: ev.dx, dy: ev.dy }) : injector.wheel(ev.dx, ev.dy);
    case 'kd': case 'ku': {
      const down = ev.k === 'kd';
      return viaHelper ? helperSend({ k: 'key', code: ev.code, down }) : injector.key(ev.code, down);
    }
  }
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  // отпечаток показываем только для СВОЕГО сервера; встроенный остаётся скрытым
  const fpView = () => (store.data.customServer ? store.active().fingerprint : '');
  const state = () => ({ ...sig.state, fingerprint: fpView() });
  ipcMain.handle('cfg:get', () => ({
    ...store.publicView(), hostname: os.hostname(), version: app.getVersion(), platform: process.platform,
    injector: injector.available, sig: state(), autostartState: autostartStatus(),
  }));
  ipcMain.handle('cfg:set', async (_e, patch) => {
    const allowed = ['unattended', 'allowedIds', 'autostart', 'minimizeToTray', 'relayOnly', 'devices', 'server', 'name', 'passwordAdmin', 'hideOnConnect', 'customServer'];
    let restart = false; let warn = '';
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      if (k === 'unattended' && patch[k] && !store.data.passwordEnc) return { ok: false, error: 'Сначала задайте пароль' };
      if (k === 'passwordAdmin') {
        const on = patch[k] === true;
        if (on && !store.data.passwordEnc) return { ok: false, error: 'Сначала задайте пароль' };
        if (on !== store.data.passwordAdmin || !on) {
          const r = await serviceSetSilent(on);
          if (on && r.installed && !r.ok) return { ok: false, error: r.err === 'denied' ? 'Режим не включён: подтверждение на компьютере не получено' : 'Служба не смогла включить режим: ' + (r.err || 'нет ответа') };
          if (on && !r.installed) warn = 'Служба не установлена (портативная версия): окно UAC на этом компьютере всё равно придётся подтверждать вручную.';
        }
        store.data.passwordAdmin = on; continue;
      }
      if (k === 'server') {   // адрес СВОЕГО сервера; встроенный через интерфейс не читается и не меняется
        const s = patch.server || {};
        const host = String(s.host || '').trim(); const port = Number(s.port);
        if (!host || !(port > 0 && port < 65536)) return { ok: false, error: 'Неверный адрес или порт сервера' };
        const fp = String(s.fingerprint || '').trim().toUpperCase();
        if (fp && !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fp)) return { ok: false, error: 'Отпечаток: 32 пары hex через двоеточие (SHA-256)' };
        store.data.custom = { host, port, fingerprint: fp }; store.data.customServer = true; restart = true; continue;
      }
      if (k === 'customServer') {
        const on = patch[k] === true;
        if (on && !store.data.custom.host) return { ok: false, error: 'Сначала укажите адрес своего сервера' };
        if (on !== store.data.customServer) { store.data.customServer = on; restart = true; }
        continue;
      }
      if (k === 'allowedIds') { store.data.allowedIds = (patch.allowedIds || []).map(String).filter((x) => /^\d{9}$/.test(x)); continue; }
      if (k === 'devices') {
        store.data.devices = (patch.devices || []).filter((d) => /^\d{9}$/.test(d.id)).map((d) => ({ id: d.id, name: String(d.name || d.id).slice(0, 48) }));
        for (const id of Object.keys(store.data.devicePw)) if (!store.data.devices.some((d) => d.id === id)) delete store.data.devicePw[id];   // убрали устройство — забыли и пароль
        continue;
      }
      store.data[k] = patch[k];
    }
    store.save(); applyAutostart();
    if (restart) sig.restart();
    return { ok: true, warn };
  });
  ipcMain.handle('cfg:setPassword', (_e, pw) => {
    pw = String(pw || '');
    if (pw && pw.length < 8) return { ok: false, error: 'Минимум 8 символов' };
    store.setPassword(pw);
    if (!pw) { store.data.unattended = false; if (store.data.passwordAdmin) { store.data.passwordAdmin = false; serviceSetSilent(false).catch(() => {}); } }
    return { ok: true };
  });
  ipcMain.handle('cfg:getSecret', () => store.getPassword());
  // сохранённые пароли для входа на другие устройства
  const okId = (id) => /^\d{9}$/.test(String(id));
  ipcMain.handle('dev:savePw', (_e, id, pw, admin) => { if (!okId(id) || !pw || String(pw).length > 200) return false; store.setDevicePw(String(id), String(pw), !!admin); return true; });
  ipcMain.handle('dev:getPw', (_e, id) => (okId(id) ? store.getDevicePw(String(id)) : null));
  ipcMain.handle('dev:clearPw', (_e, id) => { if (okId(id)) store.clearDevicePw(String(id)); return true; });
  ipcMain.handle('sig:reconnect', () => { if (!sig.state.connected) sig.restart(); return true; });
  ipcMain.handle('sig:send', (_e, o) => sig.send(o));
  ipcMain.handle('sig:state', () => state());
  ipcMain.handle('sig:ice', () => sig.ice);
  ipcMain.handle('log:add', (_e, entry) => { store.addLog({ who: String(entry.who || '').slice(0, 64), id: String(entry.id || ''), kind: String(entry.kind || ''), note: String(entry.note || '').slice(0, 80) }); return store.data.log; });
  ipcMain.handle('app:attention', (_e, { title, body }) => {
    showWindow('connect');
    if (win) { win.flashFrame(true); setTimeout(() => win && win.flashFrame(false), 4000); }
    if (Notification.isSupported()) new Notification({ title: title || 'Bogestv0 REMOTE', body: body || '', silent: false }).show();
  });
  ipcMain.handle('app:notify', (_e, { title, body }) => { if (Notification.isSupported()) new Notification({ title, body, silent: false }).show(); });
  // новое сообщение чата: если окно скрыто или не в фокусе — системное уведомление (клик открывает сессию) и мигание в панели задач
  ipcMain.handle('app:chatNotify', (_e, { title, body }) => {
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;
    if (win && !win.isDestroyed() && win.isVisible()) { win.flashFrame(true); setTimeout(() => win && !win.isDestroyed() && win.flashFrame(false), 3000); }
    if (Notification.isSupported()) { const n = new Notification({ title: String(title || 'Сообщение'), body: String(body || '').slice(0, 200), silent: false }); n.on('click', () => showWindow('session')); n.show(); }
  });
  ipcMain.handle('app:setActive', (_e, v) => setTrayActive(v));
  ipcMain.handle('app:copy', (_e, t) => clipboard.writeText(t));
  // Ссылка на Telegram-канал автора: открывается в браузере; адрес зашит, из окна его подменить нельзя
  ipcMain.handle('app:openChannel', () => shell.openExternal('https://t.me/bogestv0'));
  ipcMain.handle('screen:list', () => {
    const prim = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id), primary: d.id === prim, w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor),
      label: `Монитор ${i + 1}${d.id === prim ? ' (основной)' : ''} · ${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}`,
    }));
  });
  ipcMain.handle('screen:source', async (_e, displayId) => {
    // без id — основной монитор (начало сессии); с id — выбранный зрителем
    const wanted = displayId ? screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) : null;
    selectedDisplay = wanted ? wanted.id : null;
    const d = currentDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const s = sources.find((x) => x.display_id === String(d.id)) || sources[0];
    if (!s) return null;
    return { id: s.id, displayId: String(d.id), width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  });
  ipcMain.handle('app:readClipboard', () => clipboard.readText().slice(0, 200000));
  ipcMain.on('input:ev', (_e, ev) => { try { inject(ev); } catch (err) { console.error('inject', err); } });
  ipcMain.on('input:release', () => { selectedDisplay = null; try { injector.releaseAll(); helperSend({ k: 'release' }); } catch {} });
  ipcMain.on('win:hide', () => { if (win && !win.isDestroyed()) { win.setFullScreen(false); win.hide(); } });
  ipcMain.on('win:fs', (_e, on) => { if (win && !win.isDestroyed()) win.setFullScreen(!!on); });
  ipcMain.handle('admin:start', (_e, meta) => startHelper(meta));
  ipcMain.handle('service:status', () => serviceStatus());
  ipcMain.on('helper:capture', (_e, on) => helperSend({ k: 'capture', on: !!on }));
  ipcMain.handle('admin:stop', () => { stopHelper(); return true; });

  ipcMain.handle('updater:state', () => updater.state);
  ipcMain.handle('updater:check', () => updater.check(true));
  ipcMain.handle('updater:update', () => updater.update());
  ipcMain.handle('app:ready', () => {
    pending.ready = true;
    const now = Date.now();
    for (const q of pending.queue.splice(0)) if (now - q.t < 30000) win.webContents.send(q.ch, q.payload); // старше 30 с — уже неактуально
  });
  sig.on('state', (s) => toRenderer('sig:state', { ...s, fingerprint: fpView() }));
  sig.on('ice', (ice) => toRenderer('sig:ice', ice));
  sig.on('message', (m) => toRenderer('sig:msg', m));
}

// ---------------------------------------------------------------- запуск
app.whenReady().then(async () => {
  // вторая копия не должна ни открывать окно, ни заводить своё устройство: просим первую показаться и выходим
  if ((await single.claim(() => showWindow(null, true))) === 'running') { app.exit(0); return; }
  store = new Store(app.getPath('userData'), safeStorage);
  if (!store.data.name) store.data.name = os.hostname();
  injector = createInjector((...a) => console.log(...a));
  sig = new Signaling(store);
  updater = new Updater();
  updater.on('state', (s) => toRenderer('updater:state', s));
  updater.on('installing', () => { quitting = true; });

  const ses = session.defaultSession;
  // Только свои страницы (file://) и только нужные права. «fullscreen» нужен для кнопки «во весь экран»:
  // раньше обработчик запрещал всё, кроме media, из-за этого полноэкранный режим молча не включался.
  const ALLOWED = ['media', 'fullscreen', 'pointerLock', 'keyboardLock', 'speaker-selection'];
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(ALLOWED.includes(perm) && wc.getURL().startsWith('file://')));
  ses.setPermissionCheckHandler((wc, perm) => ALLOWED.includes(perm));

  registerIpc();
  createWindow();
  createTray();
  applyAutostart();
  sig.start();
  updater.start();
});
app.on('before-quit', () => { quitting = true; stopHelper(); if (store) store.saveNow(); });
app.on('window-all-closed', () => { if (quitting) app.quit(); });
process.on('uncaughtException', (e) => console.error('uncaught', e));
