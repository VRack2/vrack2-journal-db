// ============================================================
// test-aggregate.ts — Фаза 1: сегментные саммари + aggregate() + downsample()
//
// Сверка с brute-force (allRows() + ручной расчёт) на случайных данных,
// включая null, строки без ts, сегменты без .meta и граничные сегменты.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import type { AggregateExpr, AggFn, Row, Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-aggregate');

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

/** Сравнение чисел с относительной погрешностью (оба null — ок). */
function assertClose(a: number | null, b: number | null, msg: string, rel = 1e-9): void {
  if (a === null && b === null) {
    passed++;
  } else if (a === null || b === null) {
    failed++;
    console.error(`FAIL: ${msg} (got ${a}, want ${b})`);
  } else if (Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b))) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg} (got ${a}, want ${b})`);
  }
}

fs.rmSync(baseDir, { recursive: true, force: true });

const DAY = 86_400_000;
const HOUR = 3_600_000;
const base = 1_700_000_000_000; // фиксированная эпоха — детерминированные тесты
const SCHEMA: Schema = { ts: 'delta', value: 'auto', host: 'dictionary' };
// ts:'raw' — разрешает строки без ts (delta не принимает null)
const SCHEMA_RAW_TS: Schema = { ts: 'raw', value: 'auto', host: 'dictionary' };

// --------------------------------------------------
// Детерминированный PRNG (mulberry32)
// --------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Генерация растущих по ts метрик с осциллирующим value и ~10% null. */
function genRows(n: number, seed: number, nulls = 0.1): Row[] {
  const rnd = mulberry32(seed);
  const rows: Row[] = [];
  let ts = base;
  for (let i = 0; i < n; i++) {
    ts += 1 + Math.floor(rnd() * 999); // шаг 1..1000 мс, ts растёт
    const host = `web-${1 + Math.floor(rnd() * 5)}`;
    let value: number | null;
    if (rnd() < nulls) value = null; // null — пропускается агрегатами
    else value = Math.round(Math.sin(i / 10) * 50 + 50 + rnd() * 20);
    rows.push({ ts, host, value });
  }
  return rows;
}

// --------------------------------------------------
// Brute-force: эталонный расчёт по allRows()
// --------------------------------------------------
function expectedAggregate(rows: Row[], start: number, end: number, exprs: AggregateExpr[]): Record<string, number | null> {
  const inRange = rows.filter(r => typeof r.ts === 'number' && r.ts >= start && r.ts <= end);
  const fields = [...new Set(exprs.map(e => e.field))];
  const accs: Record<string, { min: number; max: number; sum: number; count: number }> = {};
  for (const f of fields) accs[f] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
  for (const r of inRange) {
    for (const f of fields) {
      const v = r[f];
      if (typeof v === 'number' && Number.isFinite(v)) {
        const a = accs[f];
        if (v < a.min) a.min = v;
        if (v > a.max) a.max = v;
        a.sum += v;
        a.count++;
      }
    }
  }
  const fnFields = new Map<AggFn, Set<string>>();
  for (const e of exprs) {
    let s = fnFields.get(e.fn);
    if (!s) { s = new Set(); fnFields.set(e.fn, s); }
    s.add(e.field);
  }
  const result: Record<string, number | null> = {};
  for (const e of exprs) {
    const a = accs[e.field];
    let value: number | null;
    switch (e.fn) {
      case 'count': value = a.count; break;
      case 'sum': value = a.count > 0 ? a.sum : null; break;
      case 'min': value = a.count > 0 ? a.min : null; break;
      case 'max': value = a.count > 0 ? a.max : null; break;
      case 'avg': value = a.count > 0 ? a.sum / a.count : null; break;
    }
    result[fnFields.get(e.fn)!.size > 1 ? `${e.field}__${e.fn}` : e.fn] = value;
  }
  return result;
}

function expectedDownsample(rows: Row[], start: number, end: number, bucket: number, field: string): { count: number; min: number; max: number; sum: number }[] {
  const first = Math.floor(start / bucket) * bucket;
  const n = Math.max(1, Math.ceil((end - first) / bucket));
  const accs = new Array<{ min: number; max: number; sum: number; count: number }>(n);
  for (let i = 0; i < n; i++) accs[i] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
  for (const r of rows) {
    const ts = r.ts;
    if (typeof ts !== 'number' || ts < start || ts >= end) continue;
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    let idx = Math.floor((ts - first) / bucket);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;
    const a = accs[idx];
    if (v < a.min) a.min = v;
    if (v > a.max) a.max = v;
    a.sum += v;
    a.count++;
  }
  return accs.map(a => ({ count: a.count, min: a.min, max: a.max, sum: a.sum }));
}

// --------------------------------------------------
// 1. Базовый: активный сегмент, сверка с brute-force
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 10_000 });
  j.open('a1', SCHEMA);
  const rows = genRows(500, 42);
  for (const r of rows) j.append(r);
  // всё в активном сегменте (500 < 10000)

  const start = rows[0].ts as number;
  const end = rows[rows.length - 1].ts as number;
  const exprs: AggregateExpr[] = [
    { field: 'value', fn: 'avg' },
    { field: 'value', fn: 'min' },
    { field: 'value', fn: 'max' },
    { field: 'value', fn: 'sum' },
    { field: 'value', fn: 'count' },
  ];
  const got = j.aggregate(start, end, exprs);
  const want = expectedAggregate(rows, start, end, exprs);
  assertClose(got.avg, want.avg, 'a1 avg');
  assertClose(got.min, want.min, 'a1 min');
  assertClose(got.max, want.max, 'a1 max');
  assertClose(got.sum, want.sum, 'a1 sum');
  assertClose(got.count, want.count, 'a1 count');

  // Поддиапазон (срез)
  const mid = start + Math.floor((end - start) / 2);
  const got2 = j.aggregate(mid, end, [{ field: 'value', fn: 'count' }, { field: 'value', fn: 'avg' }]);
  const want2 = expectedAggregate(rows, mid, end, [{ field: 'value', fn: 'count' }, { field: 'value', fn: 'avg' }]);
  assertClose(got2.count, want2.count, 'a1 поддиапазон count');
  assertClose(got2.avg, want2.avg, 'a1 поддиапазон avg');
  j.close();
}

// --------------------------------------------------
// 2. Закрытые сегменты + активный: fast-path по саммари и скан
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 200 });
  j.open('a2', SCHEMA);
  const rows = genRows(500, 7); // 2 закрытых сегмента (200+200) + 100 активных
  for (const r of rows) j.append(r);

  const start = rows[0].ts as number;
  const end = rows[rows.length - 1].ts as number;
  const exprs: AggregateExpr[] = [
    { field: 'value', fn: 'min' },
    { field: 'value', fn: 'max' },
    { field: 'value', fn: 'sum' },
    { field: 'value', fn: 'avg' },
    { field: 'value', fn: 'count' },
  ];
  const got = j.aggregate(start, end, exprs);
  const want = expectedAggregate(rows, start, end, exprs);
  assertClose(got.min, want.min, 'a2 min');
  assertClose(got.max, want.max, 'a2 max');
  assertClose(got.sum, want.sum, 'a2 sum');
  assertClose(got.avg, want.avg, 'a2 avg');
  assertClose(got.count, want.count, 'a2 count');

  // Диапазон, пересекающий границу сегмента (граничный скан)
  const cut = rows[210].ts as number; // внутри 2-го сегмента
  const got2 = j.aggregate(rows[150].ts as number, cut, [{ field: 'value', fn: 'count' }, { field: 'value', fn: 'sum' }]);
  const want2 = expectedAggregate(rows, rows[150].ts as number, cut, [{ field: 'value', fn: 'count' }, { field: 'value', fn: 'sum' }]);
  assertClose(got2.count, want2.count, 'a2 граничный count');
  assertClose(got2.sum, want2.sum, 'a2 граничный sum');
  j.close();
}

// --------------------------------------------------
// 3. Null-семантика: null пропускается, count — только непустые числа
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('a3', SCHEMA);
  // 5 строк: 3 числа, 2 null
  const rows = [
    { ts: base + 1, host: 'a', value: 10 },
    { ts: base + 2, host: 'a', value: null },
    { ts: base + 3, host: 'a', value: 20 },
    { ts: base + 4, host: 'a', value: null },
    { ts: base + 5, host: 'a', value: 30 },
  ];
  for (const r of rows) j.append(r);
  const got = j.aggregate(base, base + 10, [
    { field: 'value', fn: 'count' },
    { field: 'value', fn: 'min' },
    { field: 'value', fn: 'max' },
    { field: 'value', fn: 'sum' },
    { field: 'value', fn: 'avg' },
  ]);
  assertClose(got.count, 3, 'a3 count=3 (2 null пропущено)');
  assertClose(got.min, 10, 'a3 min=10');
  assertClose(got.max, 30, 'a3 max=30');
  assertClose(got.sum, 60, 'a3 sum=60');
  assertClose(got.avg, 20, 'a3 avg=20');
  j.close();
}

// --------------------------------------------------
// 4. Строки без ts вне агрегаций
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('a4', SCHEMA_RAW_TS); // ts:'raw' допускает строки без ts
  j.append({ ts: base + 1, host: 'a', value: 100 });
  j.append({ host: 'a', value: 999 }); // без ts — не участвует
  j.append({ ts: base + 2, host: 'a', value: 200 });
  const got = j.aggregate(base, base + 10, [
    { field: 'value', fn: 'count' },
    { field: 'value', fn: 'sum' },
  ]);
  assertClose(got.count, 2, 'a4 count=2 (строка без ts не считается)');
  assertClose(got.sum, 300, 'a4 sum=300 (999 без ts не входит)');
  j.close();
}

// --------------------------------------------------
// 5. Сегменты без .meta — fallback на скан (и пересчёт саммари)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('a5', SCHEMA);
  const rows = genRows(300, 99);
  for (const r of rows) j.append(r);
  j.close();

  // Удаляем сайдкар'ы .meta — при чтении сегменты без границ/саммари
  const dir = path.join(baseDir, 'journals', 'a5');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.meta')) fs.rmSync(path.join(dir, f), { force: true });
  }

  const start = rows[0].ts as number;
  const end = rows[rows.length - 1].ts as number;
  const exprs: AggregateExpr[] = [
    { field: 'value', fn: 'min' },
    { field: 'value', fn: 'max' },
    { field: 'value', fn: 'sum' },
    { field: 'value', fn: 'count' },
  ];
  const want = expectedAggregate(rows, start, end, exprs);

  const j2 = new Journal(baseDir, { rowsPerSegment: 100 });
  j2.open('a5', SCHEMA);
  const got1 = j2.aggregate(start, end, exprs); // первый раз — скан (нет .meta)
  assertClose(got1.count, want.count, 'a5 без .meta: count');
  assertClose(got1.sum, want.sum, 'a5 без .meta: sum');
  assertClose(got1.min, want.min, 'a5 без .meta: min');
  assertClose(got1.max, want.max, 'a5 без .meta: max');

  // Повторный вызов — саммари уже кэшированы, результат тот же
  const got2 = j2.aggregate(start, end, exprs);
  assertClose(got2.count, want.count, 'a5 повторный: count');
  assertClose(got2.sum, want.sum, 'a5 повторный: sum');
  j2.close();
}

// --------------------------------------------------
// 6. downsample — сверка с brute-force по бакетам
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('a6', SCHEMA);
  const rows = genRows(2000, 5, 0.05);
  for (const r of rows) j.append(r);

  const bucket = HOUR; // 1 час
  const start = rows[0].ts as number;
  const end = (rows[rows.length - 1].ts as number) + 1; // конец не включительно
  const fns: AggFn[] = ['count', 'min', 'max', 'avg', 'sum'];

  const got = j.downsample(start, end, bucket, 'value', fns);
  const want = expectedDownsample(rows, start, end, bucket, 'value');
  assert(got.length === want.length, `a6 число бакетов: ${got.length} === ${want.length}`);
  let allOk = true;
  for (let i = 0; i < got.length; i++) {
    if (got[i].count !== want[i].count) { allOk = false; break; }
    if (want[i].count > 0) {
      if (Math.abs((got[i].min as number) - want[i].min) > 1e-9) { allOk = false; break; }
      if (Math.abs((got[i].max as number) - want[i].max) > 1e-9) { allOk = false; break; }
      if (Math.abs((got[i].sum as number) - want[i].sum) > 1e-6) { allOk = false; break; }
      if (Math.abs((got[i].avg as number) - want[i].sum / want[i].count) > 1e-9) { allOk = false; break; }
    }
  }
  assert(allOk, `a6 бакеты совпадают с brute-force (на ${got.length} бакетах)`);
  assert(got[0].start >= start && got[got.length - 1].end <= end, 'a6 границы бакетов в пределах периода');
  j.close();
}

// --------------------------------------------------
// 7. Различение ключей: одна функция по двум полям → поле__fn
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('a7', { ts: 'delta', value: 'auto', load: 'auto' });
  j.append({ ts: base + 1, value: 10, load: 3 });
  j.append({ ts: base + 2, value: 20, load: 6 });
  j.append({ ts: base + 3, value: 30, load: 9 });
  const got = j.aggregate(base, base + 10, [
    { field: 'value', fn: 'sum' },
    { field: 'load', fn: 'sum' },
  ]);
  assertClose(got.value__sum, 60, 'a7 value__sum=60');
  assertClose(got.load__sum, 18, 'a7 load__sum=18');
  assert(!('sum' in got), 'a7 без неоднозначного ключа «sum»');
  j.close();
}

// --------------------------------------------------
// 8. Пустой результат: диапазон без данных → null / count 0
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('a8', SCHEMA);
  j.append({ ts: base + 1, host: 'a', value: 5 });
  // Дальний диапазон без данных
  const got = j.aggregate(base + 1_000_000, base + 2_000_000, [
    { field: 'value', fn: 'count' },
    { field: 'value', fn: 'sum' },
    { field: 'value', fn: 'avg' },
  ]);
  assertClose(got.count, 0, 'a8 count=0');
  assert(got.sum === null, 'a8 sum=null');
  assert(got.avg === null, 'a8 avg=null');
  j.close();
}

// --------------------------------------------------
// 9. Ошибки: закрытый журнал, некорректные аргументы
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  let threw = false;
  try { j.aggregate(base, base + DAY, [{ field: 'value', fn: 'count' }]); } catch { threw = true; }
  assert(threw, 'a9 aggregate() до open() → ошибка');

  j.open('a9', SCHEMA);
  threw = false;
  try { j.aggregate(base, base + DAY, []); } catch { threw = true; }
  assert(threw, 'a9 aggregate() пустые exprs → RangeError');

  threw = false;
  try { j.aggregate(base, base + DAY, [{ field: 'value', fn: 'median' as never }]); } catch { threw = true; }
  assert(threw, 'a9 aggregate() неизвестная fn → RangeError');

  threw = false;
  try { j.aggregate(base + DAY, base, [{ field: 'value', fn: 'count' }]); } catch { threw = true; }
  assert(threw, 'a9 aggregate() start>end → RangeError');

  threw = false;
  try { j.downsample(base, base + DAY, 0, 'value', ['count']); } catch { threw = true; }
  assert(threw, 'a9 downsample() bucket<=0 → RangeError');

  threw = false;
  try { j.downsample(base, base + DAY, HOUR, 'value', []); } catch { threw = true; }
  assert(threw, 'a9 downsample() пустые fns → RangeError');
  j.close();
}

// --------------------------------------------------
// 10. Строковые интервалы (VRackDB) и детерминизм reopen
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('a10', SCHEMA);
  const rows = genRows(300, 11);
  for (const r of rows) j.append(r);

  // Числовые границы vs строковые (абсолютное время → детерминированно)
  const start = rows[0].ts as number;
  const end = (rows[rows.length - 1].ts as number);
  const exprs: AggregateExpr[] = [{ field: 'value', fn: 'count' }, { field: 'value', fn: 'sum' }];
  const num = j.aggregate(start, end, exprs);
  const str = j.aggregate(String(start), String(end), exprs);
  assertClose(num.count, str.count, 'a10 числовые vs строковые границы: count');
  assertClose(num.sum, str.sum, 'a10 числовые vs строковые границы: sum');
  j.close();

  // Reopen: результат стабилен
  const j2 = new Journal(baseDir, { rowsPerSegment: 100 });
  j2.open('a10', SCHEMA);
  const reopen = j2.aggregate(start, end, exprs);
  assertClose(num.count, reopen.count, 'a10 reopen: count стабилен');
  assertClose(num.sum, reopen.sum, 'a10 reopen: sum стабилен');
  j2.close();
}

// --------------------------------------------------
// 11. Производительность: aggregate по всем сегментам (fast-path)
//     без материализации строк vs allRows() + reduce
// --------------------------------------------------
{
  const N = 300_000;
  const j = new Journal(baseDir, { rowsPerSegment: 50_000 });
  j.open('a11', SCHEMA);
  let ts = base;
  for (let i = 0; i < N; i++) {
    ts += 7;
    j.append({ ts, host: 'h', value: Math.sin(i / 50) * 100 + 100 });
  }
  const start = base;
  const end = ts; // все сегменты целиком в диапазоне → fast-path по саммари
  const exprs: AggregateExpr[] = [{ field: 'value', fn: 'avg' }, { field: 'value', fn: 'sum' }, { field: 'value', fn: 'count' }];

  let tAgg = 0;
  let aggResult: Record<string, number | null> = {};
  {
    const t0 = process.hrtime.bigint();
    aggResult = j.aggregate(start, end, exprs);
    tAgg = Number(process.hrtime.bigint() - t0) / 1e6;
  }

  const t0 = process.hrtime.bigint();
  const rows = j.allRows();
  let sum = 0, count = 0;
  for (const r of rows) {
    const v = r.value;
    if (typeof v === 'number' && Number.isFinite(v)) { sum += v; count++; }
  }
  const allrowsMs = Number(process.hrtime.bigint() - t0) / 1e6;

  assert(aggResult.count === count, 'a11 count совпадает с brute-force');
  assertClose(aggResult.sum, sum, 'a11 sum совпадает с brute-force');
  assert(tAgg < allrowsMs, `a11 aggregate ${tAgg.toFixed(1)}ms < allRows+reduce ${allrowsMs.toFixed(1)}ms`);
  console.log(`  [perf] aggregate=${tAgg.toFixed(1)}ms  allRows+reduce=${allrowsMs.toFixed(1)}ms  (N=${N})`);
  j.close();
}

console.log(`\nТесты aggregate: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
