'use strict';
// Проверка логики обновлений без Electron: поток check → скачивание → установка и поведение портативной версии (electron и electron-updater подменены).
const Module = require('module'); const { EventEmitter } = require('events'); const assert = require('assert');
const fakeAU = Object.assign(new EventEmitter(), { calls: [],
  checkForUpdates: async function () { this.emit('update-available', { version: '0.2.0', releaseNotes: 'Новое' }); },
  downloadUpdate: async function () { this.emit('download-progress', { percent: 50 }); this.emit('update-downloaded', {}); },
  quitAndInstall: function (a, b) { this.calls.push([a, b]); } });
const orig = Module._load;
Module._load = function (r, ...a) { if (r === 'electron') return { app: { getVersion: () => '0.1.6', isPackaged: true }, shell: { openExternal: (u) => { global.opened = u; } } }; if (r === 'electron-updater') return { autoUpdater: fakeAU }; return orig.call(this, r, ...a); };
Object.defineProperty(process, 'platform', { value: 'win32' });
const { Updater } = require(require('path').join(__dirname, '../src/updater.js'));
(async () => {
  const u = new Updater(); assert(u.canAuto); u.wire(); const seq = []; u.on('state', (s) => seq.push(s.status)); let inst = 0; u.on('installing', () => inst++);
  await u.check(true); assert.equal(u.state.status, 'available'); assert.equal(u.state.latest, '0.2.0');
  await u.update(); await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(seq, ['checking', 'available', 'downloading', 'downloading', 'ready']);
  assert.equal(inst, 1); assert.deepEqual(fakeAU.calls, [[true, true]]);
  console.log('updater flow ok:', seq.join(' → '));
  // портативная версия: без автоустановки, кнопка открывает страницу
  process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\x'; const p = new Updater(); assert(!p.canAuto); p.set({ status: 'available', latest: '0.2.0' }); await p.update(); assert(/releases\/latest/.test(global.opened)); console.log('portable ok');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
