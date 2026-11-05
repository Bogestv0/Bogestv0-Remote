'use strict';
// Обновления программы через GitHub Releases.
//  • Установленная версия (Setup, NSIS): electron-updater скачивает и ставит новую версию сам, затем перезапускает приложение.
//  • Портативная версия и запуск не из установки: автозамена файла невозможна, поэтому показываем, что вышла новая версия,
//    и по кнопке открываем страницу загрузки.
// Скачивание начинается только после нажатия кнопки пользователем; проверка (раз в 6 часов) только читает информацию о версии.
const https = require('https');
const { app, shell } = require('electron');
const { EventEmitter } = require('events');
const { cmpVer } = require('./semver');

const REPO = { owner: 'Bogestv0', repo: 'Bogestv0-Remote' };
const PAGE = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest`;
const CHECK_EVERY = 6 * 3600e3;

function fetchLatest() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: 'api.github.com', path: `/repos/${REPO.owner}/${REPO.repo}/releases/latest`,
      headers: { 'User-Agent': 'Bogestv0-REMOTE-updater', Accept: 'application/vnd.github+json' }, timeout: 15000,
    }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(new Error('слишком большой ответ')); });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null); // релизов ещё нет
        if (res.statusCode !== 200) return reject(new Error('GitHub ответил ' + res.statusCode));
        try { const j = JSON.parse(b); resolve({ version: String(j.tag_name || '').replace(/^v/i, ''), notes: String(j.body || '').slice(0, 2000), url: String(j.html_url || PAGE) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
  });
}

class Updater extends EventEmitter {
  constructor() {
    super();
    this.current = app.getVersion();
    this.portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
    // Автоустановка возможна только у установленного (NSIS) приложения под Windows.
    this.canAuto = app.isPackaged && process.platform === 'win32' && !this.portable;
    this.state = { status: 'idle', current: this.current, latest: '', notes: '', percent: 0, error: '', canAuto: this.canAuto, url: PAGE, manual: false };
    this.au = null; this.timer = null; this.busy = false;
  }
  set(p) { this.state = { ...this.state, ...p }; this.emit('state', this.state); }

  start() {
    if (this.canAuto) this.wire();
    setTimeout(() => this.check(false), 30000);          // первая проверка — через 30 секунд после запуска
    this.timer = setInterval(() => this.check(false), CHECK_EVERY); this.timer.unref();
  }
  wire() {
    try {
      const { autoUpdater } = require('electron-updater');
      this.au = autoUpdater;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowPrerelease = false;
      autoUpdater.logger = null;
      autoUpdater.on('update-available', (i) => this.set({ status: 'available', latest: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.slice(0, 2000) : '', error: '' }));
      autoUpdater.on('update-not-available', () => this.set({ status: 'none', latest: this.current, error: '' }));
      autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
      autoUpdater.on('update-downloaded', () => { this.set({ status: 'ready', percent: 100 }); setTimeout(() => this.install(), 800); });
      autoUpdater.on('error', (e) => this.set({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }));
    } catch (e) { this.canAuto = false; this.state.canAuto = false; this.set({ error: 'Автообновление недоступно: ' + (e && e.message) }); }
  }

  /** manual=true — проверку запустил пользователь: «последняя версия» и ошибки показываем явно. */
  async check(manual) {
    if (this.busy || ['downloading', 'ready'].includes(this.state.status)) return this.state;
    this.busy = true; this.set({ status: 'checking', manual: !!manual, error: '' });
    try {
      if (this.au) { await this.au.checkForUpdates(); }
      else {
        const l = await fetchLatest();
        if (l && cmpVer(l.version, this.current) > 0) this.set({ status: 'available', latest: l.version, notes: l.notes, url: l.url });
        else this.set({ status: 'none', latest: this.current });
      }
    } catch (e) { this.set({ status: manual ? 'error' : 'idle', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }); }
    this.busy = false;
    return this.state;
  }
  /** Кнопка «Обновить»: у установленной версии — скачать, поставить и перезапустить; у портативной — открыть страницу загрузки. */
  async update() {
    if (!this.canAuto || !this.au) { shell.openExternal(this.state.url || PAGE); return this.state; }
    if (this.state.status !== 'available') return this.state;
    this.set({ status: 'downloading', percent: 0, error: '' });
    try { await this.au.downloadUpdate(); } catch (e) { this.set({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }); }
    return this.state;
  }
  install() {
    if (!(this.au && this.state.status === 'ready')) return;
    // quitAndInstall сначала закрывает окна; при включённом «сворачивать в трей» закрытие отменялось бы — даём main знать, что это выход.
    this.emit('installing');
    this.au.quitAndInstall(true, true);
  }
}
module.exports = { Updater, fetchLatest, PAGE };
