'use strict';
// Юнит-проверки без Electron: хранилище, помощник-администратор (протокол и защита токеном).
const assert = require('assert'); const net = require('net'); const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-unit-'));
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('ENC' + s), decryptString: (b) => b.toString().slice(3) };
let st = new Store(dir, fakeSafe);
assert(/^[1-9]\d{8}$/.test(st.data.id)); assert(st.data.token.length === 64);
st.setPassword('secret-pass-1'); st.saveNow();
assert(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('secret-pass-1'), 'пароль не должен лежать открытым текстом');
const st2 = new Store(dir, fakeSafe); assert.equal(st2.getPassword(), 'secret-pass-1'); assert.equal(st2.data.id, st.data.id);
assert(!('token' in st2.publicView()) && !('passwordEnc' in st2.publicView())); assert.equal(st2.publicView().hasPassword, true);
console.log('ok: store (ID постоянный, пароль зашифрован, токен не уходит в интерфейс)');
{ // встроенный сервер скрыт от интерфейса; свой сервер и миграция старых настроек; пароли устройств
  const v = st2.publicView(); assert(!('server' in v), 'адрес встроенного сервера не должен попадать в интерфейс');
  assert(!JSON.stringify(v).includes('46.226.166.141'));
  assert.equal(st2.active().host, '46.226.166.141');
  st2.data.custom = { host: 'my.example', port: 9443, fingerprint: '' }; st2.data.customServer = true; assert.equal(st2.active().host, 'my.example');
  st2.data.customServer = false; assert.equal(st2.active().host, '46.226.166.141');
  st2.setDevicePw('123456789', 'pw-for-device', true); st2.saveNow();
  assert(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('pw-for-device'), 'пароль устройства не лежит открытым текстом');
  assert.deepEqual(st2.getDevicePw('123456789'), { pw: 'pw-for-device', admin: true });
  assert.deepEqual(st2.publicView().savedDevices, { 123456789: { admin: true } }); assert(!JSON.stringify(st2.publicView()).includes('pw-for-device'));
  st2.clearDevicePw('123456789'); assert.equal(st2.getDevicePw('123456789'), null);
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-unit2-')); fs.writeFileSync(path.join(d2, 'config.json'), JSON.stringify({ id: '111222333', token: 'x'.repeat(64), server: { host: 'old.custom.host', port: 8443, fingerprint: 'AA' } }));
  const st3 = new Store(d2, fakeSafe); assert.equal(st3.data.customServer, true); assert.equal(st3.active().host, 'old.custom.host'); assert.equal(st3.data.server.host, '46.226.166.141'); assert.equal(st3.data.server.fingerprint, '');
  console.log('ok: store — встроенный сервер скрыт, свой сервер, миграция старого адреса, пароли устройств зашифрованы');
}
const { cmpVer } = require('../src/semver');
assert.equal(cmpVer('0.1.6', '0.1.5'), 1); assert.equal(cmpVer('v0.1.5', '0.1.5'), 0); assert.equal(cmpVer('0.1.9', '0.2.0'), -1); assert.equal(cmpVer('0.10.0', '0.9.9'), 1);
console.log('ok: сравнение версий для обновлений');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conn = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.setEncoding('utf8'); s.on('connect', () => res(s)); s.on('error', () => res(null)); });
(async () => {
  const port = 25000 + Math.floor(Math.random() * 3000), token = 'tok-' + Math.random();
  const h = spawn('node', [path.join(__dirname, '../src/helper.js'), String(port), token]);
  let exited = false; h.on('exit', () => (exited = true)); await sleep(500);
  // с неверным токеном — разрыв
  const bad = await conn(port); bad.write(JSON.stringify({ token: 'nope' }) + '\n');
  await new Promise((r) => bad.on('close', r)); console.log('ok: helper рвёт соединение при неверном токене');
  // верный токен
  const good = await conn(port); let buf = ''; good.on('data', (d) => (buf += d));
  good.write(JSON.stringify({ token }) + '\n'); await sleep(300);
  assert(JSON.parse(buf.split('\n')[0]).ok === true); console.log('ok: helper принимает верный токен');
  good.write(JSON.stringify({ k: 'move', x: 5, y: 5 }) + '\n' + JSON.stringify({ k: 'key', code: 'KeyA', down: true }) + '\n' + JSON.stringify({ k: 'release' }) + '\n');
  await sleep(200); assert(!exited);
  // второе подключение не принимается (слушатель закрыт)
  assert.equal(await conn(port), null); console.log('ok: второе подключение к helper невозможно');
  // закрытие основного процесса -> helper завершается
  good.destroy(); await sleep(600); assert(exited); console.log('ok: helper завершается при закрытии соединения');
  console.log('\nЮНИТ-ТЕСТЫ ПРОЙДЕНЫ'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
