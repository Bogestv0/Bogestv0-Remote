'use strict';
/**
 * Привязки к WinAPI (koffi) для службы и SYSTEM-помощника.
 * Структуры объявляются на любой ОС (чтобы тестами проверять размеры), функции грузятся только в Windows.
 */
const koffi = require('koffi');

const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32', lpReserved: 'void *', lpDesktop: 'str16', lpTitle: 'str16',
  dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32', dwXCountChars: 'uint32', dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32', dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
  lpReserved2: 'void *', hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
});
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', { hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32' });
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32',
  biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32', biClrUsed: 'uint32', biClrImportant: 'uint32',
});
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: 'uint32' });
const sizes = () => ({ STARTUPINFOW: koffi.sizeof(STARTUPINFOW), PROCESS_INFORMATION: koffi.sizeof(PROCESS_INFORMATION), BITMAPINFOHEADER: koffi.sizeof(BITMAPINFOHEADER), BITMAPINFO: koffi.sizeof(BITMAPINFO) });

const utf16z = (s) => Buffer.from(String(s) + '\0', 'utf16le');
const MB = { YESNO: 0x4, ICONWARNING: 0x30, DEFBUTTON2: 0x100, SETFOREGROUND: 0x10000, TOPMOST: 0x40000 };
const IDYES = 6;

