'use strict';
// Эмуляция мыши и клавиатуры через WinAPI SendInput (koffi — готовые бинарники, без компиляции).
// Клавиши передаются как физические скан-коды (KeyboardEvent.code), поэтому раскладка
// определяется настройками принимающего компьютера, а не зрителя.

// KeyboardEvent.code -> [scancode, extended]
const SC = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06],
  Digit6: [0x07], Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b], Minus: [0x0c],
  Equal: [0x0d], Backspace: [0x0e], Tab: [0x0f], KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13],
  KeyT: [0x14], KeyY: [0x15], KeyU: [0x16], KeyI: [0x17], KeyO: [0x18], KeyP: [0x19],
  BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c], ControlLeft: [0x1d], KeyA: [0x1e],
  KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22], KeyH: [0x23], KeyJ: [0x24], KeyK: [0x25],
  KeyL: [0x26], Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2a],
  Backslash: [0x2b], KeyZ: [0x2c], KeyX: [0x2d], KeyC: [0x2e], KeyV: [0x2f], KeyB: [0x30],
  KeyN: [0x31], KeyM: [0x32], Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36],
  NumpadMultiply: [0x37], AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a],
  F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f], F6: [0x40], F7: [0x41], F8: [0x42],
  F9: [0x43], F10: [0x44], NumLock: [0x45], ScrollLock: [0x46],
  Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a], Numpad4: [0x4b],
  Numpad5: [0x4c], Numpad6: [0x4d], NumpadAdd: [0x4e], Numpad1: [0x4f], Numpad2: [0x50],
  Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53], IntlBackslash: [0x56], F11: [0x57], F12: [0x58],
  // расширенные (префикс E0)
  NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], PrintScreen: [0x37, 1],
  AltRight: [0x38, 1], Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4b, 1],
  ArrowRight: [0x4d, 1], End: [0x4f, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1],
  Delete: [0x53, 1], MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
};

const MOUSE = { // button -> [downFlag, upFlag]
  0: [0x0002, 0x0004], // left
  1: [0x0020, 0x0040], // middle
  2: [0x0008, 0x0010], // right
};
const WHEEL = 0x0800, HWHEEL = 0x1000;
const KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_SCANCODE = 0x8;

