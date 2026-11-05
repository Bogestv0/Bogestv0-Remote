'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const on = (ch, cb) => { const f = (_e, ...a) => cb(...a); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };

contextBridge.exposeInMainWorld('bridge', {
  cfg: {
    get: () => ipcRenderer.invoke('cfg:get'),
    set: (patch) => ipcRenderer.invoke('cfg:set', patch),
    setPassword: (pw) => ipcRenderer.invoke('cfg:setPassword', pw),
    getSecret: () => ipcRenderer.invoke('cfg:getSecret'),
  },
  dev: {
    savePw: (id, pw, admin) => ipcRenderer.invoke('dev:savePw', id, pw, admin),
    getPw: (id) => ipcRenderer.invoke('dev:getPw', id),
    clearPw: (id) => ipcRenderer.invoke('dev:clearPw', id),
  },
  sig: {
    send: (o) => ipcRenderer.invoke('sig:send', o),
    reconnect: () => ipcRenderer.invoke('sig:reconnect'),
    state: () => ipcRenderer.invoke('sig:state'),
    ice: () => ipcRenderer.invoke('sig:ice'),
    onMsg: (cb) => on('sig:msg', cb),
    onState: (cb) => on('sig:state', cb),
    onIce: (cb) => on('sig:ice', cb),
  },
  updater: {
    state: () => ipcRenderer.invoke('updater:state'),
    check: () => ipcRenderer.invoke('updater:check'),
    update: () => ipcRenderer.invoke('updater:update'),
    onState: (cb) => on('updater:state', cb),
  },
  log: { add: (e) => ipcRenderer.invoke('log:add', e) },
  app: {
    attention: (title, body) => ipcRenderer.invoke('app:attention', { title, body }),
    chatNotify: (title, body) => ipcRenderer.invoke('app:chatNotify', { title, body }),
    notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
    setActive: (v) => ipcRenderer.invoke('app:setActive', !!v),
    copy: (t) => ipcRenderer.invoke('app:copy', String(t)),
    readClipboard: () => ipcRenderer.invoke('app:readClipboard'),
    onNavigate: (cb) => on('nav', cb),
    onKick: (cb) => on('app:kick', cb),
    ready: () => ipcRenderer.invoke('app:ready'),
  },
  win: { hide: () => ipcRenderer.send('win:hide'), setFullScreen: (on) => ipcRenderer.send('win:fs', !!on), onFullscreen: (cb) => on('win:fs-state', cb) },
  screen: { source: (id) => ipcRenderer.invoke('screen:source', id), list: () => ipcRenderer.invoke('screen:list') },
  input: { send: (ev) => ipcRenderer.send('input:ev', ev), release: () => ipcRenderer.send('input:release') },
  admin: { start: (meta) => ipcRenderer.invoke('admin:start', meta), stop: () => ipcRenderer.invoke('admin:stop'), serviceStatus: () => ipcRenderer.invoke('service:status'), capture: (on) => ipcRenderer.send('helper:capture', on), onDesktop: (cb) => on('helper:desktop', cb), onFrame: (cb) => on('helper:frame', cb) },
});