// ------------------------------------------------------------------ для службы (SYSTEM, сессия 0)
function createServiceApi() {
  const k32 = koffi.load('kernel32.dll'), adv = koffi.load('advapi32.dll'), wts = koffi.load('wtsapi32.dll');
  const WTSGetActiveConsoleSessionId = k32.func('uint32 __stdcall WTSGetActiveConsoleSessionId()');
  const ProcessIdToSessionId = k32.func('bool __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *sessionId)');
  const GetCurrentProcess = k32.func('void * __stdcall GetCurrentProcess()');
  const CloseHandle = k32.func('bool __stdcall CloseHandle(void *h)');
  const OpenProcessToken = adv.func('bool __stdcall OpenProcessToken(void *proc, uint32 access, _Out_ void **token)');
  const DuplicateTokenEx = adv.func('bool __stdcall DuplicateTokenEx(void *token, uint32 access, void *attrs, int impLevel, int tokenType, _Out_ void **newToken)');
  const SetTokenInformation = adv.func('bool __stdcall SetTokenInformation(void *token, int cls, uint32 *info, uint32 len)');
  const CreateProcessAsUserW = adv.func('bool __stdcall CreateProcessAsUserW(void *token, void *app, void *cmdline, void *pa, void *ta, bool inherit, uint32 flags, void *env, str16 cwd, STARTUPINFOW *si, _Out_ PROCESS_INFORMATION *pi)');
  const WTSSendMessageW = wts.func('bool __stdcall WTSSendMessageW(void *server, uint32 session, str16 title, uint32 titleBytes, str16 msg, uint32 msgBytes, uint32 style, uint32 timeout, _Out_ uint32 *response, bool wait)');

  return {
    activeSession: () => { const s = WTSGetActiveConsoleSessionId(); return s === 0xFFFFFFFF ? null : s; },
    sessionOfPid(pid) { const out = [0]; return ProcessIdToSessionId(pid, out) ? out[0] : null; },
    /** Системное окно «Да/Нет» в сессии пользователя. true только при явном «Да». */
    consent(session, title, message, timeoutSec) {
      return new Promise((resolve) => {
        const resp = [0];
        WTSSendMessageW.async(null, session, title, title.length * 2, message, message.length * 2,
          MB.YESNO | MB.ICONWARNING | MB.DEFBUTTON2 | MB.SETFOREGROUND | MB.TOPMOST, timeoutSec, resp, true,
          (err, ok) => resolve(!err && !!ok && resp[0] === IDYES));
      });
    },
    /** Запуск процесса с токеном SYSTEM (копия токена службы) в указанной сессии, на интерактивном рабочем столе. */
    spawnInSession({ session, exe, args, env }) {
      const tok = [null], dup = [null];
      if (!OpenProcessToken(GetCurrentProcess(), 0xF01FF, tok)) throw new Error('OpenProcessToken failed');
      try {
        if (!DuplicateTokenEx(tok[0], 0x02000000, null, 2, 1, dup)) throw new Error('DuplicateTokenEx failed');
        if (!SetTokenInformation(dup[0], 12 /* TokenSessionId */, [session], 4)) throw new Error('SetTokenInformation(session) failed');
        const q = (s) => `"${s}"`;
        const cmd = utf16z([q(exe), ...args.map(q)].join(' '));
        const envBlock = Buffer.from(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0\0', 'utf16le');
        const si = { cb: koffi.sizeof(STARTUPINFOW), lpReserved: null, lpDesktop: 'winsta0\\default', lpTitle: null, dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0, dwFlags: 1 /* USESHOWWINDOW */, wShowWindow: 0 /* SW_HIDE */, cbReserved2: 0, lpReserved2: null, hStdInput: null, hStdOutput: null, hStdError: null };
        const pi = {};
        const flags = 0x00000400 /* CREATE_UNICODE_ENVIRONMENT */ | 0x08000000 /* CREATE_NO_WINDOW */;
        if (!CreateProcessAsUserW(dup[0], null, cmd, null, null, false, flags, envBlock, null, si, pi)) throw new Error('CreateProcessAsUserW failed');
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        return { pid: pi.dwProcessId };
      } finally { if (dup[0]) CloseHandle(dup[0]); if (tok[0]) CloseHandle(tok[0]); }
    },
  };
}

// ------------------------------------------------------------------ для SYSTEM-помощника (в сессии пользователя)
function createDesktopApi() {
  const u32 = koffi.load('user32.dll'), g32 = koffi.load('gdi32.dll');
  const SetProcessDPIAware = u32.func('bool __stdcall SetProcessDPIAware()');
  const OpenInputDesktop = u32.func('void * __stdcall OpenInputDesktop(uint32 flags, bool inherit, uint32 access)');
  const SetThreadDesktop = u32.func('bool __stdcall SetThreadDesktop(void *desk)');
  const CloseDesktop = u32.func('bool __stdcall CloseDesktop(void *desk)');
  const GetUserObjectInformationW = u32.func('bool __stdcall GetUserObjectInformationW(void *h, int index, void *buf, uint32 len, _Out_ uint32 *needed)');
  const GetSystemMetrics = u32.func('int __stdcall GetSystemMetrics(int i)');
  const GetDC = u32.func('void * __stdcall GetDC(void *wnd)');
  const ReleaseDC = u32.func('int __stdcall ReleaseDC(void *wnd, void *dc)');
  const CreateCompatibleDC = g32.func('void * __stdcall CreateCompatibleDC(void *dc)');
  const CreateCompatibleBitmap = g32.func('void * __stdcall CreateCompatibleBitmap(void *dc, int w, int h)');
  const SelectObject = g32.func('void * __stdcall SelectObject(void *dc, void *obj)');
  const DeleteObject = g32.func('bool __stdcall DeleteObject(void *obj)');
  const DeleteDC = g32.func('bool __stdcall DeleteDC(void *dc)');
  const SetStretchBltMode = g32.func('int __stdcall SetStretchBltMode(void *dc, int mode)');
  const StretchBlt = g32.func('bool __stdcall StretchBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, int sw, int sh, uint32 rop)');
  const GetDIBits = g32.func('int __stdcall GetDIBits(void *dc, void *bmp, uint32 start, uint32 lines, void *bits, BITMAPINFO *bi, uint32 usage)');

  let cur = null, curName = '';
  const nameOf = (h) => { const buf = Buffer.alloc(512), need = [0]; return GetUserObjectInformationW(h, 2 /* UOI_NAME */, buf, 512, need) ? buf.toString('utf16le').split('\0')[0] : ''; };
  return {
    dpiAware: () => SetProcessDPIAware(),
    /** Привязывает поток к рабочему столу, который сейчас получает ввод (Default / Winlogon для UAC и блокировки). */
    sync() {
      const h = OpenInputDesktop(0, false, 0x10000000 /* GENERIC_ALL */);
      if (!h) return { name: curName, changed: false };
      const name = nameOf(h);
      if (name !== curName || !cur) {
        if (SetThreadDesktop(h)) { if (cur) CloseDesktop(cur); cur = h; const changed = name !== curName; curName = name; return { name, changed }; }
        CloseDesktop(h); return { name: curName, changed: false };
      }
      CloseDesktop(h); return { name: curName, changed: false };
    },
    /** Снимок основного монитора текущего рабочего стола → RGBA, с уменьшением до maxW. */
    capture(maxW = 1280) {
      const sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
      if (!sw || !sh) return null;
      const dw = Math.min(sw, maxW), dh = Math.max(1, Math.round((sh * dw) / sw));
      const dc = GetDC(null); if (!dc) return null;
      const mem = CreateCompatibleDC(dc), bmp = CreateCompatibleBitmap(dc, dw, dh), old = SelectObject(mem, bmp);
      try {
        SetStretchBltMode(mem, 4 /* HALFTONE */);
        if (!StretchBlt(mem, 0, 0, dw, dh, dc, 0, 0, sw, sh, 0x00CC0020 | 0x40000000 /* SRCCOPY|CAPTUREBLT */)) return null;
        const bits = Buffer.alloc(dw * dh * 4);
        const bi = { bmiHeader: { biSize: 40, biWidth: dw, biHeight: -dh, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 }, bmiColors: 0 };
        if (!GetDIBits(mem, bmp, 0, dh, bits, bi, 0)) return null;
        const px = new Uint32Array(bits.buffer, bits.byteOffset, dw * dh);
        for (let i = 0; i < px.length; i++) { const v = px[i]; px[i] = 0xFF000000 | (v & 0xFF00) | ((v & 0xFF) << 16) | ((v >> 16) & 0xFF); } // BGRA → RGBA, alpha=255
        return { w: dw, h: dh, rgba: bits };
      } finally { SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); ReleaseDC(null, dc); }
    },
  };
}
module.exports = { sizes, utf16z, createServiceApi, createDesktopApi, IDYES };
