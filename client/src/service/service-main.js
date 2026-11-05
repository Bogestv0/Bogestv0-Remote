'use strict';
/**
 * Служба Bogestv0 REMOTE (SYSTEM). Запускается WinSW:  ELECTRON_RUN_AS_NODE=1 <app.exe> service-main.js
 *
 * Единственная задача: по запросу приложения (loopback) — ПОСЛЕ системного окна «Да/Нет»,
 * показанного в сессии пользователя (WTSSendMessage, его нельзя нажать программно из процесса пользователя
 * на SYSTEM-окно из-за UIPI) — запустить SYSTEM-помощника в сессии пользователя и вернуть токен подключения.
 * Служба сама ничего не передаёт по сети.
 */
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CTL_PORT = 47931;
const MIN_GAP_MS = 5000;          // не чаще одного запроса на согласие в 5 секунд
const CONSENT_TIMEOUT_S = 30;

/** Настройки службы лежат в %ProgramData% (обычный пользователь туда писать не может), а не в профиле пользователя. */
function fileStore(file) {
  return {
    load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } },
    save(o) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o)); } catch (e) { console.error('service state', e); } },
  };
}

function createService({ api, exePath, helperScript, rand = () => crypto.randomBytes(24).toString('hex'), now = Date.now, pickPort, store }) {
  let lastAsk = 0, busy = false;
  const pick = pickPort || (() => 49000 + crypto.randomInt(0, 1000));
  const st = store || { _o: {}, load() { return this._o; }, save(o) { this._o = o; } };
  // «Молчаливый» админ-доступ (вход по паролю сразу с правами администратора) включается ТОЛЬКО после системного окна «Да/Нет»
  // на самом компьютере — как и обычное согласие: из процесса пользователя это окно программно не нажать.
  let silentAdmin = st.load().silentAdmin === true;

  async function setSilent(on, peerPid) {
    if (!on) { silentAdmin = false; st.save({ ...st.load(), silentAdmin: false }); return { ok: true, silent: false }; }
    if (busy) return { ok: false, err: 'busy' };
    const session = api.activeSession();
    if (session === null) return { ok: false, err: 'no-session' };
    if (peerPid && api.sessionOfPid(peerPid) !== session) return { ok: false, err: 'wrong-session' };
    busy = true;
    try {
      const ok = await api.consent(session, 'Bogestv0 REMOTE',
        'Включить режим: каждый, кто входит на этот компьютер по паролю, СРАЗУ получает права администратора — без подтверждения здесь и без окна UAC.\n\nРазрешить?',
        CONSENT_TIMEOUT_S);
      if (!ok) return { ok: false, err: 'denied' };
      silentAdmin = true; st.save({ ...st.load(), silentAdmin: true });
      return { ok: true, silent: true };
    } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) }; }
    finally { busy = false; }
  }

  async function startHelper(req, peerPid) {
    if (busy) return { ok: false, err: 'busy' };
    if (now() - lastAsk < MIN_GAP_MS) return { ok: false, err: 'rate' };
    const session = api.activeSession();
    if (session === null) return { ok: false, err: 'no-session' };
    // запросивший процесс должен жить в активной сессии пользователя
    if (peerPid && api.sessionOfPid(peerPid) !== session) return { ok: false, err: 'wrong-session' };
    busy = true; lastAsk = now();
    try {
      const from = String(req.from || '').replace(/[^0-9]/g, '').slice(0, 9);
      const name = String(req.name || '').replace(/[\r\n\u0000]/g, ' ').slice(0, 60);
      // silent=true допустим только если владелец заранее подтвердил режим системным окном (см. setSilent)
      const skipConsent = req.silent === true && silentAdmin;
      const ok = skipConsent || await api.consent(session, 'Bogestv0 REMOTE',
        `Устройство ${name || 'без имени'} (${from || '—'}) просит расширенный доступ: управление окнами UAC, экраном входа и программами администратора.\n\nРазрешить?`,
        CONSENT_TIMEOUT_S);
      if (!ok) return { ok: false, err: 'denied' };
      const port = pick(), token = rand();
      const r = api.spawnInSession({ session, exe: exePath, args: [helperScript, String(port), token],
        env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH || '' } });
      return { ok: true, port, token, pid: r.pid };
    } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) }; }
    finally { busy = false; }
  }

  function handle(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.setTimeout(60000, () => sock.destroy());
    sock.on('error', () => {});
    sock.on('data', async (d) => {
      buf += d; if (buf.length > 4096) return sock.destroy();
      const i = buf.indexOf('\n'); if (i < 0) return;
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch { return sock.destroy(); }
      buf = '';
      let res;
      if (m.cmd === 'status') res = { ok: true, service: true, session: api.activeSession(), silent: silentAdmin };
      else if (m.cmd === 'set-silent') res = await setSilent(m.on === true, Number(m.pid) || 0);
      else if (m.cmd === 'start-helper') res = await startHelper(m, Number(m.pid) || 0);
      else res = { ok: false, err: 'bad-cmd' };
      sock.end(JSON.stringify(res) + '\n');
    });
  }
  return { startHelper, handle, setSilent, isSilent: () => silentAdmin };
}

module.exports = { createService, CTL_PORT };

if (require.main === module) {
  const { createServiceApi } = require('./win32');
  const exePath = process.execPath;
  const helperScript = path.join(__dirname, 'helper-system.js');
  const store = fileStore(path.join(process.env.ProgramData || 'C:\\ProgramData', 'Bogestv0 REMOTE', 'service.json'));
  const svc = createService({ api: createServiceApi(), exePath, helperScript, store });
  const srv = net.createServer((s) => svc.handle(s));
  srv.listen(CTL_PORT, '127.0.0.1');
  process.on('uncaughtException', (e) => { console.error(e); });
}
