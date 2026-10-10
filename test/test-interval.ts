// ============================================================
// test-interval.ts — Interval: «язык интервалов» (VRackDB-совместимо, в мс)
// ============================================================

import { Interval } from '../src/Interval.ts';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const now = 1_700_000_000_000; // фиксированное 'now' — детерминированные тесты
const H = 3_600_000;
const D = 86_400_000;

// --------------------------------------------------
// parseInterval: единицы → миллисекунды
// --------------------------------------------------
assert(Interval.parseInterval('1s') === 1_000, `1s (факт ${Interval.parseInterval('1s')})`);
assert(Interval.parseInterval('90s') === 90_000, '90s');
assert(Interval.parseInterval('1m') === 60_000, '1m');
assert(Interval.parseInterval('10m') === 600_000, '10m');
assert(Interval.parseInterval('1h') === H, '1h');
assert(Interval.parseInterval('1d') === D, '1d');
assert(Interval.parseInterval('1w') === 7 * D, '1w = 7d');
assert(Interval.parseInterval('1mon') === 30 * D, '1mon = 30d');
assert(Interval.parseInterval('1y') === 365 * D, '1y = 365d');
assert(Interval.parseInterval('900') === 900, 'просто число = мс');

let threw = false;
try { Interval.parseInterval('1x'); } catch { threw = true; }
assert(threw, 'неизвестная единица → RangeError');
threw = false;
try { Interval.parseInterval('abc'); } catch { threw = true; }
assert(threw, 'мусор → RangeError');

// --------------------------------------------------
// partOfPeriod: относительные моменты
// --------------------------------------------------
assert(Interval.partOfPeriod('now', now) === now, 'now');
assert(Interval.partOfPeriod('now-1d', now) === now - D, 'now-1d');
assert(Interval.partOfPeriod('now+1h', now) === now + H, 'now+1h');
assert(Interval.partOfPeriod('now-1h-1m', now) === now - H - 60_000, 'now-1h-1m');
assert(Interval.partOfPeriod('now+1h-1m', now) === now + H - 60_000, 'now+1h-1m');
assert(Interval.partOfPeriod('10d', now) === 10 * D, '10d → 10d (мс)');
assert(Interval.partOfPeriod('1700000000000', now) === 1_700_000_000_000, 'абсолютное время (мс)');

// --------------------------------------------------
// period: 'start:end' → [start, end]
// --------------------------------------------------
{
  const [ps, pe] = Interval.period('now-7d:now', now);
  assert(ps === now - 7 * D && pe === now, `now-7d:now (факт ${ps}..${pe})`);
  const [rs, re] = Interval.period('now-2h-15m:now', now);
  assert(rs === now - 2 * H - 900_000 && re === now, 'now-2h-15m:now');
  const [as0, ae0] = Interval.period('1700000000000:1700000100000', now);
  assert(as0 === 1_700_000_000_000 && ae0 === 1_700_000_100_000, 'абсолютный период');
}
threw = false;
try { Interval.period('now-1d'); } catch { threw = true; }
assert(threw, 'период без «:» → RangeError');
threw = false;
try { Interval.period('a:b:c', now); } catch { threw = true; }
assert(threw, 'период с двумя «:» → RangeError');

// --------------------------------------------------
// period: (start, end) — две границы (число мс или строка)
// --------------------------------------------------
{
  const [s1, e1] = Interval.period('now-7d', 'now', now);
  assert(s1 === now - 7 * D && e1 === now, `period("now-7d","now") (факт ${s1}..${e1})`);
  const [s2, e2] = Interval.period(now - D, now, now);
  assert(s2 === now - D && e2 === now, 'period(число, число)');
  const [s3, e3] = Interval.period('now-2h-15m', 1_700_000_000_000, now);
  assert(s3 === now - 2 * H - 900_000 && e3 === now, 'period(строка, число)');
  const [s4, e4] = Interval.period(0, now, now);
  assert(s4 === 0 && e4 === now, 'period(0, "now"→число)');
}
threw = false;
try { Interval.period('now', 'now-1d', now); } catch { threw = true; }
assert(threw, 'перевёрнутый период (end < start) → RangeError');
threw = false;
try { Interval.period('now-7d'); } catch { threw = true; }
assert(threw, 'одна граница без формы "start:end" → RangeError');

// --------------------------------------------------
// resolve: одна граница — число (мс) или строка → мс
// --------------------------------------------------
assert(Interval.resolve('now', now) === now, 'resolve "now"');
assert(Interval.resolve('now-1d', now) === now - D, 'resolve "now-1d"');
assert(Interval.resolve('1700000000000') === 1_700_000_000_000, 'resolve абсолютное время (строка)');
assert(Interval.resolve(123456789) === 123456789, 'resolve число проходит как есть');
threw = false;
try { Interval.resolve(Infinity); } catch { threw = true; }
assert(threw, 'resolve Infinity → RangeError');
threw = false;
try { Interval.resolve('abc'); } catch { threw = true; }
assert(threw, 'resolve мусор → RangeError');

// --------------------------------------------------
// roundTime / getIntervals / getIntervalOfFixedCount / getFactor
// --------------------------------------------------
assert(Interval.roundTime(105, 10) === 100, 'roundTime 105→100');
assert(Interval.roundTime(109, 10) === 100, 'roundTime 109→100');
assert(Interval.roundTime(200, 10) === 200, 'roundTime 200→200');

{
  // getIntervals округляет start/end вниз до precision — берём уже выровненное время
  const aligned = 1_699_999_200_000; // кратно часу
  const pts = Interval.getIntervals(aligned, aligned + 3 * H, H);
  assert(pts.length === 4, `getIntervals: 4 точки (факт ${pts.length})`);
  assert(pts[0] === aligned && pts[3] === aligned + 3 * H, 'getIntervals: границы');
  const single = Interval.getIntervals(aligned, aligned, H);
  assert(single.length === 1 && single[0] === aligned, `getIntervals: start==end → 1 точка (факт ${single.length})`);
  // не выровненное start округляется вниз
  const off = Interval.getIntervals(now, now + 3 * H, H);
  assert(off[0] < now && off[0] % H === 0, `start округлён вниз кратно H (факт ${off[0]})`);
}

assert(Interval.getIntervalOfFixedCount(0, 1000, 10) === 100, 'fixedCount 10 → 100');
assert(Interval.getIntervalOfFixedCount(0, 1000, 4) === 250, 'fixedCount 4 → 250');
assert(Interval.getIntervalOfFixedCount(0, 1000, 0) === 1, 'fixedCount 0 → 1');
assert(Interval.getFactor() === 1, 'getFactor = 1 (базовая единица — мс)');

console.log(`\nТесты Interval: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
