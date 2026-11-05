'use strict';
// Настройки устройства в JSON. Пароль хранится зашифрованным (Windows DPAPI через safeStorage).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  id: '', token: '',
  name: '',
  passwordEnc: '',           // зашифрованный пароль для входа без подтверждения
  unattended: false,         // вход по паролю без ручного «Разрешить»
  allowedIds: [],            // пусто = любой ID с верным паролем
  passwordAdmin: false,      // вход по паролю сразу даёт права администратора (без отдельного запроса)
  autostart: true,
  minimizeToTray: true,
  hideOnConnect: true,       // когда к этому компьютеру подключились — убрать окно программы в трей (не мешает на удалённом экране)
  relayOnly: true,           // соединять только через TURN-сервер (устойчиво к разным NAT); можно выключить в «Безопасность»
  server: { host: '46.226.166.141', port: 8443, fingerprint: '' },   // встроенный сервер: в интерфейсе не показывается
  customServer: false,       // true — использовать свой сервер из custom
  custom: { host: '', port: 8443, fingerprint: '' },
  devicePw: {},              // сохранённые пароли для подключения к устройствам: id -> { pw (зашифрован), admin }
  devices: [],               // [{id, name}]
  log: [],                   // журнал подключений
};

class Store {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'config.json');
    this.safe = safeStorage;
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.assign(this.data, saved);
      this.data.server = { ...DEFAULTS.server, ...(saved.server || {}) };
      this.data.custom = { ...DEFAULTS.custom, ...(saved.custom || {}) };
      // Раньше адрес сервера можно было менять в «Безопасность → Сервер»: если он отличается от встроенного — это «свой сервер».
      if (saved.customServer === undefined && saved.server && saved.server.host && saved.server.host !== DEFAULTS.server.host) {
        this.data.customServer = true; this.data.custom = { ...DEFAULTS.custom, ...saved.server }; this.data.server = { ...DEFAULTS.server };
      }
    } catch { /* первый запуск */ }
    if (!/^\d{9}$/.test(this.data.id)) this.newIdentity();
    this.save();
  }
  newIdentity() {
    // 9 цифр, первая не 0
    this.data.id = String(100000000 + crypto.randomInt(0, 900000000));
    this.data.token = crypto.randomBytes(32).toString('hex');
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.saveNow(), 200);
  }
  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('config save failed', e); }
  }
  /** Сервер, с которым приложение работает сейчас: свой (если включён и задан) или встроенный. */
  active() { return this.data.customServer && this.data.custom.host ? this.data.custom : this.data.server; }
  // то, что можно отдавать в интерфейс (без токена, паролей и адреса встроенного сервера)
  publicView() {
    const { token, passwordEnc, server, custom, devicePw, ...rest } = this.data;
    const savedDevices = {}; for (const [id, v] of Object.entries(devicePw || {})) savedDevices[id] = { admin: !!v.admin };
    return { ...rest, hasPassword: !!passwordEnc, savedDevices, custom: { ...custom } };
  }
  _enc(pw) {
    if (this.safe && this.safe.isEncryptionAvailable()) return 'e:' + this.safe.encryptString(pw).toString('base64');
    return 'p:' + Buffer.from(pw, 'utf8').toString('base64');
  }
  _dec(v) {
    if (!v) return '';
    try {
      if (v.startsWith('e:')) return this.safe.decryptString(Buffer.from(v.slice(2), 'base64'));
      if (v.startsWith('p:')) return Buffer.from(v.slice(2), 'base64').toString('utf8');
    } catch { /* повреждено */ }
    return '';
  }
  setPassword(pw) {
    if (!pw) { this.data.passwordEnc = ''; return this.save(); }
    this.data.passwordEnc = this._enc(pw);
    this.save();
  }
  getPassword() { return this._dec(this.data.passwordEnc); }
  // пароли для подключения к чужим устройствам (чтобы не вводить каждый раз)
  setDevicePw(id, pw, admin) { this.data.devicePw[id] = { pw: this._enc(pw), admin: !!admin }; this.save(); }
  getDevicePw(id) { const v = this.data.devicePw[id]; if (!v) return null; const pw = this._dec(v.pw); return pw ? { pw, admin: !!v.admin } : null; }
  clearDevicePw(id) { delete this.data.devicePw[id]; this.save(); }
  addLog(entry) {
    this.data.log.unshift({ ...entry, ts: Date.now() });
    const cutoff = Date.now() - 90 * 86400e3;
    this.data.log = this.data.log.filter((e) => e.ts > cutoff).slice(0, 500);
    this.save();
  }
}
module.exports = { Store, DEFAULTS };
