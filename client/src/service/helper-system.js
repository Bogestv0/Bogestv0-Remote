'use strict';
/**
 * SYSTEM-помощник в сессии пользователя: ввод на любом рабочем столе (включая UAC/Winlogon)
 * и захват экрана защищённого рабочего стола (обычный захват Chromium его не видит).
 * Запуск: ELECTRON_RUN_AS_NODE=1 <exe> helper-system.js <port> <token>
 * Протокол — как у helper.js + события {"ev":"desktop","name","secure"} и кадры (linefmt.frameHeader + RGBA).
 */
const net = require('net');
const { createInjector } = require('../input');
const { frameHeader } = require('../linefmt');

function run({ port, token, desk, inj, srvFactory = net.createServer, exit = process.exit, fps = 8 }) {
  let accepted = false, sockRef = null, timer = null, secure = false, capOn = false, lastName = '';
  const send = (o) => { try { sockRef && sockRef.write(JSON.stringify(o) + '\n'); } catch {} };
  const tick = () => {
    try {
      const d = desk.sync();
      if (d.changed || d.name !== lastName) {
        lastName = d.name; secure = d.name !== '' && d.name.toLowerCase() !== 'default';
        send({ ev: 'desktop', name: d.name, secure });
      }
      if (capOn || secure) {
        const f = desk.capture(1280);
        if (f && sockRef && sockRef.writable) {
          if (sockRef.writableLength > 8 * 1024 * 1024) return;   // получатель не успевает — пропускаем кадр
          sockRef.write(frameHeader(f.w, f.h, f.rgba.length)); sockRef.write(f.rgba);
        }
      }
    } catch {}
  };
  const srv = srvFactory((sock) => {
    if (accepted) return sock.destroy();
    let buf = '', authed = false; sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d; if (buf.length > 1e6) return sock.destroy();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (!authed) {
          if (m.token !== token) return sock.destroy();
          authed = true; accepted = true; sockRef = sock; srv.close();
          try { desk.dpiAware(); } catch {}
          sock.write(JSON.stringify({ ok: true, injector: inj.available, elevated: true, system: true }) + '\n');
          timer = setInterval(tick, Math.round(1000 / fps)); tick();
          continue;
        }
        try {
          desk.sync();   // ввод всегда на текущем рабочем столе
          switch (m.k) {
            case 'move': inj.move(m.x, m.y); break;
            case 'btn': inj.button(m.b, m.down); break;
            case 'wheel': inj.wheel(m.dx, m.dy); break;
            case 'key': inj.key(m.code, m.down); break;
            case 'release': inj.releaseAll(); break;
            case 'capture': capOn = !!m.on; break;
          }
        } catch {}
      }
    });
    const done = () => { if (authed) { clearInterval(timer); try { inj.releaseAll(); } catch {} exit(0); } else sock.destroy(); };
    sock.on('close', done); sock.on('error', done);
  });
  srv.listen(port, '127.0.0.1');
  const idle = setTimeout(() => { if (!accepted) exit(0); }, 30000);
  return { srv, tick, stop: () => { clearInterval(timer); clearTimeout(idle); } };
}
module.exports = { run };

if (require.main === module) {
  const port = Number(process.argv[2]), token = process.argv[3];
  if (!port || !token) process.exit(2);
  const { createDesktopApi } = require('./win32');
  run({ port, token, desk: createDesktopApi(), inj: createInjector() });
}
