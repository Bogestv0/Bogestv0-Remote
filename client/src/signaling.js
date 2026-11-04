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
  setState(p) { this.state = { ...this.state, ...p }; this.emit('state', this.state); }

  connect() {
    const { host, port, fingerprint } = this.store.data.server;
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
      const pinned = this.store.data.server.fingerprint;
      if (!fp) { ws.terminate(); return this.setState({ connected: false, error: 'Сервер не предъявил сертификат' }); }
      if (pinned && pinned.toUpperCase() !== fp.toUpperCase()) {
        ws.terminate();
        this.setState({ connected: false, error: 'Отпечаток сертификата сервера не совпал — соединение заблокировано' });
        this.stopped = true; // не долбимся, пока пользователь не сменит отпечаток
        return;
      }
      if (!pinned) { // доверие при первом подключении (TOFU)
        this.store.data.server.fingerprint = fp; this.store.save();
        this.emit('fingerprint-learned', fp);
      }
      this.hello();
    });

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      switch (m.t) {
        case 'welcome':
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
        case 'pong': break;
        default: this.emit('message', m);
      }
    });
    ws.on('close', () => { if (this.ws === ws) { this.ws = null; this.setState({ connected: false }); this.scheduleRetry(); } });
    ws.on('error', (e) => { this.setState({ connected: false, error: this.explain(e) }); });
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
    const tick = () => { this.send({ t: 'ping' }); this.timers.push(setTimeout(tick, 25000)); };
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
