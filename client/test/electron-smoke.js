'use strict';
// Дымовой тест настоящего Electron: окно, preload/IPC, TLS-соединение с пиннингом отпечатка.
const { _electron: electron } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 21000 + Math.floor(Math.random() * 500);
(async () => {
  const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-es-srv-')), ud = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-es-ud-'));
  execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ${sd}/key.pem -out ${sd}/cert.pem -days 2 -subj "/CN=t" 2>/dev/null`);
  const srv = spawn('node', [path.join(__dirname, '../../server/server.js')], { env: { ...process.env, PORT, DATA_DIR: sd } });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); await sleep(800);
  const fp = /FINGERPRINT \(SHA-256\): (\S+)/.exec(log)[1];
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ server: { host: '127.0.0.1', port: PORT, fingerprint: '' } }));

  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), '--no-sandbox', `--user-data-dir=${ud}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const win = await app.firstWindow();
  const errs = []; win.on('pageerror', (e) => errs.push(e.message));
  await win.waitForSelector('#statusText');
  const t0 = Date.now(); let txt = '';
  while (Date.now() - t0 < 15000) { txt = await win.textContent('#statusText'); if (txt.includes('В сети')) break; await sleep(300); }
  if (!txt.includes('В сети')) throw new Error('не подключились к серверу: ' + txt);
  console.log('ok: окно Electron открылось, preload/IPC работают, статус:', txt);
  const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
  await sleep(600);
  const saved = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
  if (saved.server.fingerprint !== fp) throw new Error('TOFU: отпечаток не запомнен: ' + saved.server.fingerprint);
  console.log('ok: отпечаток сертификата запомнен при первом подключении (TOFU)');
  const bridgeKeys = await win.evaluate(() => Object.keys(window.bridge).join(','));
  console.log('ok: bridge =', bridgeKeys, '| нет доступа к Node из страницы:', await win.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'));
  const src = await win.evaluate(() => window.bridge.screen.source());
  console.log('screen.source ->', src ? `${src.width}x${src.height}` : 'null (в xvfb может не быть экрана)');
  const fontOk = await win.evaluate(() => document.fonts.check('700 16px Manrope') && document.fonts.check('400 14px Onest'));
  console.log('ok: локальные шрифты загружены:', fontOk);
  if (errs.length) throw new Error('page errors: ' + errs.join('; '));
  await app.close();

  // подмена сертификата: сервер с другим сертификатом — клиент обязан отказаться
  srv.kill(); await sleep(300);
  const sd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-es-srv2-'));
  execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ${sd2}/key.pem -out ${sd2}/cert.pem -days 2 -subj "/CN=evil" 2>/dev/null`);
  const evil = spawn('node', [path.join(__dirname, '../../server/server.js')], { env: { ...process.env, PORT, DATA_DIR: sd2 } }); await sleep(800);
  const app2 = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), '--no-sandbox', `--user-data-dir=${ud}`] });
  const w2 = await app2.firstWindow(); await w2.waitForSelector('#statusText'); await sleep(3500);
  const t2 = await w2.textContent('#statusText'); const err = await w2.getAttribute('#statusChip', 'title');
  if (t2.includes('В сети')) throw new Error('ПОДМЕНЁННЫЙ сервер принят!');
  console.log('ok: сервер с другим сертификатом отклонён →', t2, '|', err);
  await app2.close(); evil.kill();
  console.log('\nELECTRON SMOKE ПРОЙДЕН'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
