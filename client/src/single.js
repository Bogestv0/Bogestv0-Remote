'use strict';
// Защита от второго запуска. Встроенная блокировка Electron работает через каталог данных и не срабатывает, если копии запущены
// с разными правами (обычный запуск и «от имени администратора») или из разных каталогов данных. Поэтому дополнительно — порт на 127.0.0.1
// с рукопожатием: первая копия слушает, вторая сообщает ей «покажись» и завершается.
const net = require('net');

const PORT = Number(process.env.BG_SINGLE_PORT) || 47932;
const APP = 'bogestv0-remote';

/** Спросить, есть ли уже запущенная копия. Ответ должен быть именно от нашей программы — чужой процесс на этом порту не считается. */
function pingRunning(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1'); let buf = ''; let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
    s.setEncoding('utf8'); s.setTimeout(timeoutMs, () => fin(false));
    s.on('connect', () => s.write(JSON.stringify({ app: APP, cmd: 'show' }) + '\n'));
    s.on('data', (d) => {
      buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
      try { const r = JSON.parse(buf.slice(0, i)); fin(!!(r && r.ok === true && r.app === APP)); } catch { fin(false); }
    });
    s.on('error', () => fin(false));
  });
}

/** 'owner' — мы первая копия; 'running' — уже есть другая (ей отправлено «показать окно»); 'unknown' — порт занят чужой программой, продолжаем как обычно. */
function claim(onShow) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = ''; sock.setEncoding('utf8'); sock.setTimeout(3000, () => sock.destroy()); sock.on('error', () => {});
      sock.on('data', (d) => {
        buf += d; if (buf.length > 1024) return sock.destroy();
        const i = buf.indexOf('\n'); if (i < 0) return;
        let m = null; try { m = JSON.parse(buf.slice(0, i)); } catch {}
        if (m && m.app === APP && m.cmd === 'show') { try { onShow(); } catch {} }
        sock.end(JSON.stringify({ ok: true, app: APP }) + '\n');
      });
    });
    srv.once('error', async (e) => resolve(e && e.code === 'EADDRINUSE' ? ((await pingRunning()) ? 'running' : 'unknown') : 'unknown'));
    srv.once('listening', () => resolve('owner'));
    srv.listen(PORT, '127.0.0.1');
  });
}
module.exports = { claim, pingRunning, PORT };
