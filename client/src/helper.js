'use strict';
// Повышенный (администратор) помощник ввода.
// Запускается как:  ELECTRON_RUN_AS_NODE=1 <app.exe> helper.js <port> <token>
// через UAC — то есть только после явного «Да» пользователя на принимающем компьютере.
// Принимает ровно одно подключение с токеном от основного процесса; при его закрытии завершается.
const net = require('net');
const { createInjector } = require('./input');

const port = Number(process.argv[2]);
const token = process.argv[3];
if (!port || !token) process.exit(2);

const inj = createInjector();
let accepted = false;
const srv = net.createServer((sock) => {
  if (accepted) return sock.destroy();           // второе подключение не принимаем
  let buf = ''; let authed = false;
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    if (buf.length > 1e6) return sock.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!authed) {
        if (m.token !== token) return sock.destroy();
        authed = true; accepted = true; srv.close();   // больше никого не слушаем
        sock.write(JSON.stringify({ ok: true, injector: inj.available, elevated: true }) + '\n');
        continue;
      }
      switch (m.k) {
        case 'move': inj.move(m.x, m.y); break;
        case 'btn': inj.button(m.b, m.down); break;
        case 'wheel': inj.wheel(m.dx, m.dy); break;
        case 'key': inj.key(m.code, m.down); break;
        case 'release': inj.releaseAll(); break;
      }
    }
  });
  // завершаемся только когда закрылось АВТОРИЗОВАННОЕ соединение; чужие попытки помощника не убивают
  sock.on('close', () => { if (authed) { try { inj.releaseAll(); } catch {} process.exit(0); } });
  sock.on('error', () => { if (authed) process.exit(0); else sock.destroy(); });
});
srv.listen(port, '127.0.0.1');
setTimeout(() => { if (!accepted) process.exit(0); }, 30000); // никто не подключился — выходим
