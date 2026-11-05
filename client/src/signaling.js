'use strict';
// Соединение с сервером сигнализации (живёт в main-процессе, чтобы закреплять сертификат).
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const os = require('os');

class Signaling extends EventEmitter {
  /** @param {Store} store */
  constructor(store) {
    super();
    this.store = store;
    this.ws = null;
    this.state = { connected: false, id: store.data.id, error: '' };
    this.ice = [];
    this.stopped = false;
    this.retry = 0;
    this.timers = [];
  }
  start() { this.stopped = false; this.connect(); }
  restart() { this.stop(); this.start(); }
  stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout); this.timers = [];
    if (this.ws) { try { this.ws.terminate(); } catch {} this.ws = null; }
    this.setState({ connected: false });
  }
  diag(text) { this.emit('message', { t: 'diag', text }); }
  setState(p) { this.state = { ...this.state, ...p }; this.emit('state', this.state); }

  connect() {
    const { host, port } = this.store.active();
    const url = `wss://${host}:${port}`;
    let ws;
    try {
      // Сертификат самоподписанный: вместо цепочки доверия сверяем закреплённый отпечаток.
      ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 10000 });
    } catch (e) { return this.scheduleRetry(String(e.message || e)); }
    this.ws = ws;

    ws.on('open', () => {
      const cert = ws._socket && ws._socket.getPeerCertificate && ws._socket.getPeerCertificate();
      const fp = cert && cert.fingerprint256;
      const pinned = this.store.active().fingerprint;
      if (!fp) { ws.terminate(); return this.setState({ connected: false, error: 'Сервер не предъявил сертификат' }); }
      if (pinned && pinned.toUpperCase() !== fp.toUpperCase()) {
        ws.terminate();
        this.setState({ connected: false, error: 'Отпечаток сертификата сервера не совпал — соединение заблокировано' });
        this.stopped = true; // не долбимся, пока пользователь не сменит отпечаток
        return;
      }
      if (!pinned) { // доверие при первом подключении (TOFU)
        this.store.active().fingerprint = fp; this.store.save();
        this.emit('fingerprint-learned', fp);
      }
      this.diag('сокет открыт, отправляю hello');
      this.hello();
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      let m; try { m = JSON.parse(text); } catch (e) { this.diag('recv: НЕ РАЗОБРАН JSON, длина ' + text.length + ': ' + (e && e.message)); return; }
      // Журнал приёма на уровне сокета: если здесь строка есть, а в журнале сессии нет `sig<-` — сообщение потеряно между сокетом и окном.
      if (m.t === 'signal') { const k = m.data && m.data.k; if (k !== 'ice') this.diag('recv signal ' + k + ' от ' + m.from + ' длина ' + text.length); else this.iceRx = (this.iceRx || 0) + 1; }
      else if (m.t !== 'pong') this.diag('recv ' + m.t + ' длина ' + text.length);
      switch (m.t) {
        case 'welcome':
          this.diag('welcome, ID ' + m.id);
          this.retry = 0; this.ice = m.ice || [];
          this.setState({ connected: true, id: m.id, error: '' });
          this.emit('ice', this.ice);
          this.timers.push(setTimeout(() => this.send({ t: 'ice' }), Math.max(60, (m.ttl || 86400) / 2) * 1000));
          this.keepalive();
          break;
        case 'id-taken': // ID занят чужим токеном — берём новый (в т.ч. если сервер переустановили)
          this.store.newIdentity(); this.store.save();
          this.hello();
          break;
        case 'ice': this.ice = m.ice || []; this.emit('ice', this.ice); break;
        case 'pong': this.pongAt = Date.now(); break;
        default: this.emit('message', m);
      }
    });
    ws.on('close', (code, reason) => {
      this.diag('сокет закрыт код=' + code + (reason && reason.length ? ' причина=' + reason.toString() : '') + (code === 4000 ? ' (ID занят другим экземпляром приложения!)' : ''));
      if (this.ws === ws) { this.ws = null; this.setState({ connected: false }); this.scheduleRetry(); }
    });
    ws.on('error', (e) => { this.diag('ошибка сокета: ' + (e && (e.code || e.message))); this.setState({ connected: false, error: this.explain(e) }); });
  }
  explain(e) {
    const c = e && e.code;
    if (c === 'ECONNREFUSED') return 'Сервер отклоняет подключение (порт закрыт или сервер не запущен)';
    if (c === 'ETIMEDOUT' || /timeout/i.test(String(e && e.message))) return 'Сервер не отвечает (таймаут) — проверьте файрвол';
    if (c === 'ENOTFOUND') return 'Адрес сервера не найден';
    return String((e && e.message) || e);
  }
  hello() {
    this.send({ t: 'hello', id: this.store.data.id, token: this.store.data.token, name: this.store.data.name || os.hostname() });
  }
  keepalive() {
    // Раньше pong не проверялся: «зависший» сокет (сеть сменилась, сервер не отвечает) считался живым. Теперь нет pong 10 с — переподключаемся.
    const tick = () => {
      const ws = this.ws; const sentAt = Date.now();
      if (!this.send({ t: 'ping' })) { this.timers.push(setTimeout(tick, 25000)); return; }
      this.timers.push(setTimeout(() => {
        if (this.ws === ws && ws && (this.pongAt || 0) < sentAt) { this.diag('нет pong 10 с — сокет считается зависшим, переподключаюсь'); try { ws.terminate(); } catch {} }
      }, 10000));
      this.timers.push(setTimeout(tick, 25000));
    };
    this.timers.push(setTimeout(tick, 25000));
  }
  scheduleRetry() {
    if (this.stopped) return;
    this.retry = Math.min(this.retry + 1, 6);
    const ms = Math.min(30000, 1000 * 2 ** this.retry);
    this.timers.push(setTimeout(() => this.connect(), ms));
  }
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(obj)); return true; }
    return false;
  }
}
module.exports = { Signaling };
