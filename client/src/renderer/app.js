/* Bogestv0 REMOTE — интерфейс. Протокол сессии — в session.js, системные функции — в main-процессе. */
(function () {
  'use strict';
  const B = window.bridge;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtId = (id) => String(id || '').replace(/(\d{3})(?=\d)/g, '$1 ');
  const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
  const I = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICON = {
    monitor: I('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    eye: I('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
    ptr: I('<path d="M9 9l6 6M9 15V9h6"/>'),
    shield: I('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/>'),
    info: I('<path d="M12 9v4M12 16.5h.01"/><circle cx="12" cy="12" r="9"/>'),
    spk: I('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 7a7 7 0 0 1 0 10"/>'),
    mic: I('<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v4M9 22h6"/>'),
    out: I('<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M9 7h6M9 11h6M9 15h3"/>'),
    full: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    x: I('<path d="M5 5l14 14M19 5L5 19"/>'),
    clipUp: I('<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>'),
    chat: I('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
    cursor: I('<path d="M5 3l14 7-6 2-2 6L5 3z"/>'),
    clipDown: I('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
  };
  const REASONS = {
    busy: 'Устройство занято другим подключением',
    denied: 'Подключение отклонено на устройстве',
    timeout: 'Устройство не ответило вовремя',
    offline: 'Устройство не в сети',
    'bad-password': 'Неверный пароль',
    blocked: 'Слишком много неверных паролей — попробуйте через 10 минут',
    'password-disabled': 'На устройстве выключен вход по паролю или ваш ID не в списке разрешённых',
    lost: 'Соединение потеряно',
    'auth-timeout': 'Подтверждение не получено',
    'capture-failed': 'Не удалось захватить экран на устройстве',
    error: 'Ошибка соединения',
    'peer-left': 'Собеседник завершил сессию',
    kicked: 'Сессия завершена владельцем устройства',
  };
  const reasonText = (r) => REASONS[r] || 'Сессия завершена';

  // ------------------------------------------------------------------ состояние
  const S = {
    cfg: null, sig: { connected: false, id: '', error: '' }, ice: [], online: new Set(),
    prompts: [], inSess: null, inTimer: null,
    out: null,            // {to, name, state, info, stats, error, admin, adminPending, control, speakers, mic}
    streams: {}, view: 'devices', upd: null,
    vol: (() => { try { const v = JSON.parse(localStorage.getItem('bg.vol') || '{}'); return { spk: Math.min(1, Math.max(0, v.spk ?? 1)), mic: Math.min(1, Math.max(0, v.mic ?? 1)) }; } catch { return { spk: 1, mic: 1 }; } })(),
    chat: { out: [], in: [] }, chatDraft: { out: '', in: '' }, chatUnread: 0, presenceAt: 0, refreshing: false, customForm: false,
    chatOpen: (() => { try { return localStorage.getItem('bg.chatOpen') === '1'; } catch { return false; } })(),
    localCursor: (() => { try { return localStorage.getItem('bg.localCursor') !== '0'; } catch { return true; } })(),   // показывать свой курсор над удалённым экраном
  };
  const hooks = {
    getIce: () => S.ice,
    getCfg: () => S.cfg,
    askUser: (req) => new Promise((resolve) => queuePrompt(req, resolve)),
    onIn: onIncomingEvent,
    onOut: onOutgoingEvent,
    log: (e) => B.log.add(e).then((log) => { S.cfg.log = log; if (S.view === 'security') renderSecurity(); }),
  };
  const sess = new window.RemoteSession(B, hooks);
  window.__sess = sess; window.__S = S; // для отладки/тестов

  // ------------------------------------------------------------------ утилиты UI
  function toast(text, bad) {
    const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = text;
    document.body.appendChild(t); setTimeout(() => t.remove(), 4200);
  }
  function modal(html, wire) {
    const root = $('modalRoot');
    root.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
    const close = () => { root.innerHTML = ''; };
    root.querySelector('.modal-back').addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-back')) close(); });
    wire(root.querySelector('.modal'), close);
    return close;
  }
  const deviceName = (id) => { const d = S.cfg.devices.find((x) => x.id === id); return d ? d.name : fmtId(id); };
  const saveDevices = () => B.cfg.set({ devices: S.cfg.devices });
  function show(name) {
    if (!$('view-' + name)) name = 'devices';
    S.view = name;
    if (name !== 'session' && S.fs) setFullscreen(false); // пришёл запрос/уведомление — выходим из полного экрана, чтобы его увидели
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.body.classList.toggle('sess', name === 'session' && !!S.out);
    renderAll();
  }
  function switchHtml(on, action, locked) { return `<button class="switch${on ? ' on' : ''}${locked ? ' locked' : ''}" data-action="${action}" aria-pressed="${!!on}"></button>`; }

  // ------------------------------------------------------------------ об авторе
  const ABOUT_ART = `    Я очень             сильно л        
    юблю теб            я маша I        
 love you so muc    h Masha Te quier    
o muchisimo Mash    a Je t'aime tres    
 fort Masha Ich liebe dich sehr Masha Ti
 amo tantissimo Masha Я дуже сильно коха
ю тебе маша Kocham cie bardzo mocno Masz
a Я очень сильно люблю тебя маша I love 
    you so much Masha Te quiero much    
    isimo Masha Je t'aime tres fort     
        Masha Ich liebe dich seh        
        r Masha Ti amo tantissim        
            o Masha Я дуже с            
            ильно кохаю тебе            
                 маша Ko                
                cham cie                `;
  function aboutDialog() {
    modal(`<h2>Bogestv0 REMOTE <span class="hint">v${esc(S.cfg.version)}</span></h2>
      <div class="about-meta"><b>Автор:</b> Михаил<br>© 2026 Bogestv0. Все права защищены.<br>Лицензия: AGPL-3.0-or-later<br>Telegram-канал: <a href="#" class="about-link" data-action="open-channel">t.me/bogestv0</a></div>
      <div class="about-text"><p>Я устал от программ удалённого доступа, где за всё просят деньги, а без оплаты показывают рекламу и вводят ограничения. Поэтому я создал своё приложение — без подписок, рекламы и лишних условий.</p>
      <p>Была и более личная причина. Моя любимая девушка не могла подключаться к рабочему компьютеру удалённо и делать отчёты, и меня это беспокоило. Теперь всё решено, и всё работает.</p></div>
      <pre class="about-art">${esc(ABOUT_ART)}</pre>
      <div class="modal-actions"><button class="btn btn-primary" data-c>Закрыть</button></div>`,
    (m, close) => {
      m.classList.add('modal-about');
      m.querySelector('[data-c]').onclick = close;
      const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('keydown', onKey);
    });
  }
  // 10 нажатий подряд на значок версии (пауза между нажатиями не больше 2 секунд)
  let verClicks = 0, verTimer = null;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#verChip')) return;
    clearTimeout(verTimer); verTimer = setTimeout(() => { verClicks = 0; }, 2000);
    if (++verClicks >= 10) { verClicks = 0; clearTimeout(verTimer); aboutDialog(); }
  });

  // ------------------------------------------------------------------ верхняя панель
  function renderTop() {
    const chip = $('statusChip');
    chip.classList.toggle('bad', !S.sig.connected);
    $('statusText').textContent = S.sig.connected ? `В сети · ID ${fmtId(S.cfg.id)}` : 'Нет связи с сервером';
    chip.title = S.sig.connected ? 'Нажмите, чтобы скопировать ID. Окно можно закрыть — приложение продолжит работать в трее' : (S.sig.error || 'Подключаемся…');
    $('verChip').innerHTML = `v${esc(S.cfg.version)}<span class="ver-os"> · ${esc(S.cfg.platform === 'win32' ? 'Windows' : S.cfg.platform)}</span>`;
    const u = S.upd, uc = $('updChip');
    const show = u && ['available', 'downloading', 'ready'].includes(u.status);
    uc.classList.toggle('hidden', !show);
    if (show) {
      uc.classList.toggle('busy', u.status !== 'available');
      uc.dataset.action = u.status === 'available' ? 'upd-update' : '';
      uc.textContent = u.status === 'available' ? (u.canAuto ? `Обновить до v${u.latest}` : `Вышла v${u.latest}`) : u.status === 'downloading' ? `Скачиваем ${u.percent}%…` : 'Перезапуск…';
      uc.title = u.status === 'available' ? (u.canAuto ? 'Скачать, установить и перезапустить приложение' : 'Открыть страницу загрузки') : '';
    }
    $('accName').textContent = S.cfg.name || S.cfg.hostname;
    $('avatar').textContent = (S.cfg.name || 'Б').trim().charAt(0).toUpperCase();
    const b = $('badge'); b.textContent = S.prompts.length; b.classList.toggle('hidden', !S.prompts.length);
  }

  // ------------------------------------------------------------------ Устройства
  function renderDevices() {
    const list = S.cfg.devices;
    const on = list.filter((d) => S.online.has(d.id)).length;
    const card = (d) => {
      const isOn = S.online.has(d.id);
      return `<div class="panel device ${isOn ? 'is-on' : ''}" ${isOn ? '' : 'style="opacity:.75"'}>
        <div class="device-top"><div class="device-icon">${ICON.monitor}</div>
          <div style="min-width:0"><div class="device-name">${esc(d.name)}</div><div class="device-meta">ID ${fmtId(d.id)}${S.cfg.savedDevices[d.id] ? ' · пароль сохранён' : ''}</div></div>
          <button class="device-del" data-action="del-device" data-id="${d.id}" title="Убрать из списка">×</button></div>
        <div class="device-status ${isOn ? 'on' : ''}"><span class="dot"></span>${isOn ? 'В сети' : 'Не в сети'}</div>
        <div class="row-actions"><button class="btn ${isOn ? 'btn-primary' : 'btn-ghost'}" style="flex:1" data-action="connect" data-id="${d.id}" ${S.out || !S.sig.connected ? 'disabled' : ''}>${isOn ? 'Подключиться' : 'Недоступен'}</button>
          ${S.cfg.savedDevices[d.id] ? `<button class="btn btn-ghost" data-action="connect-opts" data-id="${d.id}" title="Другие параметры подключения" ${S.out || !S.sig.connected ? 'disabled' : ''}>⋯</button>` : ''}</div>
      </div>`;
    };
    $('view-devices').innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Устройства</h1>
      <div class="page-desc">${on} в сети · ${list.length - on} не в сети${S.presenceAt ? ' · проверено ' + new Date(S.presenceAt).toLocaleTimeString('ru') : ''} · сквозное шифрование</div></div>
      <button class="btn btn-ghost btn-sm" data-action="refresh" ${S.refreshing ? 'disabled' : ''} title="Заново проверить, какие компьютеры сейчас в сети">${S.refreshing ? 'Проверяем…' : 'Обновить'}</button></div>
      <div class="edgebar">${ICON.info}Любое подключение — входящее или по заранее заданному паролю — показывает уведомление на принимающем устройстве. Тихих подключений нет.</div>
      <div class="grid">
        <div class="panel device ${S.sig.connected ? 'is-on' : ''}">
          <div class="device-top"><div class="device-icon">${ICON.monitor}</div>
            <div style="min-width:0"><div class="device-name">${esc(S.cfg.name || S.cfg.hostname)} <span class="hint">(это устройство)</span></div>
            <div class="device-meta">${S.cfg.platform === 'win32' ? 'Windows' : S.cfg.platform}</div></div></div>
          <div class="my-id">${fmtId(S.cfg.id)}</div>
          <div class="device-status ${S.sig.connected ? 'on' : ''}"><span class="dot"></span>${S.sig.connected ? 'Готов принимать подключения' : esc(S.sig.error || 'Нет связи с сервером')}</div>
          <button class="btn btn-ghost btn-block" data-action="copy-id">Скопировать ID</button>
        </div>
        ${list.map(card).join('')}
        <div class="panel device" data-action="add-device" style="border:1.5px dashed var(--line);border-left:1.5px dashed var(--line);align-items:center;justify-content:center;text-align:center;gap:8px;cursor:pointer">
          <div class="device-icon" style="background:transparent">${ICON.plus}</div>
          <div class="device-name" style="color:var(--muted)">Добавить устройство</div>
        </div>
      </div>`;
  }
  function addDeviceDialog() {
    modal(`<h2>Добавить устройство</h2>
      <div class="field"><label>ID устройства</label><input id="mId" inputmode="numeric" placeholder="000 000 000" maxlength="11" autofocus></div>
      <div class="field"><label>Название</label><input id="mName" placeholder="Например, Рабочий ПК" maxlength="48"></div>
      <div class="err-text" id="mErr"></div>
      <div class="modal-actions"><button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Добавить</button></div>`,
    (m, close) => {
      m.querySelector('[data-c]').onclick = close;
      const idIn = m.querySelector('#mId'); idIn.oninput = () => { idIn.value = fmtId(onlyDigits(idIn.value).slice(0, 9)); };
      m.querySelector('[data-ok]').onclick = async () => {
        const id = onlyDigits(idIn.value);
        if (id.length !== 9) return (m.querySelector('#mErr').textContent = 'ID — это 9 цифр');
        if (id === S.cfg.id) return (m.querySelector('#mErr').textContent = 'Это ваш собственный ID');
        if (S.cfg.devices.some((d) => d.id === id)) return (m.querySelector('#mErr').textContent = 'Такое устройство уже в списке');
        S.cfg.devices.push({ id, name: m.querySelector('#mName').value.trim() || fmtId(id) });
        await saveDevices(); close(); pollPresence(); renderAll();
      };
    });
  }
  function connectDialog(id, note) {
    const saved = S.cfg.savedDevices[id];
    modal(`<h2>Подключиться к «${esc(deviceName(id))}»</h2>
      ${note ? `<div class="edgebar" style="background:var(--warn-soft);border-left-color:var(--warn)">${ICON.info}${esc(note)}</div>` : ''}
      <label class="radio-card ${saved ? '' : 'sel'}" data-mode="ask"><input type="radio" name="mode" value="ask" ${saved ? '' : 'checked'}>
        <div><div class="t">С подтверждением</div><div class="d">На том устройстве появится окно «Разрешить / Отклонить». Пароль не нужен.</div></div></label>
      <label class="radio-card ${saved ? 'sel' : ''}" data-mode="password"><input type="radio" name="mode" value="password" ${saved ? 'checked' : ''}>
        <div><div class="t">По паролю</div><div class="d">Без клика на том устройстве. Работает, если там включён вход по паролю и ваш ID разрешён. Уведомление всё равно покажется.</div></div></label>
      <div class="field ${saved ? '' : 'hidden'}" id="pwBox"><label>Пароль устройства</label><input id="mPw" type="password" autocomplete="off" placeholder="${saved ? 'сохранён — оставьте пустым, чтобы использовать его' : ''}"></div>
      <label class="check ${saved ? '' : 'hidden'}" id="rememberBox"><input type="checkbox" id="mRemember" ${saved ? 'checked' : ''}><span>Запомнить пароль для этого устройства<br><span class="hint">Хранится зашифрованным на этом компьютере. В следующий раз кнопка «Подключиться» войдёт сразу.</span></span></label>
      <label class="check ${saved ? 'hidden' : ''}" id="adminBox"><input type="checkbox" id="mAdmin"><span>Запросить права администратора<br><span class="hint">Отдельное подтверждение на том устройстве (окно Windows UAC)</span></span></label>
      <div class="err-text" id="mErr"></div>
      <div class="modal-actions">${saved ? '<button class="btn btn-danger" data-forget style="margin-right:auto">Забыть пароль</button>' : ''}<button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Подключиться</button></div>`,
    (m, close) => {
      m.querySelector('[data-c]').onclick = close;
      const forget = m.querySelector('[data-forget]');
      if (forget) forget.onclick = async () => { await B.dev.clearPw(id); await refreshCfg(); close(); renderAll(); toast('Сохранённый пароль удалён'); };
      const sync = () => {
        const mode = m.querySelector('input[name=mode]:checked').value;
        m.querySelectorAll('.radio-card').forEach((c) => c.classList.toggle('sel', c.dataset.mode === mode));
        m.querySelector('#pwBox').classList.toggle('hidden', mode !== 'password');
        m.querySelector('#rememberBox').classList.toggle('hidden', mode !== 'password');
        m.querySelector('#adminBox').classList.toggle('hidden', mode === 'password');   // при входе по паролю права администратора отдельно не запрашиваются
      };
      m.querySelectorAll('input[name=mode]').forEach((r) => (r.onchange = sync));
      m.querySelector('[data-ok]').onclick = async () => {
        const mode = m.querySelector('input[name=mode]:checked').value;
        const typed = m.querySelector('#mPw').value; const admin = mode !== 'password' && m.querySelector('#mAdmin').checked;
        let password = typed, usedSaved = false;
        if (mode === 'password') {
          if (!password && saved) { const r = await B.dev.getPw(id); if (r) { password = r.pw; usedSaved = true; } }
          if (!password) return (m.querySelector('#mErr').textContent = 'Введите пароль');
          if (m.querySelector('#mRemember').checked) await B.dev.savePw(id, password, false); else if (saved) await B.dev.clearPw(id);
          await refreshCfg();
        }
        close(); startOut(id, { mode, password, admin, usedSaved });
      };
    });
  }
  /** Подключение сразу, без диалога, по сохранённому паролю. */
  async function quickConnect(id) {
    const r = await B.dev.getPw(id);
    if (!r) { await refreshCfg(); return connectDialog(id); }
    startOut(id, { mode: 'password', password: r.pw, admin: false, usedSaved: true });
  }
  async function startOut(id, opts) {
    S.out = { to: id, usedSaved: !!opts.usedSaved, name: deviceName(id), state: 'calling', info: null, stats: null, error: '', admin: false, adminPending: !!opts.admin, control: true, speakers: true, mic: false };
    S.streams = {}; location.hash = 'session';
    try { await sess.connect(id, opts); } catch (e) { S.out = null; toast('Не удалось начать подключение: ' + e.message, true); }
    renderAll();
  }

  // ------------------------------------------------------------------ Входящие запросы
  function queuePrompt(req, resolve) {
    const timeoutMs = req.kind === 'admin' ? 45000 : 18000;
    const p = { ...req, resolve, started: Date.now(), timeoutMs };
    p.timer = setTimeout(() => finishPrompt(p, false), timeoutMs);
    S.prompts.push(p);
    if (S.prompts.length === 1) B.app.attention(req.kind === 'admin' ? 'Запрос прав администратора' : 'Входящее подключение', `${req.name} (ID ${fmtId(req.from)})`);
    location.hash = 'connect'; renderAll();
  }
  function finishPrompt(p, ok) {
    const i = S.prompts.indexOf(p); if (i < 0) return;
    clearTimeout(p.timer); S.prompts.splice(i, 1); p.resolve(ok);
    if (ok) location.hash = 'session';
    else if (!S.prompts.length) location.hash = 'devices';
    renderAll();
    if (S.prompts.length) B.app.attention('Входящий запрос', `${S.prompts[0].name} (ID ${fmtId(S.prompts[0].from)})`);
  }
  function renderConnect() {
    const p = S.prompts[0];
    if (!p) {
      $('view-connect').innerHTML = `<div><h1 class="page-title">Входящее подключение</h1><div class="page-desc">Показывается поверх всех окон на принимающем устройстве</div></div>
        <div class="panel empty"><b>Запросов нет</b>Когда кто-то попытается подключиться к этому устройству, окно появится здесь автоматически — даже если приложение было свёрнуто в трей.</div>`;
      return;
    }
    const isAdmin = p.kind === 'admin';
    const left = Math.max(0, Math.ceil((p.timeoutMs - (Date.now() - p.started)) / 1000));
    $('view-connect').innerHTML = `
      <div><h1 class="page-title">${isAdmin ? 'Запрос прав администратора' : 'Входящее подключение'}</h1><div class="page-desc">Показывается поверх всех окон на принимающем устройстве${S.prompts.length > 1 ? ` · в очереди ещё ${S.prompts.length - 1}` : ''}</div></div>
      <div class="prompt-wrap"><div class="prompt">
        <div class="prompt-who"><div class="prompt-avatar">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</div>
          <div><div class="prompt-name">${esc(p.name)} ${isAdmin ? 'просит права администратора' : 'хочет подключиться'}</div><div class="prompt-id">ID ${fmtId(p.from)}</div></div></div>
        <div class="scope-list"><div class="eyebrow" style="padding-bottom:1px">Что получит доступ</div>
          ${isAdmin
            ? `<div class="scope-row elevated">${ICON.shield}Управление окнами с правами администратора и окнами установщиков</div>
               <div class="scope-row">${ICON.info}Windows покажет окно UAC — его нужно подтвердить на этом компьютере</div>`
            : `<div class="scope-row">${ICON.eye}Просмотр экрана и звук динамиков</div>
               <div class="scope-row">${ICON.ptr}Управление мышью и клавиатурой</div>
               ${p.admin ? `<div class="scope-row elevated">${ICON.shield}Запрошены права администратора — нужно отдельное подтверждение</div>` : ''}`}
        </div>
        <div><div class="timer-track"><div class="timer-fill" id="timerFill" style="width:${(left * 1000 / p.timeoutMs) * 100}%"></div></div>
          <div class="hint" style="margin-top:6px" id="timerText">Автоотклонение через ${left} с, если нет ответа</div></div>
        <div class="prompt-actions"><button class="btn btn-ghost btn-block" data-action="deny">Отклонить</button><button class="btn btn-primary btn-block" data-action="allow">Разрешить</button></div>
      </div></div>`;
  }
  setInterval(() => {
    const p = S.prompts[0]; if (!p || S.view !== 'connect') return;
    const f = $('timerFill'); if (!f) return;
    const left = Math.max(0, p.timeoutMs - (Date.now() - p.started));
    f.style.width = (left / p.timeoutMs) * 100 + '%';
    $('timerText').textContent = `Автоотклонение через ${Math.ceil(left / 1000)} с, если нет ответа`;
  }, 250);

  // ------------------------------------------------------------------ События сессий
  function onIncomingEvent(ev) {
    if (ev.type === 'chat') return pushChat('in', ev.text, false, ev.sess.name);
    if (ev.type === 'ended') {
      S.inSess = null; clearInterval(S.inTimer); S.chat.in = []; S.chatDraft.in = '';
      // если по этой сессии ещё висели запросы — закрываем
      S.prompts.filter((p) => p.from === ev.sess.from).forEach((p) => finishPrompt(p, false));
      if (ev.reason && !['kicked'].includes(ev.reason)) toast(`Сессия с «${ev.sess.name}» завершена`);
    } else {
      S.inSess = ev.sess;
      if (ev.type === 'active') {
        B.app.notify('Bogestv0 REMOTE', `Вас подключил ${ev.sess.name} (ID ${fmtId(ev.sess.from)})`);
        clearInterval(S.inTimer); S.inTimer = setInterval(() => {   // обновляем только время — перерисовка стёрла бы набираемое сообщение в чате
          if (!S.inSess || S.inSess.state !== 'active') return;
          const sec = Math.floor((Date.now() - S.inSess.startedAt) / 1000); const t = [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map((x) => String(x).padStart(2, '0')).join(':');
          document.querySelectorAll('.sess-time').forEach((n) => { n.textContent = t; });
        }, 1000);
        location.hash = 'session';
        // к этому компьютеру подключились — убираем окно программы в трей, чтобы оно не закрывало удалённый экран
        if (S.cfg.hideOnConnect !== false && !S.out) setTimeout(() => { if (S.inSess && S.inSess.state === 'active' && !S.out) B.win.hide(); }, 600);
      }
    }
    renderAll();
  }
  function onOutgoingEvent(ev) {
    const o = S.out; if (!o && ev.type !== 'ended') return;
    switch (ev.type) {
      case 'state': o.state = ev.state; break;
      case 'track': S.streams[ev.which] = ev.stream; attachStreams(); break;
      case 'granted': o.state = 'active'; o.info = ev.info; attachStreams(); break;
      case 'admin-pending': o.adminPending = true; break;
      case 'admin': o.adminPending = false; o.admin = ev.ok; toast(ev.ok ? 'Права администратора подтверждены' : 'Права администратора не выданы' + (ev.reason && ev.reason !== 'denied' ? ': ' + ev.reason : ''), !ev.ok); break;
      case 'mic': if (!ev.ok) { o.mic = false; toast('Микрофон недоступен: ' + ev.reason, true); } break;
      case 'spk-src':
        if (ev.ok) { o.spkSrc = ev.id; if (o.info) o.info.hasAudio = true; toast(ev.id === 'system' ? 'Источник звука: весь системный звук' : 'Источник звука переключён'); }
        else { o.spkSrc = o.spkSrcPrev || 'system'; toast('Не удалось переключить источник звука: ' + ev.reason, true); }
        break;
      case 'devices': if (o.info) o.info.mics = ev.mics; toast('Список устройств обновлён'); break;
      case 'stats': o.stats = ev; break;
      case 'chat': return pushChat('out', ev.text, false, o.name);
      case 'monitor': if (ev.ok) { o.info.monitor = ev.id; o.info.w = ev.w; o.info.h = ev.h; } else toast('Не удалось сменить монитор: ' + ev.reason, true); break;
      case 'clip': B.app.copy(ev.text); toast(ev.text ? `Буфер удалённого устройства скопирован (${ev.text.length} симв.)` : 'Буфер обмена удалённого устройства пуст'); break;
      case 'clip-ack': toast(ev.ok ? 'Текст отправлен в буфер обмена удалённого устройства' : 'Не удалось отправить текст (слишком длинный?)', !ev.ok); break;
      case 'clip-empty': toast('Ваш буфер обмена пуст или в нём не текст', true); break;
      case 'ended':
        if (S.out && S.out.usedSaved && ev.reason === 'bad-password') {   // сохранённый пароль устарел — забываем и просим новый
          const bad = S.out.to; B.dev.clearPw(bad).then(refreshCfg).then(() => connectDialog(bad, 'Сохранённый пароль не подошёл. Введите новый.'));
        }
        if (S.out) { toast(ev.reason === 'kicked-by-me' ? 'Сессия завершена' : reasonText(ev.reason), !['kicked-by-me', 'ended'].includes(ev.reason)); }
        S.out = null; S.streams = {}; S.chat.out = []; S.chatDraft.out = ''; S.chatUnread = 0; attachStreams(); setFullscreen(false); document.body.classList.remove('sess');
        if (S.view === 'session' && !S.inSess) location.hash = 'devices';
        break;
    }
    if (ev.type === 'stats') { updateStatsOnly(); return; }
    renderAll();
  }

  // ------------------------------------------------------------------ Чат
  const hhmm = (ts) => new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const chatMsgHtml = (m) => `<div class="chat-msg ${m.me ? 'me' : ''}"><div class="chat-bubble">${esc(m.text)}</div><div class="chat-time">${m.me ? 'вы' : esc(m.who || '')} · ${hhmm(m.ts)}</div></div>`;
  function chatHtml(kind, peer) {
    const L = S.chat[kind];
    return `<div class="chat" data-kind="${kind}"><div class="chat-head"><b>Чат</b><span class="hint">${esc(peer)}</span></div>
      <div class="chat-log" id="chatLog-${kind}">${L.length ? L.map(chatMsgHtml).join('') : '<div class="chat-empty">Сообщений пока нет. Напишите — собеседник увидит их сразу.</div>'}</div>
      <form class="chat-form" data-kind="${kind}"><input class="chat-input" id="chatIn-${kind}" maxlength="2000" autocomplete="off" placeholder="Сообщение…" value="${esc(S.chatDraft[kind])}"><button class="btn btn-primary btn-sm" type="submit">Отправить</button></form></div>`;
  }
  function updateChatBadge() {
    const b = document.querySelector('[data-action="t-chat"] .tool-badge'); if (!b) return;
    b.textContent = S.chatUnread > 9 ? '9+' : S.chatUnread; b.classList.toggle('hidden', !S.chatUnread);
  }
  function applyChatOpen() {
    const st = $('stage'); if (st) st.classList.toggle('chat-open', S.chatOpen);
    const b = document.querySelector('[data-action="t-chat"]'); if (b) b.classList.toggle('on', S.chatOpen);
    try { localStorage.setItem('bg.chatOpen', S.chatOpen ? '1' : '0'); } catch {}
  }
  /** Добавляет сообщение «на месте», не перерисовывая окно сессии (иначе пропал бы набираемый текст и фокус). */
  function pushChat(kind, text, me, who) {
    const m = { text, me, who, ts: Date.now() }; const L = S.chat[kind]; L.push(m); if (L.length > 200) L.shift();
    const log = $('chatLog-' + kind);
    if (log) { const e = log.querySelector('.chat-empty'); if (e) e.remove(); log.insertAdjacentHTML('beforeend', chatMsgHtml(m)); log.scrollTop = log.scrollHeight; }
    if (me) return;
    const focused = document.hasFocus();
    if (kind === 'out' && !S.chatOpen) { S.chatOpen = true; applyChatOpen(); }          // пришло сообщение — панель чата раскрывается сама
    const seen = !!log && S.view === 'session' && focused;
    if (kind === 'out') { if (!seen) { S.chatUnread++; updateChatBadge(); } }
    if (!seen || !focused) B.app.chatNotify(who || 'Сообщение', text.slice(0, 120));
  }
  document.addEventListener('input', (e) => { const t = e.target; if (t && t.classList && t.classList.contains('chat-input')) S.chatDraft[t.closest('.chat').dataset.kind] = t.value; });
  document.addEventListener('focusin', (e) => { if (e.target && e.target.classList && e.target.classList.contains('chat-input') && S.chatUnread) { S.chatUnread = 0; updateChatBadge(); } });
  document.addEventListener('submit', (e) => {
    const f = e.target; if (!f.classList || !f.classList.contains('chat-form')) return;
    e.preventDefault();
    const kind = f.dataset.kind, inp = f.querySelector('.chat-input'), text = inp.value.trim(); if (!text) return;
    const ok = kind === 'out' ? sess.sendChat(text) : sess.sendChatHost(text);
    if (!ok) return toast('Не удалось отправить: нет активного подключения', true);
    pushChat(kind, text, true); inp.value = ''; S.chatDraft[kind] = '';
  });

  // ------------------------------------------------------------------ Сессия
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = true; video.tabIndex = 0; video.disableRemotePlayback = true;
  function attachStreams() {
    if (video.srcObject !== (S.streams.video || null)) video.srcObject = S.streams.video || null;
    const sp = $('aSpk'), mc = $('aMic');
    if (sp.srcObject !== (S.streams.speakers || null)) sp.srcObject = S.streams.speakers || null;
    if (mc.srcObject !== (S.streams.mic || null)) mc.srcObject = S.streams.mic || null;
    sp.muted = S.out ? !S.out.speakers : false; sp.volume = S.vol.spk; mc.volume = S.vol.mic;
    if (S.streams.speakers) setupMeter(S.streams.speakers);
  }
  /** «Во весь экран» = полноэкранное окно Electron + окно сессии, растянутое на всё окно (CSS .stage-full).
   *  HTML Fullscreen API здесь не используем: он зависит от разрешений Chromium и сбрасывается при любой перерисовке DOM. */
  function setFullscreen(on) {
    on = !!on && !!S.out;
    S.fs = on;
    document.body.classList.toggle('stage-full', on);
    try { B.win.setFullScreen(on); } catch {}
    const b = document.querySelector('[data-action="t-full"]');
    if (b) { b.classList.toggle('on', on); b.title = on ? 'Выйти из полноэкранного режима' : 'Во весь экран'; }
  }
  const OUT_STATUS = { calling: 'Соединяемся…', 'waiting-approval': 'Ждём подтверждения на устройстве…', authenticating: 'Проверяем пароль…' };
  function renderSession() {
    document.body.classList.toggle('sess', S.view === 'session' && !!S.out);
    document.body.classList.toggle('stage-full', !!S.fs && !!S.out);
    const parts = [];
    const o = S.out, s = S.inSess;
    if (!o && !(s && s.state === 'active')) {
      $('view-session').innerHTML = `<div><h1 class="page-title">Сессия</h1><div class="page-desc">Нет активных сессий</div></div>
        <div class="panel empty"><b>Сейчас никто не подключён</b>Выберите устройство на вкладке «Устройства», чтобы начать сессию, или дождитесь входящего подключения.</div>`;
      return;
    }
    if (o) {
      const connecting = o.state !== 'active';
      parts.push(`<div class="sess-head"><h1 class="page-title">Активная сессия</h1><div class="page-desc">${esc(o.name)} · ID ${fmtId(o.to)}</div></div>
      <div class="session-stage ${S.chatOpen ? 'chat-open' : ''}" id="stage">
        <div class="session-banner"><div class="session-banner-left"><span class="live-dot"></span>${connecting ? esc(OUT_STATUS[o.state] || 'Соединяемся…') : `Вы управляете «${esc(o.name)}»${o.admin ? ' · доступ администратора активен' : ''}${o.adminPending ? ' · ждём подтверждения администратора…' : ''}`}</div>
          <button class="btn btn-danger btn-sm" data-action="hangup">Отключить сейчас</button></div>
        <div class="stage-body"><div class="stage-wrap ${o.control ? 'control' : ''} ${S.localCursor ? '' : 'nocursor'}" id="stageWrap">${connecting ? `<div class="stage-overlay"><div class="spinner"></div>${esc(OUT_STATUS[o.state] || 'Соединяемся…')}</div>` : ''}</div>${chatHtml('out', o.name)}</div>
        <div class="toolbar">
          <button class="tool-btn ${o.control ? 'on' : ''}" data-action="t-control" title="${o.control ? 'Управление включено' : 'Только просмотр'}">${ICON.ptr}</button>
          <button class="tool-btn ${S.chatOpen ? 'on' : ''}" data-action="t-chat" title="Чат с этим устройством">${ICON.chat}<span class="tool-badge ${S.chatUnread ? '' : 'hidden'}">${S.chatUnread > 9 ? '9+' : S.chatUnread}</span></button>
          <button class="tool-btn ${S.localCursor ? 'on' : ''}" data-action="t-cursor" title="${S.localCursor ? 'Ваш курсор над удалённым экраном: виден (нажмите, чтобы скрыть)' : 'Ваш курсор над удалённым экраном: скрыт (нажмите, чтобы показать)'}">${ICON.cursor}</button>
          <button class="tool-btn ${S.fs ? 'on' : ''}" data-action="t-full" title="${S.fs ? 'Выйти из полноэкранного режима' : 'Во весь экран'}">${ICON.full}</button>
          ${(o.info && o.info.monitors && o.info.monitors.length > 1) ? `<select class="select" id="monSel" style="height:34px;border-radius:9px;background:rgba(255,255,255,.08);color:#fff;border:0;max-width:210px" title="Какой монитор показывать">${o.info.monitors.map((m) => `<option value="${esc(m.id)}" ${m.id === o.info.monitor ? 'selected' : ''} style="color:#000">${esc(m.label)}</option>`).join('')}</select>` : ''}
          <button class="tool-btn" data-action="t-clip-send" title="Отправить текст из вашего буфера обмена на удалённое устройство" ${connecting ? 'disabled' : ''}>${ICON.clipUp}</button>
          <button class="tool-btn" data-action="t-clip-get" title="Получить текст из буфера обмена удалённого устройства" ${connecting ? 'disabled' : ''}>${ICON.clipDown}</button>
          <button class="tool-btn ${o.admin ? 'on' : ''}" data-action="t-admin" title="${o.admin ? 'Права администратора выданы' : 'Запросить права администратора'}" ${connecting ? 'disabled' : ''}>${ICON.shield}</button>
          <div class="tool-sep"></div>
          <button class="tool-btn ${o.speakers ? '' : 'muted'}" data-action="t-spk" title="Звук динамиков удалённого устройства: ${o.speakers ? 'включён' : 'выключен'}">${ICON.spk}</button>
          <button class="tool-btn ${o.mic ? 'on' : 'muted'}" data-action="t-mic" title="Микрофон удалённого устройства: ${o.mic ? 'включён' : 'выключен'}">${ICON.mic}</button>
          <div class="tool-sep"></div>
          <button class="tool-btn" style="background:rgba(255,90,82,.18);color:#ff8a80" data-action="hangup" title="Отключиться">${ICON.x}</button>
          <div class="tool-meta" id="toolMeta">${statsText(o)}</div>
        </div></div>`);
    }
    if (s && s.state === 'active') {
      const mins = Math.floor((Date.now() - s.startedAt) / 1000); const t = [Math.floor(mins / 3600), Math.floor(mins / 60) % 60, mins % 60].map((x) => String(x).padStart(2, '0')).join(':');
      parts.push(`${o ? '' : `<div><h1 class="page-title">Активная сессия</h1><div class="page-desc">К вам подключились · идёт <span class="sess-time">${t}</span></div></div>`}
      <div class="panel host-session"><div class="banner ${s.perms.admin ? 'admin' : ''}"><div class="session-banner-left" style="color:var(--fg)"><span class="live-dot"></span><b>Вас подключил ${esc(s.name)}</b>${s.perms.admin ? ' · доступ администратора активен' : ''}</div>
        <div class="row-actions"><button class="btn btn-ghost btn-sm" data-action="hide-window" title="Свернуть окно в трей; подключение продолжится">Скрыть окно</button><button class="btn btn-danger btn-sm" data-action="kick">Отключить сейчас</button></div></div>
        <div class="kv"><span>ID ${fmtId(s.from)}</span><span>${s.mode === 'password' ? 'вход по паролю' : 'по подтверждению'}</span><span>идёт <span class="sess-time">${t}</span></span><span>экран · мышь и клавиатура</span></div>
        ${chatHtml('in', s.name)}</div>`);
    }
    $('view-session').innerHTML = parts.join('');
    const wrap = $('stageWrap'); if (wrap) { wrap.insertBefore(video, wrap.firstChild); attachStreams(); video.play().catch(() => {}); }
    document.querySelectorAll('.chat-log').forEach((l) => { l.scrollTop = l.scrollHeight; });
  }
  function statsText(o) {
    const st = o.stats; if (!st || o.state !== 'active') return '<span>—</span>';
    return `<span>${st.fps} fps</span><span>${st.rtt || '—'} мс</span><span>${st.mbps.toFixed(1)} Мбит/с</span><span>${st.route ? st.route + ' · ' : ''}DTLS-SRTP</span>`;
  }
  function updateStatsOnly() { const m = $('toolMeta'); if (m && S.out) m.innerHTML = statsText(S.out); }

  // --- ввод с удалённого экрана
  function norm(e) {
    const r = video.getBoundingClientRect(); const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
    const k = Math.min(r.width / vw, r.height / vh); const w = vw * k, h = vh * k;
    const x = (e.clientX - (r.left + (r.width - w) / 2)) / w, y = (e.clientY - (r.top + (r.height - h) / 2)) / h;
    return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
  }
  const held = new Set(); let moveQueued = null, moveLast = 0, moveTimer = 0;
  const ctl = () => S.out && S.out.state === 'active' && S.out.control;
  // Движение мыши уходит сразу (раньше ждали следующий кадр отрисовки — до 16 мс задержки), но не чаще раза в 8 мс; последнее положение не теряется.
  const flushMove = () => { moveTimer = 0; const q = moveQueued; moveQueued = null; if (q) { moveLast = performance.now(); sess.sendInput({ k: 'mm', ...q }); } };
  video.addEventListener('mousemove', (e) => {
    if (!ctl()) return; const p = norm(e); if (!p) return;
    moveQueued = p;
    const wait = 8 - (performance.now() - moveLast);
    if (wait <= 0) { clearTimeout(moveTimer); flushMove(); } else if (!moveTimer) moveTimer = setTimeout(flushMove, wait);
  });
  video.addEventListener('mousedown', (e) => { video.focus(); if (!ctl()) return; const p = norm(e); if (p) { e.preventDefault(); sess.sendInput({ k: 'md', b: e.button, ...p }); } });
  video.addEventListener('mouseup', (e) => { if (!ctl()) return; const p = norm(e) || { x: 0.5, y: 0.5 }; e.preventDefault(); sess.sendInput({ k: 'mu', b: e.button, ...p }); });
  video.addEventListener('wheel', (e) => { if (!ctl()) return; e.preventDefault(); sess.sendInput({ k: 'wh', dx: e.deltaX, dy: e.deltaY }); }, { passive: false });
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  video.addEventListener('keydown', (e) => { if (!ctl()) return; e.preventDefault(); held.add(e.code); sess.sendInput({ k: 'kd', code: e.code }); });
  video.addEventListener('keyup', (e) => { if (!ctl()) return; e.preventDefault(); held.delete(e.code); sess.sendInput({ k: 'ku', code: e.code }); });
  video.addEventListener('blur', () => { for (const c of held) sess.sendInput({ k: 'ku', code: c }); held.clear(); });

  // ------------------------------------------------------------------ Звук
  let meterCtx = null, meterFor = null, meterRaf = 0;
  function setupMeter(stream) {
    if (meterFor === stream) return; meterFor = stream;
    try {
      meterCtx = meterCtx || new AudioContext();
      const an = meterCtx.createAnalyser(); an.fftSize = 64;
      meterCtx.createMediaStreamSource(stream).connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      cancelAnimationFrame(meterRaf);
      const tick = () => {
        const bars = document.querySelectorAll('#meter span');
        if (bars.length) { an.getByteFrequencyData(data); bars.forEach((b, i) => { b.style.height = Math.max(8, (data[i + 1] / 255) * 100) + '%'; }); }
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  }
  async function renderAudio() {
    const o = S.out; const act = o && o.state === 'active';
    const info = (act && o.info) || {}; const mics = info.mics || [];
    let outs = []; try { outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch {}
    $('view-audio').innerHTML = `
      <div><h1 class="page-title">Звук</h1><div class="page-desc">${act ? `Что слышно во время сессии с «${esc(o.name)}»` : 'Настройки доступны во время сессии'}</div></div>
      <div class="edgebar">${ICON.info}Звук передаётся отдельным потоком поверх видео. Можно включить динамики, микрофон — оба сразу или по одному.</div>
      <div class="panel" style="display:flex;flex-direction:column;gap:2px">
        <div class="audio-row"><div class="audio-icon ${act && o.speakers ? 'active' : ''}">${ICON.spk}</div>
          <div class="audio-body"><div class="audio-title">Звук с удалённого устройства</div>
            <div class="audio-help">${act && info.hasAudio === false ? 'На том устройстве не удалось захватить системный звук.' : 'Всё, что звучит на удалённом устройстве — музыка, уведомления, звук приложений — передаётся вам в реальном времени.'}</div>
            <div class="srcrow"><select class="select" id="spkSrc" title="Откуда брать звук на удалённом устройстве" ${act ? '' : 'disabled'}>
              <option value="system" ${(!act || (o.spkSrc || 'system') === 'system') ? 'selected' : ''}>Весь системный звук (колонки, программы)</option>
              ${mics.map((m) => `<option value="${esc(m.id)}" ${act && o.spkSrc === m.id ? 'selected' : ''}>Устройство ввода: ${esc(m.label)}</option>`).join('')}</select>
              <button class="btn btn-ghost btn-sm" data-action="a-refresh-dev" ${act ? '' : 'disabled'} title="Заново получить список звуковых устройств удалённого компьютера">Обновить список</button></div>
            <div class="audio-help" style="margin-top:6px">Можно выбрать любое устройство ввода удалённого компьютера: микрофон, «Стерео микшер», линейный вход или виртуальный кабель (например, VB-Cable) — тогда в сессию пойдёт звук именно с него.</div>
            <div class="meter ${act && o.speakers ? 'live' : ''}" id="meter">${Array.from({ length: 10 }, () => '<span style="height:12%"></span>').join('')}</div>
            <div class="vol" title="Громкость звука, который вы слышите"><span class="vol-l">Громкость</span><input type="range" class="range" data-vol="spk" min="0" max="100" value="${Math.round(S.vol.spk * 100)}" style="--p:${Math.round(S.vol.spk * 100)}%"><span class="vol-n">${Math.round(S.vol.spk * 100)}%</span></div></div>
          ${act ? `<button class="switch ${o.speakers ? 'on' : ''}" data-action="a-spk"></button>` : '<button class="switch locked"></button>'}</div>
        <div class="audio-row"><div class="audio-icon ${act && o.mic ? 'active' : ''}">${ICON.mic}</div>
          <div class="audio-body"><div class="audio-title">Микрофон удалённого устройства</div>
            <div class="audio-help">${mics.length ? 'Включите, чтобы слышать звук из комнаты, а не только с экрана.' : 'Микрофоны на удалённом устройстве не найдены.'}</div>
            <select class="select" id="micSel" style="margin-top:9px" ${mics.length ? '' : 'disabled'}>${mics.map((m) => `<option value="${esc(m.id)}" ${o && o.micId === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('') || '<option>—</option>'}</select>
            <div class="vol" title="Громкость микрофона удалённого устройства у вас"><span class="vol-l">Громкость</span><input type="range" class="range" data-vol="mic" min="0" max="100" value="${Math.round(S.vol.mic * 100)}" style="--p:${Math.round(S.vol.mic * 100)}%"><span class="vol-n">${Math.round(S.vol.mic * 100)}%</span></div></div>
          ${act && mics.length ? `<button class="switch ${o.mic ? 'on' : ''}" data-action="a-mic"></button>` : '<button class="switch locked"></button>'}</div>
        <div class="audio-row"><div class="audio-icon">${ICON.out}</div>
          <div class="audio-body"><div class="audio-title">Куда выводить звук у вас</div><div class="audio-help">Устройство воспроизведения на вашей стороне, принимающей оба потока.</div>
            <select class="select" id="outSel" style="margin-top:9px"><option value="">Эта система (по умолчанию)</option>${outs.filter((d) => d.deviceId !== 'default').map((d) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Устройство вывода')}</option>`).join('')}</select></div></div>
      </div>
      <div class="panel" style="display:flex;align-items:center;gap:12px"><div style="flex:1;min-width:0"><div class="setting-label">Состояние</div>
        <div class="setting-help">На устройствах без микрофона или звуковой карты переключатели недоступны — экран подключён, звука нет.</div></div>
        <span class="tag ${mics.length ? 'ok' : 'warn'}">${act ? (mics.length ? 'микрофон найден' : 'микрофона нет') : 'нет сессии'}</span></div>`;
    const os = $('outSel'); if (os) os.onchange = async () => { for (const id of ['aSpk', 'aMic']) { try { await $(id).setSinkId(os.value); } catch {} } };
  }

  // ------------------------------------------------------------------ Безопасность
  const AGO = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function logRow(e) {
    const T = { password: ['ok', 'без подтверждения'], ask: ['ok', 'запрос подтверждён'], admin: ['ok', 'админ подтверждён'], ended: ['ok', 'завершено'], denied: ['warn', 'отклонено'], 'bad-password': ['bad', 'неверный пароль'], 'admin-denied': ['warn', 'админ отклонён'], 'admin-failed': ['warn', 'админ не выдан'], clip: ['warn', 'буфер обмена'], audio: ['warn', 'источник звука'] }[e.kind] || ['ok', e.kind];
    return `<tr><td>${esc(e.who || '—')}</td><td class="mono">ID ${fmtId(e.id)}</td><td><span class="tag ${T[0]}">${esc(T[1])}</span></td><td class="mono">${AGO.format(new Date(e.ts))}</td></tr>`;
  }
  /** Панель «Обновления»: обновляется на месте, без перерисовки всей страницы (иначе во время скачивания сбрасывался бы журнал диагностики). */
  function updPanelHtml() {
    const u = S.upd || { status: 'idle', canAuto: false }; const cur = S.cfg.version;
    const busy = ['checking', 'downloading', 'ready'].includes(u.status);
    let line = `Установлена версия ${esc(cur)}`;
    if (u.status === 'checking') line = 'Проверяем наличие обновлений…';
    else if (u.status === 'available') line = `Доступна версия <b>${esc(u.latest)}</b> (у вас ${esc(cur)})`;
    else if (u.status === 'downloading') line = `Скачиваем обновление: ${u.percent}%`;
    else if (u.status === 'ready') line = 'Обновление скачано — устанавливаем и перезапускаем приложение…';
    else if (u.status === 'none') line = `У вас последняя версия (${esc(cur)})`;
    else if (u.status === 'error') line = `Не удалось проверить обновления: ${esc(u.error || 'нет связи')}`;
    const bar = u.status === 'downloading' ? `<div class="upd-bar"><i style="width:${u.percent}%"></i></div>` : '';
    const btn = u.status === 'available'
      ? `<button class="btn btn-primary btn-sm" data-action="upd-update">${u.canAuto ? 'Обновить сейчас' : 'Скачать новую версию'}</button>`
      : `<button class="btn btn-ghost btn-sm" data-action="upd-check" ${busy ? 'disabled' : ''}>Проверить обновления</button>`;
    const notes = u.status === 'available' && u.notes ? `<div class="setting-help" style="white-space:pre-wrap;max-height:120px;overflow:auto">${esc(u.notes)}</div>` : '';
    const hint = u.canAuto ? 'Приложение само проверяет обновления раз в 6 часов. Скачивание и установка — только после вашего нажатия; приложение перезапустится, идущий сеанс будет завершён. Windows может показать запрос UAC.' : 'Эта версия (портативная или запущена не из установщика) не умеет обновляться сама: при выходе новой версии кнопка откроет страницу загрузки.';
    return `<div class="panel-head" style="margin-bottom:2px"><h2>Обновления</h2><span class="tag ${u.status === 'available' ? 'warn' : u.status === 'error' ? 'bad' : 'ok'}">v${esc(cur)}</span></div>
      <div class="setting-row"><div><div class="setting-label">${line}</div><div class="setting-help">${hint}</div>${bar}${notes}</div>${btn}</div>`;
  }
  /** Реальное состояние автозапуска из Windows (а не только настройка в программе). */
  function autostartNote(c) {
    const a = c.autostartState || { supported: false };
    const tag = (cls, t) => `<span class="tag ${cls}" style="margin-top:6px">${t}</span>`;
    if (!a.supported) return tag('warn', 'в этой сборке недоступно (запуск не из установленной программы)');
    if (!c.autostart) return a.set ? tag('warn', 'в Windows запись ещё есть — перезапустите программу') : tag('warn', 'выключено');
    if (!a.set) return tag('bad', 'запись в автозагрузке не создана — перезапустите программу');
    if (!a.willLaunch) return tag('bad', 'Windows отключил автозапуск: Диспетчер задач → Автозагрузка → Bogestv0 REMOTE → «Включить»');
    return tag('ok', 'работает: запись в автозагрузке Windows есть');
  }
  function renderSecurity() {
    const c = S.cfg; const sv = c.custom || { host: '', port: 8443, fingerprint: '' }; const showCustom = c.customServer || S.customForm;
    $('view-security').innerHTML = `
      <div><h1 class="page-title">Безопасность</h1><div class="page-desc">Настройки доступа для устройства «${esc(c.name || c.hostname)}»</div></div>
      <div class="panel" style="display:flex;flex-direction:column;gap:2px">
        <div class="setting-row"><div><div class="setting-label">Уведомлять о каждом подключении</div><div class="setting-help">Системный баннер при входе — всегда, даже если вход настроен без подтверждения. Отключить нельзя.</div></div>${switchHtml(true, '', true)}</div>
        <div class="setting-row"><div><div class="setting-label">Вход без ручного подтверждения</div><div class="setting-help">Подключение по паролю ниже проходит сразу — без клика «Разрешить» на этом устройстве. Уведомление всё равно показывается.</div></div>${switchHtml(c.unattended, 'sec-unattended')}</div>
        <div class="setting-row"><div class="field"><label>Пароль для входа без подтверждения</label><input type="text" value="${c.hasPassword ? '•••••••• — задан' : 'не задан'}" readonly>
          <span class="hint">Задаёте и меняете только вы на этом устройстве. Используется вместе с ID — отдельно не работает. Хранится зашифрованным.</span></div>
          <button class="btn btn-ghost btn-sm" style="align-self:center" data-action="sec-password">${c.hasPassword ? 'Сменить пароль' : 'Задать пароль'}</button></div>
        <div class="setting-row"><div><div class="setting-label">Вход по паролю сразу с правами администратора</div><div class="setting-help">${c.passwordAdmin ? 'Включено: кто вошёл по паролю, сразу получает права администратора — без запроса и без окна UAC.' : 'Выключено: права администратора выдаются отдельным запросом с явным «Разрешить» и окном UAC, каждый раз.'} ${c.hasPassword ? '' : 'Сначала задайте пароль.'}${c.passwordAdmin && !S.svc ? ' Служба не установлена — окно UAC придётся подтверждать вручную.' : ''}</div></div>${switchHtml(c.passwordAdmin, 'sec-pwadmin', !c.hasPassword)}</div>
        <div class="setting-row"><div><div class="setting-label">Разрешённые устройства для входа без подтверждения</div><div class="setting-help">${c.allowedIds.length ? `Только эти ${c.allowedIds.length} устройств могут входить по паролю. С остальных — обычный запрос с ожиданием ответа.` : 'Список пуст — по паролю может войти любой ID, знающий пароль. Рекомендуем ограничить список.'}</div></div>
          <button class="btn btn-ghost btn-sm" data-action="sec-allowed">Управлять списком</button></div>
      </div>
      <div class="panel" style="display:flex;flex-direction:column;gap:2px">
        <div class="panel-head" style="margin-bottom:10px"><h2>Запуск и фоновая работа</h2></div>
        <div class="setting-row"><div><div class="setting-label">Служба расширенного доступа</div><div class="setting-help">${S.svc ? 'Установлена: управление окнами UAC и экраном входа возможно, каждый раз после вашего подтверждения системным окном.' : 'Не установлена (обычная версия или портативная). Права администратора запрашиваются через UAC; экран входа и окно UAC удалённо не видны. Служба ставится установщиком Setup.'}</div></div><span style="font-family:var(--mono,monospace);font-size:12px;opacity:.8">${S.svc ? 'работает' : 'нет'}</span></div>
        <div class="setting-row"><div><div class="setting-label">Запускать вместе с Windows</div><div class="setting-help">Добавляет приложение в автозагрузку текущего пользователя. Прав администратора не требует. Приложение стартует свёрнутым в трей и сразу готово принимать подключения.<br>${autostartNote(c)}</div></div>${switchHtml(c.autostart, 'sec-autostart')}</div>
        <div class="setting-row"><div><div class="setting-label">Сворачивать в трей вместо закрытия</div><div class="setting-help">Крестик на окне не завершает приложение — оно остаётся работать в фоне со значком в системном трее. Двойной клик по значку открывает окно.</div></div>${switchHtml(c.minimizeToTray, 'sec-tray')}</div>
        <div class="setting-row"><div><div class="setting-label">Прятать окно, когда к компьютеру подключились</div><div class="setting-help">Как только кто-то подключился к этому компьютеру, окно программы уходит в трей и не закрывает ему экран. Подключение продолжается; отключить его можно из меню значка в трее. Уведомление о входе показывается всё равно.</div></div>${switchHtml(c.hideOnConnect !== false, 'sec-hide')}</div>
        <div class="setting-row"><div><div class="setting-label">Значок в трее показывает статус</div><div class="setting-help">Серый — просто в сети, цветной — идёт подключение. Через значок доступны «Открыть окно» и «Выйти полностью».</div></div>${switchHtml(true, '', true)}</div>
        <div class="edgebar" style="margin-top:10px">${ICON.info}Работа в фоне не отключает уведомления о подключениях: баннер показывается, даже если окно свёрнуто в трей.</div>
      </div>
      <div class="panel" id="updPanel" style="display:flex;flex-direction:column;gap:10px">${updPanelHtml()}</div>
      <div class="panel" style="display:flex;flex-direction:column;gap:12px">
        <div class="panel-head"><h2>Сервер</h2><span class="tag ${S.sig.connected ? 'ok' : 'bad'}">${S.sig.connected ? 'подключён' : 'нет связи'}</span></div>
        ${S.sig.error && !S.sig.connected ? `<div class="edgebar" style="background:var(--bad-soft);border-left-color:var(--bad)">${ICON.info}${esc(S.sig.error)}</div>` : ''}
        <div class="setting-row"><div><div class="setting-label">Использовать свой сервер</div><div class="setting-help">По умолчанию программа работает через встроенный сервер Bogestv0 — его адрес не показывается и не меняется. Включите, только если хотите подключаться через собственный сервер.</div></div>${switchHtml(showCustom, 'sec-custom')}</div>
        ${showCustom ? `<div class="fieldrow"><div class="field"><label>Адрес</label><input id="svHost" value="${esc(sv.host)}" placeholder="например, remote.example.com"></div><div class="field" style="max-width:110px"><label>Порт</label><input id="svPort" value="${esc(sv.port)}" inputmode="numeric"></div></div>
        <div class="field"><label>Отпечаток сертификата сервера (SHA-256)</label><input id="svFp" value="${esc(sv.fingerprint)}" placeholder="пусто — запомнится при первом подключении"><span class="hint">Приложение доверяет только этому сертификату. Если отпечаток изменится — соединение будет заблокировано.</span></div>
        <div class="row-actions"><button class="btn btn-primary btn-sm" data-action="sv-save">Применить</button><button class="btn btn-ghost btn-sm" data-action="sv-reset">Сбросить отпечаток</button></div>` : ''}
      </div>
      <div class="panel" style="display:flex;flex-direction:column;gap:2px">
        <div class="panel-head" style="margin-bottom:10px"><h2>Соединение</h2></div>
        <div class="setting-row"><div><div class="setting-label">Соединять только через сервер</div><div class="setting-help">Весь трафик идёт через ваш сервер (TURN). Это надёжнее, когда устройства в разных сетях и прямое соединение не устанавливается. Выключите, чтобы разрешить прямые маршруты (меньше задержка, но не всегда работает). Меняйте на обоих устройствах.</div></div>${switchHtml(c.relayOnly === true, 'sec-relay')}</div>
      </div>
      <div class="panel" style="display:flex;flex-direction:column;gap:12px">
        <div class="panel-head"><h2>Диагностика соединения</h2><span class="hint">если подключение не получается — нажмите «Скопировать» и пришлите текст</span></div>
        <textarea id="diagBox" readonly spellcheck="false" style="width:100%;height:220px;resize:vertical;font-family:var(--mono,monospace);font-size:11px;line-height:1.45;background:rgba(0,0,0,.25);color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px">${esc(diagText())}</textarea>
        <div class="row-actions"><button class="btn btn-primary btn-sm" data-action="diag-copy">Скопировать</button><button class="btn btn-ghost btn-sm" data-action="diag-clear">Очистить</button></div>
      </div>
      <div class="panel" style="display:flex;flex-direction:column;gap:12px">
        <div class="panel-head"><h2>Журнал подключений</h2><span class="hint">хранится 90 дней</span></div>
        <div style="overflow-x:auto">${c.log.length ? `<table class="log"><tr><th>Кто</th><th>Устройство</th><th>Доступ</th><th>Время</th></tr>${c.log.slice(0, 50).map(logRow).join('')}</table>` : '<div class="empty">Подключений пока не было</div>'}</div>
      </div>
      <div class="author-foot">Автор: Михаил · © 2026 Bogestv0 · <a href="#" data-action="open-channel" title="Открыть Telegram-канал">t.me/bogestv0</a></div>`;
  }
  function diagText() {
    const c = S.cfg || {};
    const head = `Bogestv0 REMOTE v${c.version || '?'} · ${c.platform || ''} · ID ${c.id || '?'} · relayOnly=${c.relayOnly === true} · сервер ${S.sig && S.sig.connected ? 'в сети' : 'нет связи'} · ${new Date().toISOString()}`;
    // IPv4-адреса в журнале (в т.ч. адрес сервера из сообщений WebRTC) маскируем — журналом делятся в чате
    return (head + '\n' + (window.__evlog || []).join('\n')).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '•••.•••.•••.•••');
  }
  const randomPassword = () => { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const r = crypto.getRandomValues(new Uint8Array(14)); return [...r].map((x) => a[x % a.length]).join(''); };
  function passwordDialog() {
    modal(`<h2>${S.cfg.hasPassword ? 'Сменить пароль' : 'Задать пароль'}</h2>
      <div class="field"><label>Новый пароль (минимум 8 символов)</label><input id="pw1" type="text" autocomplete="off" autofocus></div>
      <div class="row-actions"><button class="btn btn-ghost btn-sm" data-gen>Сгенерировать</button><button class="btn btn-ghost btn-sm" data-cp>Скопировать</button></div>
      <div class="hint">Запишите пароль: он нужен тому, кто будет подключаться по ID. Здесь он хранится только зашифрованным.</div>
      <label class="check"><input type="checkbox" id="pwAdmin" ${S.cfg.passwordAdmin ? 'checked' : ''}><span>Подключившиеся по паролю сразу получают права администратора<br><span class="hint">Без отдельного запроса и без окна UAC. Тот, кто знает пароль, получает полный контроль над этим компьютером — задайте длинный пароль и ограничьте список разрешённых устройств. Включение подтверждается системным окном на этом компьютере.</span></span></label>
      <div class="err-text" id="mErr"></div>
      <div class="modal-actions">${S.cfg.hasPassword ? '<button class="btn btn-danger" data-rm style="margin-right:auto">Удалить пароль</button>' : ''}<button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Сохранить</button></div>`,
    (m, close) => {
      m.querySelector('[data-c]').onclick = close;
      m.querySelector('[data-gen]').onclick = () => { m.querySelector('#pw1').value = randomPassword(); };
      m.querySelector('[data-cp]').onclick = () => { const v = m.querySelector('#pw1').value; if (v) { B.app.copy(v); toast('Пароль скопирован'); } };
      const rm = m.querySelector('[data-rm]'); if (rm) rm.onclick = async () => { await B.cfg.setPassword(''); await refreshCfg(); close(); renderAll(); };
      m.querySelector('[data-ok]').onclick = async () => {
        const r = await B.cfg.setPassword(m.querySelector('#pw1').value);
        if (!r.ok) return (m.querySelector('#mErr').textContent = r.error);
        const want = m.querySelector('#pwAdmin').checked;
        if (want !== !!S.cfg.passwordAdmin) {
          m.querySelector('#mErr').textContent = want ? 'Подтвердите включение в системном окне на этом компьютере…' : '';
          const r2 = await B.cfg.set({ passwordAdmin: want });
          if (!r2.ok) { await refreshCfg(); renderAll(); return (m.querySelector('#mErr').textContent = 'Пароль сохранён, но ' + r2.error.charAt(0).toLowerCase() + r2.error.slice(1)); }
          if (r2.warn) toast(r2.warn);
        }
        await refreshCfg(); close(); renderAll(); toast('Пароль сохранён');
      };
    });
  }
  function allowedDialog() {
    modal(`<h2>Разрешённые устройства</h2>
      <div class="hint">ID устройств, которым можно входить по паролю без подтверждения. По одному в строке или через пробел. Пусто — разрешено любому, кто знает пароль.</div>
      <div class="field"><textarea id="ids" placeholder="123 456 789">${esc(S.cfg.allowedIds.map(fmtId).join('\n'))}</textarea></div>
      <div class="modal-actions"><button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Сохранить</button></div>`,
    (m, close) => {
      m.querySelector('[data-c]').onclick = close;
      m.querySelector('[data-ok]').onclick = async () => {
        const txt = m.querySelector('#ids').value.replace(/(\d{3})\s(\d{3})\s(\d{3})/g, '$1$2$3');
        const ids = [...new Set(txt.split(/[\s,;]+/).map(onlyDigits).filter((x) => x.length === 9))];
        await B.cfg.set({ allowedIds: ids }); await refreshCfg(); close(); renderAll();
      };
    });
  }

  // ------------------------------------------------------------------ события кликов
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el || el.disabled) return;
    const a = el.dataset.action;
    switch (a) {
      case 'open-channel': e.preventDefault(); return B.app.openChannel();
      case 'copy-id': B.app.copy(S.cfg.id); return toast('ID скопирован');
      case 'add-device': return addDeviceDialog();
      case 'del-device': S.cfg.devices = S.cfg.devices.filter((d) => d.id !== el.dataset.id); await saveDevices(); return renderAll();
      case 'connect': return S.cfg.savedDevices[el.dataset.id] ? quickConnect(el.dataset.id) : connectDialog(el.dataset.id);
      case 'connect-opts': return connectDialog(el.dataset.id);
      case 'refresh': {
        S.refreshing = true; renderDevices();
        if (!S.sig.connected) B.sig.reconnect();
        if (!S.cfg.devices.length) { S.presenceAt = Date.now(); S.refreshing = false; return renderDevices(); }
        pollPresence();
        setTimeout(() => { if (S.refreshing) { S.refreshing = false; if (S.view === 'devices') renderDevices(); } }, 4000);
        return;
      }
      case 'allow': return S.prompts[0] && finishPrompt(S.prompts[0], true);
      case 'deny': return S.prompts[0] && finishPrompt(S.prompts[0], false);
      case 'hangup': return sess.hangup();
      case 'kick': return sess.kickIn();
      case 'hide-window': return B.win.hide();
      case 't-control': S.out.control = !S.out.control; return renderAll();
      case 't-chat': { S.chatOpen = !S.chatOpen; if (S.chatOpen) { S.chatUnread = 0; updateChatBadge(); } applyChatOpen(); if (S.chatOpen) { const i = $('chatIn-out'); if (i) i.focus(); } return; }
      case 't-cursor': {
        S.localCursor = !S.localCursor; try { localStorage.setItem('bg.localCursor', S.localCursor ? '1' : '0'); } catch {}
        const w = $('stageWrap'); if (w) w.classList.toggle('nocursor', !S.localCursor);
        el.classList.toggle('on', S.localCursor);
        el.title = S.localCursor ? 'Ваш курсор над удалённым экраном: виден (нажмите, чтобы скрыть)' : 'Ваш курсор над удалённым экраном: скрыт (нажмите, чтобы показать)';
        return;
      }
      case 't-full': return setFullscreen(!S.fs);
      case 't-clip-send': return sess.clipSend();
      case 't-clip-get': return sess.clipGet();
      case 't-admin': if (!S.out.admin && !S.out.adminPending) { S.out.adminPending = true; sess.requestAdmin(); toast('Запрос отправлен — подтвердите на удалённом устройстве'); renderAll(); } return;
      case 't-spk': case 'a-spk': S.out.speakers = !S.out.speakers; sess.setSpeakers(S.out.speakers); attachStreams(); return renderAll();
      case 't-mic': case 'a-mic': { S.out.mic = !S.out.mic; const sel = $('micSel'); if (sel && sel.value) S.out.micId = sel.value; sess.setMic(S.out.mic, S.out.micId || (sel && sel.value)); return renderAll(); }
      case 'a-refresh-dev': return sess.refreshDevices();
      case 'sec-unattended': { const r = await B.cfg.set({ unattended: !S.cfg.unattended }); if (!r.ok) toast(r.error, true); await refreshCfg(); return renderAll(); }
      case 'sec-pwadmin': { toast(S.cfg.passwordAdmin ? 'Выключаем…' : 'Подтвердите включение в системном окне на этом компьютере…'); const r = await B.cfg.set({ passwordAdmin: !S.cfg.passwordAdmin }); if (!r.ok) toast(r.error, true); else if (r.warn) toast(r.warn); await refreshCfg(); return renderAll(); }
      case 'sec-autostart': await B.cfg.set({ autostart: !S.cfg.autostart }); await refreshCfg(); return renderAll();
      case 'sec-tray': await B.cfg.set({ minimizeToTray: !S.cfg.minimizeToTray }); await refreshCfg(); return renderAll();
      case 'sec-hide': await B.cfg.set({ hideOnConnect: !(S.cfg.hideOnConnect !== false) }); await refreshCfg(); return renderAll();
      case 'sec-relay': await B.cfg.set({ relayOnly: !(S.cfg.relayOnly === true) }); await refreshCfg(); return renderAll();
      case 'upd-check': return B.updater.check();
      case 'upd-update': {
        if ((S.out || S.inSess) && !confirm('Сейчас идёт сеанс. Обновление перезапустит приложение и завершит его. Продолжить?')) return;
        return B.updater.update();
      }
      case 'diag-copy': B.app.copy(diagText()); return toast('Журнал скопирован — вставьте его в чат');
      case 'diag-clear': window.__evlog = []; return renderSecurity();
      case 'sec-password': return passwordDialog();
      case 'sec-allowed': return allowedDialog();
      case 'sec-custom': {
        if (S.cfg.customServer) { S.customForm = false; const r = await B.cfg.set({ customServer: false }); if (!r.ok) toast(r.error, true); else toast('Используется встроенный сервер'); }
        else if (S.cfg.custom && S.cfg.custom.host) { const r = await B.cfg.set({ customServer: true }); if (!r.ok) toast(r.error, true); else toast('Подключаемся к вашему серверу…'); }
        else S.customForm = !S.customForm;      // адреса ещё нет — показываем поля для ввода
        await refreshCfg(); return renderAll();
      }
      case 'sv-save': {
        const r = await B.cfg.set({ server: { host: $('svHost').value, port: Number($('svPort').value), fingerprint: $('svFp').value } });
        if (!r.ok) return toast(r.error, true);
        S.customForm = false; await refreshCfg(); toast('Сохранено, переподключаемся…'); return renderAll();
      }
      case 'sv-reset': { await B.cfg.set({ server: { ...S.cfg.custom, fingerprint: '' } }); await refreshCfg(); toast('Отпечаток сброшен — запомним при следующем подключении'); return renderAll(); }
    }
  });
  $('statusChip').addEventListener('click', () => { B.app.copy(S.cfg.id); toast('ID скопирован'); });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', (e) => { e.preventDefault(); location.hash = t.dataset.view; }));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  document.addEventListener('change', (e) => {
    const t = e.target; if (!t) return;
    if (t.id === 'monSel') sess.sendMonitor(t.value);
    if (t.id === 'spkSrc' && S.out) { S.out.spkSrcPrev = S.out.spkSrc || 'system'; S.out.spkSrc = t.value; sess.setSpeakerSource(t.value, S.out.speakers); }
    if (t.id === 'micSel' && S.out) { S.out.micId = t.value; if (S.out.mic) sess.setMic(true, t.value); }   // микрофон уже включён — переключаем на лету
  });
  document.addEventListener('input', (e) => {   // ползунки громкости
    const r = e.target; if (!r || !r.dataset || !r.dataset.vol) return;
    const v = Number(r.value) / 100; S.vol[r.dataset.vol] = v; r.style.setProperty('--p', r.value + '%');
    const n = r.parentElement.querySelector('.vol-n'); if (n) n.textContent = r.value + '%';
    try { localStorage.setItem('bg.vol', JSON.stringify(S.vol)); } catch {}
    const el = $(r.dataset.vol === 'spk' ? 'aSpk' : 'aMic'); if (el) el.volume = v;
  });
  // Esc выходит из полного экрана, только если им не управляют удалённым компьютером (иначе Esc уходит туда)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.fs && !ctl()) setFullscreen(false); });
  B.win.onFullscreen((on) => { if (!on && S.fs) { S.fs = false; document.body.classList.remove('stage-full'); const b = document.querySelector('[data-action="t-full"]'); if (b) { b.classList.remove('on'); b.title = 'Во весь экран'; } } });

  // ------------------------------------------------------------------ главный цикл
  function renderAll() {
    renderTop();
    switch (S.view) {
      case 'devices': return renderDevices();
      case 'connect': return renderConnect();
      case 'session': return renderSession();
      case 'audio': return renderAudio();
      case 'security': return renderSecurity();
    }
  }
  async function refreshCfg() { S.cfg = await B.cfg.get(); S.sig = S.cfg.sig; try { S.svc = !!(B.admin.serviceStatus && (await B.admin.serviceStatus()).installed); } catch { S.svc = false; } }
  function pollPresence() { const ids = S.cfg.devices.map((d) => d.id); if (ids.length) B.sig.send({ t: 'query', ids }); }

  (async function init() {
    await refreshCfg(); S.ice = await B.sig.ice();
    B.sig.onIce((ice) => { S.ice = ice; });
    try { S.upd = await B.updater.state(); } catch { S.upd = null; }
    B.updater.onState((u) => { S.upd = u; renderTop(); const pnl = $('updPanel'); if (pnl && S.view === 'security') pnl.innerHTML = updPanelHtml(); });
    B.sig.onState((st) => { const was = S.sig.connected; S.sig = st; if (!was && st.connected) { pollPresence(); sess.flushOutbox(); } if (!st.connected) S.online = new Set(); renderAll(); });
    B.sig.onMsg((m) => {
      if (m.t === 'presence') { S.online = new Set(m.online); S.presenceAt = Date.now(); S.refreshing = false; if (S.view === 'devices') renderDevices(); return; }
      sess.onServerMessage(m);
    });
    B.app.onNavigate((v) => { location.hash = v; });
    B.app.onKick(() => sess.kickIn());
    setInterval(pollPresence, 10000);
    setInterval(() => { const b = $('diagBox'); if (b && S.view === 'security') { const t = diagText(); if (b.value !== t) { b.value = t; b.scrollTop = b.scrollHeight; } } }, 2000);
    show((location.hash || '#devices').slice(1));
    if (S.sig.connected) pollPresence();
    B.app.ready(); // подписки готовы — main может отдать накопленные сообщения
  })();
})();
