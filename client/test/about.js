'use strict';
// «Об авторе»: окно открывается ровно после 10 нажатий на значок версии, ссылка ведёт на канал, строка авторства есть в настройках.
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1100, height: 800 } });
  const calls = []; await page.exposeFunction('__bridge', (m) => { calls.push(m); return m === 'cfg.get' ? CFG : m === 'sig.state' ? { connected: true, id: '123456789' } : m === 'updater.state' ? { status: 'idle' } : { ok: true }; });
  const CFG = { id: '123456789', name: 'T', hostname: 'T', version: '0.1.14', platform: 'win32', savedDevices: {}, autostartState: { supported: true, set: true, willLaunch: true }, customServer: false, custom: { host: '', port: 8443, fingerprint: '' }, unattended: false, hasPassword: false, allowedIds: [], autostart: false, minimizeToTray: true, devices: [], log: [], injector: true, sig: { connected: true, id: '123456789', error: '' } };
  await page.addInitScript(() => {
    const mk = (ns) => new Proxy({}, { get: (_t, k) => (k.startsWith('on') ? () => () => {} : (...a) => window.__bridge(ns + '.' + String(k), a)) });
    window.bridge = new Proxy({}, { get: (_t, ns) => mk(String(ns)) });
  });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('file://' + path.join(__dirname, '../src/renderer/index.html'));
  await page.waitForSelector('#verChip');
  for (let i = 0; i < 9; i++) await page.click('#verChip');
  assert.strictEqual(await page.locator('.modal-about').count(), 0, 'после 9 нажатий окна быть не должно');
  await page.click('#verChip');
  await page.waitForSelector('.modal-about'); if (process.env.SHOT2) await page.waitForTimeout(500), await page.screenshot({ path: process.env.SHOT2 });
  const t = await page.locator('.modal-about').innerText();
  for (const s of ['Михаил', '© 2026 Bogestv0', 't.me/bogestv0', 'любимая девушка', 'Masha']) assert(t.includes(s), 'нет текста: ' + s);
  await page.click('.about-link'); await page.waitForTimeout(100);
  assert(calls.includes('app.openChannel'), 'ссылка не вызвала openChannel');
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  // пауза > 2 с сбрасывает счётчик
  for (let i = 0; i < 6; i++) await page.click('#verChip');
  await page.waitForTimeout(2200);
  for (let i = 0; i < 6; i++) await page.click('#verChip');
  assert.strictEqual(await page.locator('.modal-about').count(), 0, 'счётчик должен сбрасываться');
  await page.click('.tab[data-view="security"]'); await page.waitForTimeout(300);

  assert(await page.locator('.author-foot a[data-action="open-channel"]').count() === 1, 'нет строки авторства в настройках');
  assert.deepStrictEqual(errs, []);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await b.close(); console.log('about ok');
})().catch((e) => { console.error(e); process.exit(1); });