function createInjector(log = () => {}) {
  const held = { keys: new Set(), buttons: new Set() };
  let api = null;
  if (process.platform === 'win32') {
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
        dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
      });
      const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
        wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
      });
      const INPUT_U = koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT });
      const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_U });
      const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
      const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
      // Форма курсора хоста: зрителю отдаём название (стрелка, «I», рука, размер…), он рисует свой курсор без задержки видео.
      const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
      const CURSORINFO = koffi.struct('CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'void *', ptScreenPos: POINT });
      const GetCursorInfo = user32.func('bool __stdcall GetCursorInfo(_Inout_ CURSORINFO *pci)');
      const LoadCursorW = user32.func('void * __stdcall LoadCursorW(void *hInstance, uintptr_t lpCursorName)');
      const SHAPES = { 32512: 'default', 32513: 'text', 32514: 'wait', 32515: 'crosshair', 32516: 'default', 32642: 'nwse-resize', 32643: 'nesw-resize', 32644: 'ew-resize', 32645: 'ns-resize', 32646: 'move', 32648: 'not-allowed', 32649: 'pointer', 32650: 'progress', 32651: 'help' };
      const shapeByHandle = new Map();
      for (const id of Object.keys(SHAPES)) { try { shapeByHandle.set(String(koffi.address(LoadCursorW(null, Number(id)))), SHAPES[id]); } catch {} }
      // Картинка курсора хоста (для зрителя): hCursor -> GetIconInfo -> GetDIBits -> BGRA.
      const gdi32 = koffi.load('gdi32.dll');
      const ICONINFO = koffi.struct('ICONINFO', { fIcon: 'int', xHotspot: 'uint32', yHotspot: 'uint32', hbmMask: 'void *', hbmColor: 'void *' });
      const BMIH = koffi.struct('BMIH', { biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32', biClrUsed: 'uint32', biClrImportant: 'uint32' });
      const GetIconInfo = user32.func('bool __stdcall GetIconInfo(void *hIcon, _Out_ ICONINFO *pii)');
      const GetDC = user32.func('void * __stdcall GetDC(void *hWnd)');
      const ReleaseDC = user32.func('int __stdcall ReleaseDC(void *hWnd, void *hDC)');
      const GetObjectW = gdi32.func('int __stdcall GetObjectW(void *h, int c, void *pv)');
      const GetDIBits = gdi32.func('int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, _Inout_ BMIH *bmi, uint32 usage)');
      const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *ho)');
      const bmpSize = (hbm) => { const b = Buffer.alloc(32); return GetObjectW(hbm, 32, b) ? { w: b.readInt32LE(4), h: b.readInt32LE(8) } : null; };
      const bmpBits = (hdc, hbm, w, h) => {   // 32 бита на пиксель, строки сверху вниз
        const buf = Buffer.alloc(w * h * 4);
        const hdr = { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: buf.length, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
        return GetDIBits(hdc, hbm, 0, h, buf, hdr, 0) ? buf : null;
      };
      /** -> { w, h, hx, hy, bgra } или null. Цветные курсоры берём как есть, монохромные («I», перекрестие) собираем из AND/XOR-маски. */
      const cursorImage = (hCur) => {
        const ii = { fIcon: 0, xHotspot: 0, yHotspot: 0, hbmMask: null, hbmColor: null };
        if (!hCur || !GetIconInfo(hCur, ii)) return null;
        const hdc = GetDC(null);
        try {
          const mk = ii.hbmMask ? bmpSize(ii.hbmMask) : null;
          const cl = ii.hbmColor ? bmpSize(ii.hbmColor) : null;
          const w = cl ? cl.w : mk && mk.w, h = cl ? cl.h : mk && mk.h / 2;
          if (!w || !h || w > 256 || h > 256) return null;
          const out = Buffer.alloc(w * h * 4);
          if (cl) {
            const col = bmpBits(hdc, ii.hbmColor, w, h); if (!col) return null;
            let hasA = false; for (let i = 3; i < col.length; i += 4) if (col[i]) { hasA = true; break; }
            const msk = hasA ? null : (mk && mk.h >= h ? bmpBits(hdc, ii.hbmMask, w, mk.h) : null);
            col.copy(out);
            if (!hasA) for (let i = 0; i < w * h; i++) out[i * 4 + 3] = msk && msk[i * 4] > 127 ? 0 : 255;
          } else {
            const m = bmpBits(hdc, ii.hbmMask, w, h * 2); if (!m) return null;
            for (let i = 0; i < w * h; i++) {
              const a = m[i * 4] > 127, x = m[(i + w * h) * 4] > 127, o = i * 4;
              if (a && !x) continue;                                // прозрачный
              const v = !a && x ? 255 : 0;                          // AND=0: чёрный/белый; AND=1,XOR=1 (инверсия) рисуем тёмным
              out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
            }
          }
          return { w, h, hx: ii.xHotspot, hy: ii.yHotspot, bgra: out };
        } finally {
          try { if (hdc) ReleaseDC(null, hdc); } catch {}
          try { if (ii.hbmMask) DeleteObject(ii.hbmMask); } catch {}
          try { if (ii.hbmColor) DeleteObject(ii.hbmColor); } catch {}
        }
      };
      const curSize = koffi.sizeof(CURSORINFO);
      const size = koffi.sizeof(INPUT);
      api = {
        mouse(flags, data = 0) {
          SendInput(1, [{ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }], size);
        },
        key(sc, ext, up) {
          const flags = KEYEVENTF_SCANCODE | (ext ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0);
          SendInput(1, [{ type: 1, u: { ki: { wVk: 0, wScan: sc, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }], size);
        },
        move(x, y) { SetCursorPos(Math.round(x), Math.round(y)); },
        shape() {
          const ci = { cbSize: curSize, flags: 0, hCursor: null, ptScreenPos: { x: 0, y: 0 } };
          if (!GetCursorInfo(ci)) return 'default';
          if (!(ci.flags & 1)) return 'default';   // курсор «скрыт» или недоступен из этого процесса — зрителю свой курсор не прячем
          return ci.hCursor ? (shapeByHandle.get(String(koffi.address(ci.hCursor))) || 'default') : 'default';
        },
        /** Положение (физические пиксели экрана), видимость и идентификатор текущего курсора. */
        info() {
          const ci = { cbSize: curSize, flags: 0, hCursor: null, ptScreenPos: { x: 0, y: 0 } };
          if (!GetCursorInfo(ci)) return null;
          const key = ci.hCursor ? String(koffi.address(ci.hCursor)) : '0';
          return { x: ci.ptScreenPos.x, y: ci.ptScreenPos.y, visible: !!(ci.flags & 1), key, shape: shapeByHandle.get(key) || 'default', handle: ci.hCursor };
        },
        image(handle) { return cursorImage(handle); },
      };
    } catch (e) { log('input: koffi недоступен —', e.message); }
  }

  const noop = () => {};
  const a = api || { mouse: noop, key: noop, move: noop, shape: () => 'default', info: () => null, image: () => null };
  return {
    available: !!api,
    move(px, py) { a.move(px, py); },
    cursorShape() { try { return a.shape(); } catch { return 'default'; } },
    cursorInfo() { try { return a.info(); } catch { return null; } },
    cursorImage(handle) { try { return a.image(handle); } catch { return null; } },
    button(btn, down) {
      const f = MOUSE[btn]; if (!f) return;
      a.mouse(down ? f[0] : f[1]);
      down ? held.buttons.add(btn) : held.buttons.delete(btn);
    },
    wheel(dx, dy) {
      const clamp = (v) => Math.max(-1200, Math.min(1200, Math.round(v)));
      if (dy) a.mouse(WHEEL, clamp(-dy * 1.2));   // DOM: вниз = +, Windows: вверх = +
      if (dx) a.mouse(HWHEEL, clamp(dx * 1.2));
    },
    key(code, down) {
      const k = SC[code]; if (!k) return false;
      a.key(k[0], !!k[1], !down);
      down ? held.keys.add(code) : held.keys.delete(code);
      return true;
    },
    // при завершении сессии отпускаем всё, что осталось зажатым
    releaseAll() {
      for (const c of [...held.keys]) this.key(c, false);
      for (const b of [...held.buttons]) this.button(b, false);
    },
  };
}
module.exports = { createInjector, SC };
