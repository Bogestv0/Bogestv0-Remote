'use strict';
// Разбор потока от помощника: JSON-строки и «кадры» = JSON-заголовок {"ev":"frame","len":N} + ровно N байт.
const { EventEmitter } = require('events');

class StreamParser extends EventEmitter {
  constructor(maxFrame = 16 * 1024 * 1024) { super(); this.buf = Buffer.alloc(0); this.need = null; this.hdr = null; this.maxFrame = maxFrame; }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.need !== null) {                       // ждём тело кадра
        if (this.buf.length < this.need) return;
        const body = this.buf.subarray(0, this.need); this.buf = this.buf.subarray(this.need);
        const hdr = this.hdr; this.hdr = null; this.need = null;
        this.emit('frame', hdr, Buffer.from(body));
        continue;
      }
      const i = this.buf.indexOf(0x0a);
      if (i < 0) { if (this.buf.length > 65536) { this.buf = Buffer.alloc(0); this.emit('error', new Error('line too long')); } return; }
      const line = this.buf.subarray(0, i).toString('utf8'); this.buf = this.buf.subarray(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m && m.ev === 'frame') {
        if (!Number.isInteger(m.len) || m.len < 0 || m.len > this.maxFrame) { this.emit('error', new Error('bad frame length')); this.buf = Buffer.alloc(0); return; }
        this.hdr = m; this.need = m.len;
      } else this.emit('line', m);
    }
  }
}
const frameHeader = (w, h, len) => Buffer.from(JSON.stringify({ ev: 'frame', w, h, len }) + '\n');
module.exports = { StreamParser, frameHeader };
