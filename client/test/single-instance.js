'use strict';
// Второй запуск: новая копия завершается, первая разворачивается из трея/свёрнутого состояния. Проверяется на настоящем Electron.
const { _electron: electron } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = String(22000 + Math.floor(Math.random() * 1000));
const exe = require('electron'); const appDir = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bg-si-'));
const env = { ...process.env, BG_SINGLE_PORT: PORT, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
const second = (ud) => new Promise((resolve) => {
  const p = spawn(exe, [appDir, '--no-sandbox', `--user-data-dir=${ud}`], { env, stdio: 'ignore' });
  const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ exited: false }); }, 15000);
  p.on('exit', (code) => { clearTimeout(t); resolve({ exited: true, code }); });
});
(async () => {
  const ud1 = tmp();
  const app = await electron.launch({ executablePath: exe, args: [appDir, '--no-sandbox', `--user-data-dir=${ud1}`], env });
  const win = await app.firstWindow(); await win.waitForSelector('#statusText');
  const visible = () => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w.isVisible() && !w.isMinimized(); });
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  // 1) тот же каталог данных (обычный повторный запуск), окно спрятано в трей
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  if (await visible()) throw new Error('окно должно быть скрыто перед проверкой');
  let r = await second(ud1);
  if (!r.exited) throw new Error('вторая копия не завершилась (тот же каталог данных)');
  await sleep(500); if (!(await visible())) throw new Error('первая копия не развернулась из трея');
  console.log('ok: повторный запуск — новая копия закрывается, окно из трея разворачивается');

  // 2) свёрнутое окно
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize()); await sleep(300);
  r = await second(ud1); if (!r.exited) throw new Error('вторая копия не завершилась (свёрнуто)');
  await sleep(500); if (!(await visible())) throw new Error('первая копия не развернулась из свёрнутого состояния');
  console.log('ok: повторный запуск разворачивает свёрнутое окно');

  // 3) другой каталог данных (другой пользователь/права): встроенная блокировка Electron не сработает, срабатывает порт
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  const ud2 = tmp(); r = await second(ud2);
  if (!r.exited) throw new Error('вторая копия с другим каталогом данных не завершилась');
  await sleep(500); if (!(await visible())) throw new Error('первая копия не развернулась (другой каталог данных)');
  if (fs.existsSync(path.join(ud2, 'config.json'))) throw new Error('вторая копия успела создать своё устройство (config.json)');
  if ((await windows()) !== 1) throw new Error('окон должно быть одно');
  console.log('ok: копия с другим каталогом данных тоже не стартует и не заводит второе устройство');

  await app.close();
  console.log('\nОДИН ЭКЗЕМПЛЯР: ПРОВЕРКИ ПРОЙДЕНЫ'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
