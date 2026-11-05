'use strict';
// Сравнение версий вида 0.1.5 / v0.2.0 (предрелизные суффиксы игнорируются). Возвращает -1, 0 или 1.
function parse(v) { return String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0); }
function cmpVer(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
module.exports = { cmpVer };
