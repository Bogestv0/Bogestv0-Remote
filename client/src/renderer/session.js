/* Bogestv0 REMOTE — протокол сессии (WebRTC).
 *
 * Две роли в одном классе:
 *   host   — принимающее устройство (отдаёт экран/звук, принимает ввод);
 *   viewer — управляющее устройство.
 *
 * Безопасность:
 *  - сервер сигнализации передаёт только offer/answer/ICE; медиа и ввод идут в DTLS-SRTP, напрямую или через TURN;
 *  - пока host не выдал «granted», по каналам медиа не отправляется ничего (треки пустые);
 *  - вход по паролю: viewer доказывает знание пароля через PBKDF2+HMAC, в подпись входят nonce и
 *    ОБА отпечатка DTLS-сертификатов. Если сервер сигнализации подменит SDP (MITM), отпечатки у сторон
 *    разойдутся и проверка не пройдёт — пароль не «пробивается» через подмену;
 *  - подтверждение (ask) и права администратора спрашиваются у человека на принимающей стороне.
 */
(function () {
  'use strict';
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
  const fpOf = (sdp) => { const m = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(sdp || ''); return m ? m[1].toUpperCase() : ''; };
  const ID_RE = /^\d{9}$/;
  const dbg = (...a) => { if (window.__dbgLog) window.__dbgLog.push(performance.now().toFixed(0) + ' ' + a.join(' ')); };
  // Журнал диагностики соединения (виден в «Безопасность → Диагностика», держим последние 400 строк). Без паролей и адресов.
  const ev = (...a) => {
    try {
      const L = (window.__evlog = window.__evlog || []);
      L.push(new Date().toISOString().slice(11, 23) + ' ' + a.join(' '));
      if (L.length > 400) L.splice(0, L.length - 400);
    } catch {}
  };

  async function proof(password, nonce, fpViewer, fpHost) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(nonce), iterations: 100000 }, base, 256);
    const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${nonce}|${fpViewer}|${fpHost}`)));
  }
  function safeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
  }

  async function defaultCapture(bridge, displayId) {
    const src = await bridge.screen.source(displayId);
    if (!src) throw new Error('Нет источника экрана');
    const base = { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id };
    const video = { mandatory: { ...base, maxFrameRate: 60, maxWidth: src.width, maxHeight: src.height } };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: base }, video }); }
    catch { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video }); }
    const v = stream.getVideoTracks()[0];
    try { v.contentHint = 'detail'; } catch {}
    return { video: v, audio: stream.getAudioTracks()[0] || null, width: src.width, height: src.height, displayId: src.displayId };
  }
  async function defaultMic(deviceId) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
    return s.getAudioTracks()[0];
  }
  async function listMics() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Микрофон ${i + 1}` })); }
    catch { return []; }
  }

  class RemoteSession {
    /**
     * hooks: {
     *   getIce(), getCfg(), askUser({kind,from,name,admin}) -> Promise<bool>,
     *   onIn(ev), onOut(ev), log(entry), captureScreen?(), captureMic?(id)
     * }
     */
    constructor(bridge, hooks) {
      this.bridge = bridge; this.hooks = hooks;
      this.incoming = null; this.outgoing = null;
      this.fails = new Map();           // from -> {n, until}
      this.capture = hooks.captureScreen || ((id) => defaultCapture(bridge, id));
      this.captureMic = hooks.captureMic || defaultMic;
    }

    // ----------------------------------------------------------- сигналы с сервера
    onServerMessage(m) {
      if (m.t === 'diag') { ev('ws', m.text); return; }
      if (m.t === 'error' && m.code === 'offline') ev('sig', 'сервер: адресат не в сети', m.to);
      if (m.t === 'signal') return this.onSignal(m.from, m.name, m.data || {});
      if (m.t === 'error' && m.code === 'offline' && this.outgoing && this.outgoing.to === m.to && this.outgoing.state === 'calling') {
        this.endOut('offline');
      }
    }
    /** Отправка сигнала. Если сокет сервера в этот момент закрыт — сообщение не теряем, а держим в очереди до переподключения. */
    async sendSig(to, data) {
      const isIce = data && data.k === 'ice';
      if (!isIce) ev('sig->', data && data.k, 'to', to);
      let ok = false;
      try { ok = (await this.bridge.sig.send({ t: 'signal', to, data })) !== false; } catch { ok = false; }
      if (!ok) {
        ev('sig-> НЕ отправлено (нет связи с сервером), ждём переподключения:', data && data.k, 'to', to);
        (this.outbox = this.outbox || []).push({ to, data, t: Date.now() });
        if (this.outbox.length > 60) this.outbox.shift();
      }
      return ok;
    }
    /** Вызывается, когда связь с сервером восстановилась: досылаем то, что не ушло (не старше 25 с). */
    flushOutbox() {
      const q = (this.outbox || []).splice(0).filter((m) => Date.now() - m.t < 25000);
      if (q.length) ev('sig', 'повторная отправка из очереди:', q.length);
      for (const m of q) this.sendSig(m.to, m.data);
    }

    onSignal(from, name, d) {
      if (d.k !== 'ice') ev('sig<-', d.k, 'from', from);
      switch (d.k) {
        case 'offer': return this.hostOffer(from, name, d);
        case 'answer': return this.viewerAnswer(from, d);
        case 'reject': if (this.outgoing && this.outgoing.sid === d.sid && this.outgoing.to === from) this.endOut(String(d.reason || 'rejected')); return;
        case 'ice': {
          const s = [this.incoming, this.outgoing].find((x) => x && x.sid === d.sid && (x.from === from || x.to === from));
          if (!s || !d.cand) { if (!s) ev('sig<- ice без сессии'); return; }
          s.icesIn = (s.icesIn || 0) + 1;
          if (s.remoteSet) s.pc.addIceCandidate(d.cand).catch(() => {}); else s.pendingIce.push(d.cand);
        }
      }
    }
    flushIce(s) { s.remoteSet = true; for (const c of s.pendingIce) s.pc.addIceCandidate(c).catch(() => {}); s.pendingIce = []; }
    /** Кандидаты ICE уходят только после offer/answer: иначе получатель отбросит их как «чужую сессию». */
    outIce(s, to, cand) {
      s.icesOut = (s.icesOut || 0) + 1;
      const msg = { k: 'ice', sid: s.sid, cand: cand.toJSON() };
      if (s.sdpSent) this.sendSig(to, msg); else (s.outIceQ = s.outIceQ || []).push(msg);
    }
    sdpDone(s, to) { s.sdpSent = true; for (const m of (s.outIceQ || []).splice(0)) this.sendSig(to, m); }
    newPc() {
      const cfg = (this.hooks.getCfg && this.hooks.getCfg()) || {};
      const servers = this.hooks.getIce() || [];
      const hasTurn = servers.some((x) => [].concat(x.urls || []).some((u) => /^turns?:/i.test(u)));
      const opt = { iceServers: servers };
      // «Только через сервер»: прямые маршруты (host/srflx) отсекаются, всё идёт через TURN — устойчиво к разным NAT.
      if (cfg.relayOnly === true && hasTurn) opt.iceTransportPolicy = 'relay';
      ev('pc', 'создан; iceServers=' + servers.length, 'turn=' + hasTurn, 'policy=' + (opt.iceTransportPolicy || 'all'));
      return new RTCPeerConnection(opt);
    }
    /** Подписки на состояния WebRTC для журнала + снимок статистики через 10 секунд. */
    watchPc(s, tag) {
      const pc = s.pc; s.tag = tag; s.cands = { host: 0, srflx: 0, relay: 0, prflx: 0 };
      pc.addEventListener('icegatheringstatechange', () => ev(tag, 'gather', pc.iceGatheringState));
      pc.addEventListener('iceconnectionstatechange', () => ev(tag, 'ice', pc.iceConnectionState));
      pc.addEventListener('connectionstatechange', () => ev(tag, 'conn', pc.connectionState));
      pc.addEventListener('signalingstatechange', () => ev(tag, 'signaling', pc.signalingState));
      pc.addEventListener('icecandidateerror', (e) => ev(tag, 'icecandidateerror', e.errorCode, e.url || '', e.errorText || ''));
      pc.addEventListener('icecandidate', (e) => {
        if (!e.candidate) return ev(tag, 'сбор адресов завершён', JSON.stringify(s.cands));
        const t = e.candidate.type; if (t in s.cands) s.cands[t]++;
      });
      s.dumpTimer = setTimeout(() => this.dumpStats(s, 't+10с'), 10000);
    }
    async dumpStats(s, why) {
      if (!s || !s.pc) return;
      try {
        const rep = await s.pc.getStats(); const loc = {}; const rem = {}; const pairs = [];
        rep.forEach((r) => { if (r.type === 'local-candidate') loc[r.id] = r; else if (r.type === 'remote-candidate') rem[r.id] = r; else if (r.type === 'candidate-pair') pairs.push(r); });
        const sum = (o) => { const c = {}; Object.values(o).forEach((x) => { const k = x.candidateType + '/' + (x.protocol || '') + (x.relayProtocol ? '(' + x.relayProtocol + ')' : ''); c[k] = (c[k] || 0) + 1; }); return JSON.stringify(c); };
        ev(s.tag, 'статистика', why, 'локальные', sum(loc), 'удалённые', sum(rem), 'ice-вх', s.icesIn || 0, 'ice-исх', s.icesOut || 0, 'пар', pairs.length);
        const by = {};
        pairs.forEach((p) => {
          const l = loc[p.localCandidateId]; const r = rem[p.remoteCandidateId];
          const k = (l ? l.candidateType : '?') + '>' + (r ? r.candidateType : '?') + ' ' + p.state + (p.nominated ? ' *' : '');
          const o = (by[k] = by[k] || { n: 0, req: 0, resp: 0 }); o.n++; o.req += p.requestsSent || 0; o.resp += p.responsesReceived || 0;
        });
        ev(s.tag, 'пары', JSON.stringify(by));
      } catch (e) { ev(s.tag, 'статистика: ошибка', e && e.message); }
    }

    // ============================================================ HOST
    async hostOffer(from, name, d) {
      const reject = (reason) => { ev('host', 'reject', reason); return this.sendSig(from, { k: 'reject', sid: d.sid, reason }); };
      if (!ID_RE.test(from) || typeof d.sid !== 'string' || d.sid.length > 40 || typeof d.sdp !== 'string' || d.sdp.length > 100000) return;
      const meta = d.meta || {};
      const mode = meta.mode === 'password' ? 'password' : 'ask';
      if (this.incoming) return reject('busy');
      const f = this.fails.get(from);
      if (f && f.until > Date.now()) return reject('blocked');
      if (mode === 'password') {
        const cfg = this.hooks.getCfg();
        const okList = !cfg.allowedIds.length || cfg.allowedIds.includes(from);
        if (!cfg.unattended || !cfg.hasPassword || !okList) return reject('password-disabled');
      }
      const s = this.incoming = {
        role: 'host', sid: d.sid, from, name: String(meta.name || name || from).slice(0, 64), mode,
        wantAdmin: !!meta.admin, state: 'connecting', perms: { control: false, admin: false },
        pendingIce: [], remoteSet: false, startedAt: 0, pc: null, ctl: null, mv: null, tracks: [], nonce: rand(16),
      };
      try {
        const pc = s.pc = this.newPc();
        this.watchPc(s, 'host');
        ev('host', 'offer принят', 'режим', mode);
        pc.onicecandidate = (e) => { if (e.candidate) this.outIce(s, from, e.candidate); };
        // Каналы «заранее оговорены» (negotiated): создаются с обеих сторон с одинаковыми id и открываются симметрично.
        // Каналы, объявляемые собеседником (ondatachannel), в Chromium иногда надолго остаются в connecting.
        s.ctl = pc.createDataChannel('ctl', { negotiated: true, id: 1 });
        s.mv = pc.createDataChannel('mv', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 });
        s.mv.onmessage = (ev) => this.hostInput(s, ev.data);
        this.hostCtl(s);
        pc.onconnectionstatechange = () => this.onConnState(s, () => this.endIn('lost'));
        s.offerSdp = d.sdp;
        await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        this.flushIce(s);
        const tx = pc.getTransceivers();
        if (tx.length < 3) throw new Error('bad offer');
        for (const t of tx) t.direction = 'sendonly';
        [s.vSender, s.sSender, s.mSender] = tx.map((t) => t.sender);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        s.answerSdp = pc.localDescription.sdp;
        this.sendSig(from, { k: 'answer', sid: s.sid, sdp: pc.localDescription.sdp });
        this.sdpDone(s, from);
        ev('host', 'answer отправлен');
        s.authTimer = setTimeout(() => { if (s.state === 'connecting') this.endIn('auth-timeout'); }, 40000);
        this.hooks.onIn({ type: 'connecting', sess: this.pub(s) });
      } catch (e) {
        console.error('hostOffer', e); ev('host', 'ОШИБКА hostOffer', e && e.message); this.endIn('error');
      }
    }
    pub(s) { return { sid: s.sid, from: s.from, name: s.name, mode: s.mode, state: s.state, perms: { ...s.perms }, startedAt: s.startedAt, wantAdmin: s.wantAdmin }; }

    hostCtl(s) {
      const ch = s.ctl;
      const sendCtl = (o) => { if (ch.readyState === 'open') ch.send(JSON.stringify(o)); };
      s.sendCtl = sendCtl;
      const challenge = () => { dbg('host: challenge ->', s.sid, 'state', ch.readyState); sendCtl({ k: 'challenge', nonce: s.nonce }); };
      // Не шлём первыми: у зрителя канал в этот момент может быть ещё «connecting» и сообщение потеряется.
      // Challenge отправляем в ответ на его hello (зритель пишет, только когда его канал точно открыт).
      ch.addEventListener('open', () => ev('host', 'ctl открыт'));
      ch.onclose = () => { ev('host', 'ctl закрыт'); if (this.incoming === s) this.endIn('lost', false); };
      ch.onmessage = async (msgEv) => {
        let m; try { m = JSON.parse(msgEv.data); } catch { return; }
        if (m.k !== 'mm' && m.k !== 'mv') ev('host', 'ctl<-', m.k);
        dbg('host: ctl msg', m.k, s.sid, 'incoming-is-s', this.incoming === s, s.state);
        if (this.incoming !== s) return;
        if (s.state === 'connecting') {
          if (m.k === 'hello') { if (!s.authing) challenge(); return; }
          if (m.k !== 'auth' || s.authing) return;
          s.authing = true;
          let ok = false;
          if (s.mode === 'password') {
            const pw = await this.bridge.cfg.getSecret();
            const expect = pw ? await proof(pw, s.nonce, fpOf(s.offerSdp), fpOf(s.answerSdp)) : '';
            ok = !!pw && safeEq(expect, String(m.proof || ''));
            if (!ok) return this.authFailed(s, 'bad-password');
          } else {
            ok = await this.hooks.askUser({ kind: 'connect', from: s.from, name: s.name, admin: s.wantAdmin });
            if (this.incoming !== s) return;
            if (!ok) return this.authFailed(s, 'denied');
          }
          return this.grant(s);
        }
        if (s.state !== 'active') return;
        switch (m.k) {
          case 'admin-req': return this.hostAdmin(s);
          case 'mic': return this.hostMic(s, !!m.on, m.deviceId);
          case 'spk': return this.hostSpk(s, !!m.on);
          case 'monitor': return this.hostMonitor(s, String(m.id));
          case 'clip-set': return this.hostClipSet(s, m.text);
          case 'clip-get': return this.hostClipGet(s);
          case 'bye': return this.endIn('peer-left', false);
          default: return this.hostInput(s, m);
        }
      };
    }
    authFailed(s, reason) {
      if (reason === 'bad-password') {
        const f = this.fails.get(s.from) || { n: 0, until: 0 };
        f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60e3; f.n = 0; }
        this.fails.set(s.from, f);
      }
      this.hooks.log({ who: s.name, id: s.from, kind: reason === 'denied' ? 'denied' : 'bad-password', note: reason === 'denied' ? 'отклонено' : 'неверный пароль' });
      s.sendCtl && s.sendCtl({ k: 'denied', reason });
      this.endIn(reason, false, true); // слот освобождаем сразу; pc закроется с задержкой, чтобы 'denied' успело дойти
    }
    async grant(s) {
      try {
        clearTimeout(s.authTimer);
        const cap = s.cap = await this.capture();
        s.tracks.push(cap.video); if (cap.audio) s.tracks.push(cap.audio);
        s.spkTrack = cap.audio;
        await s.vSender.replaceTrack(cap.video);
        try {
          const p = s.vSender.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
          p.encodings[0].maxBitrate = 20e6; p.encodings[0].maxFramerate = 60; p.degradationPreference = 'maintain-resolution';
          await s.vSender.setParameters(p);
        } catch {}
        if (cap.audio) { s.spkOn = true; await s.sSender.replaceTrack(cap.audio); }
        s.state = 'active'; s.perms.control = true; s.startedAt = Date.now();
        s.monitors = await this.bridge.screen.list().catch(() => []);
        s.sendCtl({ k: 'granted', info: { monitors: s.monitors, monitor: cap.displayId || (s.monitors.find((m) => m.primary) || {}).id, w: cap.width, h: cap.height, name: this.hooks.getCfg().name, hasAudio: !!cap.audio, mics: await listMics(), control: true } });
        this.bridge.app.setActive(true);
        this.hooks.log({ who: s.name, id: s.from, kind: s.mode === 'password' ? 'password' : 'ask', note: s.mode === 'password' ? 'без подтверждения' : 'запрос подтверждён' });
        this.hooks.onIn({ type: 'active', sess: this.pub(s) });
        if (s.wantAdmin || this.autoAdmin(s)) this.hostAdmin(s);
      } catch (e) {
        console.error('grant', e); s.sendCtl && s.sendCtl({ k: 'denied', reason: 'capture-failed' }); this.endIn('capture-failed', false);
      }
    }
    /** Владелец включил «вход по паролю сразу с правами администратора» — для входа по паролю отдельный запрос не нужен. */
    autoAdmin(s) { const c = (this.hooks.getCfg && this.hooks.getCfg()) || {}; return s.mode === 'password' && c.passwordAdmin === true; }
    async hostAdmin(s) {
      if (s.perms.admin || s.adminBusy) return;
      s.adminBusy = true;
      try {
        // по умолчанию — всегда отдельный явный запрос, даже при входе по паролю; без запроса только при включённом режиме владельца
        const auto = this.autoAdmin(s);
        const ok = auto || await this.hooks.askUser({ kind: 'admin', from: s.from, name: s.name, admin: true });
        if (this.incoming !== s) return;
        if (!ok) { s.sendCtl({ k: 'admin', ok: false, reason: 'denied' }); this.hooks.log({ who: s.name, id: s.from, kind: 'admin-denied', note: 'админ-доступ отклонён' }); return; }
        const r = await this.bridge.admin.start({ from: s.from, name: s.name, silent: auto });
        if (this.incoming !== s) { if (r.ok) { this.stopSecure(s); this.bridge.admin.stop(); } return; }
        s.perms.admin = !!r.ok;
        if (r.ok && r.system) this.startSecure(s);
        s.sendCtl({ k: 'admin', ok: !!r.ok, reason: r.error || '' });
        this.hooks.log({ who: s.name, id: s.from, kind: r.ok ? 'admin' : 'admin-failed', note: r.ok ? (auto ? 'админ-доступ выдан автоматически (вход по паролю)' : 'админ-доступ подтверждён') : (r.error || 'не удалось') });
        this.hooks.onIn({ type: 'admin', sess: this.pub(s) });
      } finally { s.adminBusy = false; }
    }
    /** Защищённый рабочий стол (UAC/блокировка): Chromium его не захватывает, поэтому подменяем видеотрек
     *  на canvas, в который рисуются кадры от SYSTEM-помощника; на обычном столе возвращаем настоящий захват. */
    startSecure(s) {
      if (s.secure || !this.bridge.admin.onDesktop) return;
      const sec = s.secure = { canvas: document.createElement('canvas'), track: null, on: false, offs: [] };
      sec.canvas.width = 640; sec.canvas.height = 360;
      const ctx = sec.canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 360);
      sec.track = sec.canvas.captureStream(15).getVideoTracks()[0];
      sec.offs.push(this.bridge.admin.onFrame((f) => {
        if (!sec.on) return;
        const px = new Uint8ClampedArray(f.data.buffer ? f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) : f.data);
        if (px.length !== f.w * f.h * 4) return;
        if (sec.canvas.width !== f.w || sec.canvas.height !== f.h) { sec.canvas.width = f.w; sec.canvas.height = f.h; }
        ctx.putImageData(new ImageData(px, f.w, f.h), 0, 0);
      }));
      sec.offs.push(this.bridge.admin.onDesktop(async (d) => {
        if (this.incoming !== s || d.gone) { return; }
        try {
          if (d.secure && !sec.on) { sec.on = true; await s.vSender.replaceTrack(sec.track); this.hooks.log({ who: s.name, id: s.from, kind: 'admin', note: 'защищённый рабочий стол (UAC)' }); }
          else if (!d.secure && sec.on) { sec.on = false; if (s.cap && s.cap.video) await s.vSender.replaceTrack(s.cap.video); }
        } catch (e) { console.error('secure swap', e); }
      }));
    }
    stopSecure(s) {
      const sec = s && s.secure; if (!sec) return;
      s.secure = null; sec.on = false;
      for (const o of sec.offs) { try { o && o(); } catch {} }
      try { sec.track.stop(); } catch {}
      if (s.cap && s.cap.video && s.vSender) { try { s.vSender.replaceTrack(s.cap.video); } catch {} }
    }
    async hostMic(s, on, deviceId) {
      try {
        if (s.micTrack) { s.micTrack.stop(); s.micTrack = null; }
        if (on) { s.micTrack = await this.captureMic(deviceId); s.tracks.push(s.micTrack); await s.mSender.replaceTrack(s.micTrack); }
        else await s.mSender.replaceTrack(null);
        s.sendCtl({ k: 'mic', on, ok: true });
      } catch (e) { s.sendCtl({ k: 'mic', on: false, ok: false, reason: String(e.message || e) }); }
    }
    async hostSpk(s, on) {
      if (!s.spkTrack) return;
      s.spkOn = on; await s.sSender.replaceTrack(on ? s.spkTrack : null);
    }
    async hostMonitor(s, id) {
      try {
        if (!(s.monitors || []).some((x) => x.id === id)) throw new Error('нет такого монитора');
        const cap = await this.capture(id);
        if (cap.audio) cap.audio.stop();            // звук остаётся прежним, второй захват не нужен
        const old = s.cap && s.cap.video; await s.vSender.replaceTrack(cap.video);
        if (old) { old.stop(); s.tracks = s.tracks.filter((t) => t !== old); }
        s.tracks.push(cap.video); s.cap = { ...s.cap, video: cap.video, width: cap.width, height: cap.height, displayId: cap.displayId };
        s.sendCtl({ k: 'monitor', ok: true, id, w: cap.width, h: cap.height });
      } catch (e) { s.sendCtl({ k: 'monitor', ok: false, id, reason: String(e.message || e) }); }
    }
    hostClipSet(s, text) {
      if (typeof text !== 'string' || text.length > 200000) return s.sendCtl({ k: 'clip-ack', ok: false });
      this.bridge.app.copy(text);
      this.bridge.app.notify('Bogestv0 REMOTE', `${s.name} записал текст в буфер обмена этого компьютера (${text.length} симв.)`);
      this.hooks.log({ who: s.name, id: s.from, kind: 'clip', note: 'запись в буфер обмена' });
      s.sendCtl({ k: 'clip-ack', ok: true });
    }
    async hostClipGet(s) {
      const text = await this.bridge.app.readClipboard();
      this.bridge.app.notify('Bogestv0 REMOTE', `${s.name} прочитал текст из буфера обмена этого компьютера`);
      this.hooks.log({ who: s.name, id: s.from, kind: 'clip', note: 'чтение буфера обмена' });
      s.sendCtl({ k: 'clip', text: String(text || '').slice(0, 200000) });
    }
    hostInput(s, raw) {
      if (s.state !== 'active' || !s.perms.control) return;
      let m = raw; if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch { return; } }
      const n = (v) => typeof v === 'number' && isFinite(v);
      switch (m.k) {
        case 'mm': if (n(m.x) && n(m.y)) this.bridge.input.send({ k: 'mm', x: m.x, y: m.y }); break;
        case 'md': case 'mu': if (n(m.x) && n(m.y) && [0, 1, 2].includes(m.b)) this.bridge.input.send({ k: m.k, b: m.b, x: m.x, y: m.y }); break;
        case 'wh': if (n(m.dx) && n(m.dy)) this.bridge.input.send({ k: 'wh', dx: m.dx, dy: m.dy }); break;
        case 'kd': case 'ku': if (typeof m.code === 'string' && m.code.length < 24) this.bridge.input.send({ k: m.k, code: m.code }); break;
      }
    }
    onConnState(s, onLost) {
      if (s.state === 'ended') return;   // события «закрыто» от старого соединения не должны трогать новую сессию
      const st = s.pc.connectionState;
      clearTimeout(s.discTimer);
      if (st === 'failed' || st === 'closed') onLost();
      else if (st === 'disconnected') s.discTimer = setTimeout(() => { if (s.state !== 'ended') onLost(); }, 8000);
    }
    /** Завершить входящую сессию. */
    endIn(reason, tellPeer = true, silentLog = false) {
      const s = this.incoming; if (!s) return;
      this.incoming = null;
      ev('host', 'сессия завершена:', reason);
      this.dumpStats(s, 'конец:' + reason);
      clearTimeout(s.authTimer); clearTimeout(s.discTimer); clearTimeout(s.dumpTimer);
      if (tellPeer && s.sendCtl) s.sendCtl({ k: 'bye', reason });
      else if (!s.sendCtl && s.from) this.sendSig(s.from, { k: 'reject', sid: s.sid, reason });
      const wasActive = s.state === 'active';
      s.state = 'ended';
      s.tracks.forEach((t) => { try { t.stop(); } catch {} });
      setTimeout(() => { try { s.pc && s.pc.close(); } catch {} }, 200);
      this.bridge.input.release();
      if (s.perms.admin) { this.stopSecure(s); this.bridge.admin.stop(); }
      this.bridge.app.setActive(false);
      if (wasActive) this.hooks.log({ who: s.name, id: s.from, kind: 'ended', note: 'сессия завершена' });
      this.hooks.onIn({ type: 'ended', sess: this.pub(s), reason });
    }
    kickIn() { this.endIn('kicked'); }

    // ============================================================ VIEWER
    async connect(id, opts) {
      if (!ID_RE.test(id)) throw new Error('bad id');
      if (this.outgoing) throw new Error('busy');
      const s = this.outgoing = {
        role: 'viewer', sid: rand(8), to: id, mode: opts.mode === 'password' ? 'password' : 'ask', password: opts.password || '',
        wantAdmin: !!opts.admin, state: 'calling', pendingIce: [], remoteSet: false, info: null, perms: { admin: false },
      };
      const emit = (type, extra) => this.hooks.onOut({ type, to: id, ...extra });
      try {
        const pc = s.pc = this.newPc();
        this.watchPc(s, 'viewer');
        ev('viewer', 'подключение к', id, 'режим', s.mode);
        s.ctl = pc.createDataChannel('ctl', { negotiated: true, id: 1 });
        s.mv = pc.createDataChannel('mv', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 });
        s.tx = [pc.addTransceiver('video', { direction: 'recvonly' }), pc.addTransceiver('audio', { direction: 'recvonly' }), pc.addTransceiver('audio', { direction: 'recvonly' })];
        pc.ontrack = (e) => {
          const ms = new MediaStream([e.track]);
          const i = s.tx.indexOf(e.transceiver);
          emit('track', { which: i === 0 ? 'video' : i === 1 ? 'speakers' : 'mic', stream: ms });
        };
        pc.onicecandidate = (e) => { if (e.candidate) this.outIce(s, id, e.candidate); };
        pc.onconnectionstatechange = () => this.onConnState(s, () => this.endOut('lost'));
        this.viewerCtl(s);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        s.offerSdp = pc.localDescription.sdp;
        this.sendSig(id, { k: 'offer', sid: s.sid, sdp: pc.localDescription.sdp, meta: { name: this.hooks.getCfg().name, mode: s.mode, admin: s.wantAdmin } });
        this.sdpDone(s, id);
        ev('viewer', 'offer отправлен');
        s.timeout = setTimeout(() => { if (s.state !== 'active') this.endOut('timeout'); }, 45000);
        emit('state', { state: 'calling' });
      } catch (e) { console.error('connect', e); ev('viewer', 'ОШИБКА connect', e && e.message); this.endOut('error'); }
      return s.sid;
    }
    async viewerAnswer(from, d) {
      const s = this.outgoing;
      if (!s || s.sid !== d.sid || s.to !== from || s.remoteSet) { ev('viewer', 'answer проигнорирован:', !s ? 'нет исходящей сессии' : s.sid !== d.sid ? 'другой sid' : s.to !== from ? 'другой ID' : 'повторный'); return; }
      s.answerSdp = d.sdp; // запоминаем ДО применения: канал может открыться раньше, чем завершится setRemoteDescription
      try { await s.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); ev('viewer', 'answer применён'); this.flushIce(s); }
      catch (e) { console.error('answer', e); ev('viewer', 'ОШИБКА answer', e && e.message); this.endOut('error'); }
    }
    viewerCtl(s) {
      const send = (o) => s.ctl.readyState === 'open' && s.ctl.send(JSON.stringify(o));
      s.send = send;
      const hello = () => { if (this.outgoing === s && !s.challenged) send({ k: 'hello' }); };
      s.ctl.onopen = () => { ev('viewer', 'ctl открыт'); hello(); let n = 0; const t = setInterval(() => { if (s.challenged || this.outgoing !== s || ++n > 8) clearInterval(t); else hello(); }, 1500); };
      s.ctl.onclose = () => { ev('viewer', 'ctl закрыт'); if (this.outgoing === s) this.endOut('lost', false); };
      s.ctl.onmessage = async (msgEv) => {
        let m; try { m = JSON.parse(msgEv.data); } catch { return; }
        ev('viewer', 'ctl<-', m.k);
        dbg('viewer: ctl msg', m.k, s.sid, 'outgoing-is-s', this.outgoing === s);
        if (this.outgoing !== s) return;
        switch (m.k) {
          case 'challenge': {
            if (s.challenged) return; s.challenged = true;
            if (s.mode === 'password') {
              const p = await proof(s.password, String(m.nonce), fpOf(s.offerSdp), fpOf(s.answerSdp));
              send({ k: 'auth', proof: p });
            } else send({ k: 'auth' });
            this.hooks.onOut({ type: 'state', to: s.to, state: s.mode === 'ask' ? 'waiting-approval' : 'authenticating' });
            return;
          }
          case 'granted':
            s.state = 'active'; s.info = m.info || {}; clearTimeout(s.timeout);
            this.startStats(s);
            this.hooks.onOut({ type: 'granted', to: s.to, info: s.info });
            if (s.wantAdmin) { this.hooks.onOut({ type: 'admin-pending', to: s.to }); }
            return;
          case 'denied': return this.endOut(String(m.reason || 'denied'), false);
          case 'admin': s.perms.admin = !!m.ok; return this.hooks.onOut({ type: 'admin', to: s.to, ok: !!m.ok, reason: m.reason || '' });
          case 'monitor': return this.hooks.onOut({ type: 'monitor', to: s.to, ok: !!m.ok, id: m.id, w: m.w, h: m.h, reason: m.reason || '' });
          case 'clip': return this.hooks.onOut({ type: 'clip', to: s.to, text: String(m.text || '') });
          case 'clip-ack': return this.hooks.onOut({ type: 'clip-ack', to: s.to, ok: !!m.ok });
          case 'mic': return this.hooks.onOut({ type: 'mic', to: s.to, on: !!m.on, ok: m.ok !== false, reason: m.reason || '' });
          case 'bye': return this.endOut(String(m.reason || 'ended'), false);
        }
      };
    }
    startStats(s) {
      let last = { bytes: 0, ts: 0 };
      s.statsTimer = setInterval(async () => {
        try {
          const rep = await s.pc.getStats(); let fps = 0, rtt = 0, route = '';
          let bytes = 0; const pairs = []; const locals = {};
          rep.forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') { fps = r.framesPerSecond || 0; bytes = r.bytesReceived || 0; }
            if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairs.push(r);
            if (r.type === 'local-candidate') locals[r.id] = r;
          });
          const p = pairs[0];
          if (p) { rtt = Math.round((p.currentRoundTripTime || 0) * 1000); const l = locals[p.localCandidateId]; route = l ? (l.candidateType === 'relay' ? 'через сервер' : 'напрямую') : ''; }
          const now = performance.now(); const mbps = last.ts ? ((bytes - last.bytes) * 8) / 1e6 / ((now - last.ts) / 1000) : 0;
          last = { bytes, ts: now };
          this.hooks.onOut({ type: 'stats', to: s.to, fps: Math.round(fps), rtt, mbps: Math.max(0, mbps), route });
        } catch {}
      }, 1000);
    }
    sendInput(ev) {
      const s = this.outgoing; if (!s || s.state !== 'active') return;
      if (ev.k === 'mm' && s.mv.readyState === 'open') s.mv.send(JSON.stringify(ev)); else s.send(ev);
    }
    sendMonitor(id) { const s = this.outgoing; if (s && s.state === 'active') s.send({ k: 'monitor', id: String(id) }); }
    async clipSend() { const s = this.outgoing; if (!s || s.state !== 'active') return; const text = await this.bridge.app.readClipboard(); if (!text) return this.hooks.onOut({ type: 'clip-empty', to: s.to }); s.send({ k: 'clip-set', text }); }
    clipGet() { const s = this.outgoing; if (s && s.state === 'active') s.send({ k: 'clip-get' }); }
    requestAdmin() { const s = this.outgoing; if (s && s.state === 'active') s.send({ k: 'admin-req' }); }
    setMic(on, deviceId) { const s = this.outgoing; if (s && s.state === 'active') s.send({ k: 'mic', on, deviceId }); }
    setSpeakers(on) { const s = this.outgoing; if (s && s.state === 'active') s.send({ k: 'spk', on }); }
    hangup() { this.endOut('kicked-by-me'); }
    endOut(reason, tellPeer = true) {
      const s = this.outgoing; if (!s) return;
      this.outgoing = null;
      ev('viewer', 'сессия завершена:', reason);
      this.dumpStats(s, 'конец:' + reason);
      clearTimeout(s.timeout); clearTimeout(s.discTimer); clearInterval(s.statsTimer); clearTimeout(s.dumpTimer);
      if (tellPeer) { if (s.state === 'active' || s.state === 'calling') { try { s.send && s.send({ k: 'bye', reason }); } catch {} } }
      const was = s.state; s.state = 'ended';
      setTimeout(() => { try { s.pc && s.pc.close(); } catch {} }, 200);
      this.hooks.onOut({ type: 'ended', to: s.to, reason, wasActive: was === 'active' });
    }
  }
  RemoteSession.proof = proof;
  RemoteSession.fpOf = fpOf;
  window.RemoteSession = RemoteSession;
})();
