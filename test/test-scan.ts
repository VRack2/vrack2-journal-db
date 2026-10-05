// ============================================================
// test-scan.ts — Фаза 3: векторный скан Journal.scan()
//
// select/where/groupBy/agg/order/limit без материализации строк.
// Сверка с brute-force (allRows() + ручной расчёт), включая null,
// строки без ts, закрытые + активные сегменты, top-k, ошибки.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import type { AggFn, Row, Schema, ScanOp, ScanWhere } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-scan');

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${msg}`); }
}

function assertClose(a: number | null, b: number | null, msg: string, rel = 1e-9): void {
  if (a === null && b === null) { passed++; }
  else if (a === null || b === null) { failed++; console.error(`FAIL: ${msg} (got ${a}, want ${b})`); }
  else if (Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b))) { passed++; }
  else { failed++; console.error(`FAIL: ${msg} (got ${a}, want ${b})`); }
}

fs.rmSync(baseDir, { recursive: true, force: true });

const HOUR = 3_600_000;
const base = 1_700_000_000_000;
const SCHEMA: Schema = { ts: 'delta', value: 'auto', host: 'dictionary' };
const SCHEMA_RAW_TS: Schema = { ts: 'raw', value: 'auto', host: 'dictionary' };

// --------------------------------------------------
// PRNG + генерация
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

function genRows(n: number, seed: number, nulls = 0.1, hosts = 5): Row[] {
  const rnd = mulberry32(seed);
  const rows: Row[] = [];
  let ts = base;
  for (let i = 0; i < n; i++) {
    ts += 1 + Math.floor(rnd() * 999);
    const host = `web-${1 + Math.floor(rnd() * hosts)}`;
    let value: number | null;
    if (rnd() < nulls) value = null;
    else value = Math.round(Math.sin(i / 10) * 50 + 50 + rnd() * 20);
    rows.push({ ts, host, value });
  }
  return rows;
}

// --------------------------------------------------
// Brute-force: эталонный расчёт по allRows()
// --------------------------------------------------
function refWhereOne(value: unknown, op: ScanOp, target: unknown): boolean {
  switch (op) {
    case 'eq': return value === target;
    case 'ne': return value !== target;
    case 'lt': return typeof value === 'number' && typeof target === 'number' && value < target;
    case 'le': return typeof value === 'number' && typeof target === 'number' && value <= target;
    case 'gt': return typeof value === 'number' && typeof target === 'number' && value > target;
    case 'ge': return typeof value === 'number' && typeof target === 'number' && value >= target;
    case 'in': return Array.isArray(target) && target.includes(value);
    case 'nin': return Array.isArray(target) && !target.includes(value);
    case 'isNull': return value === null || value === undefined;
    case 'isNotNull': return value !== null && value !== undefined;
  }
  return false;
}

function aggValRef(a: { min: number; max: number; sum: number; count: number }, fn: AggFn): number | null {
  switch (fn) {
    case 'count': return a.count;
    case 'sum': return a.count > 0 ? a.sum : null;
    case 'min': return a.count > 0 ? a.min : null;
    case 'max': return a.count > 0 ? a.max : null;
    case 'avg': return a.count > 0 ? a.sum / a.count : null;
  }
  return null;
}

interface ScanRef { start: number | null; end: number | null; where: ScanWhere[]; groupBy: string[]; agg: Record<string, AggFn[]>; }

/** Эталонный результат scan() по массиву строк (без order/limit — их применяем отдельно). */
function expectedScan(rows: Row[], ref: ScanRef): Row[] {
  const inRange = rows.filter(r => {
    if (ref.start !== null && ref.end !== null) {
      if (typeof r.ts !== 'number' || r.ts < ref.start! || r.ts > ref.end!) return false;
    }
    for (const c of ref.where) {
      if (!refWhereOne(r[c.field], c.op, c.value)) return false;
    }
    return true;
  });

  const aggFields = Object.keys(ref.agg);
  const accFor = () => { const o: Record<string, { min: number; max: number; sum: number; count: number }> = {}; for (const f of aggFields) o[f] = { min: Infinity, max: -Infinity, sum: 0, count: 0 }; return o; };
  const feed = (accs: Record<string, { min: number; max: number; sum: number; count: number }>, r: Row) => {
    for (const f of aggFields) {
      const v = r[f];
      if (typeof v === 'number' && Number.isFinite(v)) {
        const a = accs[f]; if (v < a.min) a.min = v; if (v > a.max) a.max = v; a.sum += v; a.count++;
      }
    }
  };
  const emit = (row: Row, accs: Record<string, { min: number; max: number; sum: number; count: number }>) => {
    const out: Row = { ...row };
    for (const [field, fns] of Object.entries(ref.agg)) {
      const a = accs[field];
      for (const fn of fns) out[`${field}_${fn}`] = aggValRef(a, fn);
    }
    return out;
  };

  if (ref.groupBy.length === 0) {
    const accs = accFor();
    for (const r of inRange) feed(accs, r);
    return [emit({}, accs)];
  }
  const groups = new Map<string, { row: Row; accs: Record<string, { min: number; max: number; sum: number; count: number }> }>();
  for (const r of inRange) {
    const key = ref.groupBy.map(f => JSON.stringify(r[f])).join('|');
    let g = groups.get(key);
    if (!g) { const row: Row = {}; for (const f of ref.groupBy) row[f] = r[f]; g = { row, accs: accFor() }; groups.set(key, g); }
    feed(g.accs, r);
  }
  return [...groups.values()].map(g => emit(g.row, g.accs));
}

/** Сравнение двух множеств агрегированных строк (порядок не важен): ключ (1+ полей) + значения. */
function assertAggSets(got: Row[], want: Row[], msg: string, keyFields: string[]): void {
  const keyOf = (r: Row) => keyFields.map(f => JSON.stringify(r[f])).join('|');
  const mapGot = new Map(got.map(r => [keyOf(r), r]));
  const mapWant = new Map(want.map(r => [keyOf(r), r]));
  assert(mapGot.size === mapWant.size, `${msg}: число строк ${mapGot.size} === ${mapWant.size}`);
  for (const [k, w] of mapWant) {
    const g = mapGot.get(k);
    if (!g) { failed++; console.error(`FAIL: ${msg}: нет строки ${k}`); continue; }
    for (const [fk, fv] of Object.entries(w)) {
      if (keyFields.includes(fk)) continue;
      if (typeof fv === 'number') assertClose(g[fk] as number | null, fv, `${msg}: ${k} ${fk}`);
      else if (fv === null) assert(g[fk] === null || g[fk] === undefined, `${msg}: ${k} ${fk} null`);
    }
  }
}

// --------------------------------------------------
// 1. Raw-режим: select/where/order/limit/offset, сверка с brute-force
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 200 });
  j.open('s1', SCHEMA);
  const rows = genRows(600, 42);
  for (const r of rows) j.append(r);

  // select + where(gt) + order asc + limit
  const start = rows[0].ts as number, end = rows[rows.length - 1].ts as number;
  const where: ScanWhere[] = [{ field: 'value', op: 'gt', value: 80 }];
  const got = j.scan({ start, end, select: ['ts', 'host', 'value'], where, order: 'asc', limit: 50 });
  // brute-force raw: отфильтрованные строки, отсортированные по ts, limit
  const bf = rows.filter(r => typeof r.ts === 'number' && r.ts >= start && r.ts <= end && typeof r.value === 'number' && r.value > 80)
    .sort((a, b) => (a.ts as number) - (b.ts as number)).slice(0, 50);
  assert(got.length === bf.length, `s1 raw: длина ${got.length} === ${bf.length}`);
  let ok = got.length === bf.length;
  for (let i = 0; i < Math.min(got.length, bf.length); i++) {
    if (got[i].ts !== bf[i].ts || got[i].host !== bf[i].host || got[i].value !== bf[i].value) { ok = false; break; }
  }
  assert(ok, 's1 raw: строки совпадают с brute-force (select+where+order+limit)');
  assert(got.every(r => typeof r.value === 'number' && r.value > 80), 's1 raw: все value > 80');
  j.close();
}

// --------------------------------------------------
// 2. Agg-режим без groupBy: сверка с brute-force (fast-path + скан)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('s2', SCHEMA);
  const rows = genRows(1000, 7);
  for (const r of rows) j.append(r);

  const start = rows[0].ts as number, end = rows[rows.length - 1].ts as number;
  const agg: Record<string, AggFn[]> = { value: ['avg', 'min', 'max', 'sum', 'count'] };
  const got = j.scan({ start, end, agg });
  const want = expectedScan(rows, { start, end, where: [], groupBy: [], agg });
  assert(got.length === 1, 's2 agg: одна строка');
  assertClose(got[0].value_avg as number, want[0].value_avg as number, 's2 value_avg');
  assertClose(got[0].value_min as number, want[0].value_min as number, 's2 value_min');
  assertClose(got[0].value_max as number, want[0].value_max as number, 's2 value_max');
  assertClose(got[0].value_sum as number, want[0].value_sum as number, 's2 value_sum');
  assertClose(got[0].value_count as number, want[0].value_count as number, 's2 value_count');
  j.close();
}

// --------------------------------------------------
// 3. Agg + groupBy: сверка с brute-force (top-k)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('s3', SCHEMA);
  const rows = genRows(2000, 99, 0.05, 8);
  for (const r of rows) j.append(r);

  const start = rows[0].ts as number, end = rows[rows.length - 1].ts as number;
  const where: ScanWhere[] = [{ field: 'value', op: 'gt', value: 60 }];
  const agg: Record<string, AggFn[]> = { value: ['avg', 'min', 'max'], ts: ['count'] };
  const got = j.scan({ start, end, where, groupBy: 'host', agg, order: 'desc', limit: 5 });
  const want = expectedScan(rows, { start, end, where, groupBy: ['host'], agg });

  assert(got.length <= 5, 's3 top-k: не более 5 групп');
  assert(got.length >= 1, 's3 top-k: есть группы');
  // Сверка значений каждой группы с brute-force
  const wantMap = new Map(want.map(r => [r.host as string, r]));
  for (const g of got) {
    const w = wantMap.get(g.host as string);
    assert(!!w, `s3 группа ${g.host} существует в brute-force`);
    if (!w) continue;
    assertClose(g.value_avg as number, w.value_avg as number, `s3 ${g.host} value_avg`);
    assertClose(g.value_min as number, w.value_min as number, `s3 ${g.host} value_min`);
    assertClose(g.value_max as number, w.value_max as number, `s3 ${g.host} value_max`);
    assertClose(g.ts_count as number, w.ts_count as number, `s3 ${g.host} ts_count`);
  }
  // order desc — по первому ключу агрегата (value_avg): убывает
  let sorted = true;
  for (let i = 1; i < got.length; i++) {
    if ((got[i - 1].value_avg as number) < (got[i].value_avg as number)) sorted = false;
  }
  assert(sorted, 's3 order desc: value_avg убывает');
  j.close();
}

// --------------------------------------------------
// 4. Все операторы where (eq/ne/lt/le/gt/ge/in/nin/isNull/isNotNull)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 50 });
  j.open('s4', SCHEMA_RAW_TS); // ts raw — допускает строки без ts
  const rows: Row[] = [
    { ts: base + 1, host: 'a', value: 10 },
    { ts: base + 2, host: 'b', value: 20 },
    { ts: base + 3, host: 'c', value: null },
    { ts: base + 4, host: 'a', value: 40 },
    { host: 'd', value: 999 }, // без ts
    { ts: base + 6, host: 'b', value: 60 },
  ];
  for (const r of rows) j.append(r);

  const range = { start: base, end: base + 100 };
  const cnt = (where: ScanWhere[]) => j.scan({ ...range, agg: { ts: ['count'] }, where })[0].ts_count as number;

  assert(cnt([{ field: 'host', op: 'eq', value: 'a' }]) === 2, 's4 eq host=a → 2');
  assert(cnt([{ field: 'host', op: 'ne', value: 'a' }]) === 3, 's4 ne host=a → 3 (b,c,b; d без ts не считается)');
  assert(cnt([{ field: 'value', op: 'lt', value: 40 }]) === 2, 's4 lt value<40 → 2 (10,20)');
  assert(cnt([{ field: 'value', op: 'le', value: 40 }]) === 3, 's4 le value<=40 → 3 (10,20,40)');
  assert(cnt([{ field: 'value', op: 'gt', value: 40 }]) === 1, 's4 gt value>40 → 1 (60; null и 999-без-ts нет)');
  assert(cnt([{ field: 'value', op: 'ge', value: 40 }]) === 2, 's4 ge value>=40 → 2 (40,60)');
  assert(cnt([{ field: 'host', op: 'in', value: ['a', 'b'] }]) === 4, 's4 in [a,b] → 4 (a,a? no: a,a? rows: a,a,b,b)');
  assert(cnt([{ field: 'host', op: 'nin', value: ['a', 'b'] }]) === 1, 's4 nin [a,b] → 1 (c)');
  assert(cnt([{ field: 'value', op: 'isNull' }]) === 1, 's4 isNull value → 1');
  assert(cnt([{ field: 'value', op: 'isNotNull' }]) === 4, 's4 isNotNull value → 4');
  j.close();
}

// --------------------------------------------------
// 5. groupBy по нескольким полям + AND-условия
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 50 });
  j.open('s5', { ts: 'delta', value: 'auto', host: 'dictionary', dc: 'dictionary' });
  const rows: Row[] = [];
  let ts = base;
  const data = [
    ['h1', 'dc1', 10], ['h1', 'dc2', 20], ['h2', 'dc1', 30],
    ['h1', 'dc1', 40], ['h2', 'dc2', 50], ['h1', 'dc2', 60],
  ];
  for (const [h, d, v] of data) { ts += 100; rows.push({ ts, host: h, dc: d, value: v }); }
  for (const r of rows) j.append(r);

  const start = base, end = ts;
  const where: ScanWhere[] = [{ field: 'value', op: 'ge', value: 20 }];
  const agg: Record<string, AggFn[]> = { value: ['sum', 'count'] };
  const got = j.scan({ start, end, where, groupBy: ['host', 'dc'], agg });
  const want = expectedScan(rows, { start, end, where, groupBy: ['host', 'dc'], agg });
  assertAggSets(got, want, 's5 multi-groupBy', ['host', 'dc']);
  assert(got.length === 4, 's5 4 группы (h1dc1,h1dc2,h2dc1,h2dc2)');
  j.close();
}

// --------------------------------------------------
// 6. Fast-path (без where/groupBy) + закрытые/активные сегменты + reopen
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('s6', SCHEMA);
  const rows = genRows(1500, 5);
  for (const r of rows) j.append(r);

  const start = rows[0].ts as number, end = rows[rows.length - 1].ts as number;
  const agg: Record<string, AggFn[]> = { value: ['sum', 'count', 'avg'] };
  const got1 = j.scan({ start, end, agg });
  const want = expectedScan(rows, { start, end, where: [], groupBy: [], agg });
  assertClose(got1[0].value_sum as number, want[0].value_sum as number, 's6 sum');
  assertClose(got1[0].value_count as number, want[0].value_count as number, 's6 count');
  assertClose(got1[0].value_avg as number, want[0].value_avg as number, 's6 avg');
  j.close();

  const j2 = new Journal(baseDir, { rowsPerSegment: 100 });
  j2.open('s6', SCHEMA);
  const got2 = j2.scan({ start, end, agg });
  assertClose(got1[0].value_sum as number, got2[0].value_sum as number, 's6 reopen: sum стабилен');
  assertClose(got1[0].value_count as number, got2[0].value_count as number, 's6 reopen: count стабилен');
  j2.close();
}

// --------------------------------------------------
// 7. Пустой результат + null-семантика
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 50 });
  j.open('s7', SCHEMA);
  j.append({ ts: base + 1, host: 'a', value: 5 });
  // Дальний диапазон — пустой
  const got = j.scan({ start: base + 1_000_000, end: base + 2_000_000, agg: { value: ['count', 'sum', 'avg'] } });
  assert(got.length === 1, 's7 agg: одна строка (пустая группа)');
  assertClose(got[0].value_count as number, 0, 's7 count=0');
  assert(got[0].value_sum === null, 's7 sum=null');
  assert(got[0].value_avg === null, 's7 avg=null');

  // groupBy на пустом диапазоне — 0 групп
  const gotG = j.scan({ start: base + 1_000_000, end: base + 2_000_000, groupBy: 'host', agg: { value: ['count'] } });
  assert(gotG.length === 0, 's7 groupBy на пустом диапазоне → 0 строк');
  j.close();
}

// --------------------------------------------------
// 8. Ошибки: закрытый журнал, groupBy без agg, некорректные аргументы
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  let threw = false;
  try { j.scan({ agg: { value: ['count'] } }); } catch { threw = true; }
  assert(threw, 's8 scan() до open() → ошибка');

  j.open('s8', SCHEMA);
  threw = false;
  try { j.scan({ groupBy: 'host', agg: { value: ['count'] } }); } catch { /* это валидно — должно НЕ кидать */ }
  assert(!threw, 's8 groupBy+agg — валидно');

  threw = false;
  try { j.scan({ groupBy: 'host' }); } catch { threw = true; }
  assert(threw, 's8 groupBy без agg → RangeError');

  threw = false;
  try { j.scan({ agg: { value: ['median' as never] } }); } catch { threw = true; }
  assert(threw, 's8 неизвестная fn → RangeError');

  threw = false;
  try { j.scan({ where: [{ field: 'value', op: 'like' as never }] }); } catch { threw = true; }
  assert(threw, 's8 неизвестный op → RangeError');

  threw = false;
  try { j.scan({ where: [{ field: 'host', op: 'in', value: 'a' }] }); } catch { threw = true; }
  assert(threw, 's8 in без массива → RangeError');

  threw = false;
  try { j.scan({ start: 100, end: 50, agg: { value: ['count'] } }); } catch { threw = true; }
  assert(threw, 's8 start>end → RangeError');

  threw = false;
  try { j.scan({ limit: -1, agg: { value: ['count'] } }); } catch { threw = true; }
  assert(threw, 's8 limit<0 → RangeError');

  // Пустой select — как «все поля» (lenient), не ошибка
  let threwSel = false;
  const allSel: Row[] = [];
  try { j.append({ ts: base + 1, host: 'a', value: 5 }); allSel.push(j.scan({ select: [] })[0]); } catch { threwSel = true; }
  assert(!threwSel, 's8 пустой select не кидает (lenient)');
  assert(allSel.length === 1 && allSel[0].host === 'a' && allSel[0].value === 5, 's8 пустой select → все поля');
  j.close();
}

// --------------------------------------------------
// 9. Строковые границы (now-*) — smoke (не детерминированно по данным)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 50 });
  j.open('s9', SCHEMA);
  const now = Date.now();
  for (let i = 0; i < 10; i++) j.append({ ts: now - 1000 * (10 - i), host: 'h', value: i });
  // 'now-5m'..'now' — всё должно быть в окне
  const got = j.scan({ start: 'now-5m', end: 'now', agg: { value: ['count'] } });
  assertClose(got[0].value_count as number, 10, 's9 now-*/now окно → count=10');
  j.close();
}

// --------------------------------------------------
// 10. Производительность: 10M точек, scan(where+groupBy+top-k) vs allRows()
// --------------------------------------------------
{
  const N = 10_000_000;
  const j = new Journal(baseDir, { rowsPerSegment: 250_000 });
  j.open('s10', SCHEMA);
  const hosts = ['web-1', 'web-2', 'web-3', 'web-4'];
  let ts = base;
  const tApp0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    ts += 7;
    const value = Math.round(Math.sin(i / 1000) * 50 + 50 + (i % 17));
    j.append({ ts, host: hosts[i % hosts.length], value });
  }
  const appendMs = Number(process.hrtime.bigint() - tApp0) / 1e6;

  const start = base, end = ts;
  const where: ScanWhere[] = [{ field: 'value', op: 'gt', value: 90 }];
  const agg: Record<string, AggFn[]> = { value: ['avg'], ts: ['count'] };

  let scanMs = 0; let scanRes: Row[] = [];
  {
    const t0 = process.hrtime.bigint();
    scanRes = j.scan({ start, end, where, groupBy: 'host', agg, order: 'desc', limit: 4 });
    scanMs = Number(process.hrtime.bigint() - t0) / 1e6;
  }

  // allRows + ручной group — эталон (медленно, один раз)
  let allMs = 0;
  const groups = new Map<string, { sum: number; count: number }>();
  {
    const t0 = process.hrtime.bigint();
    const rows = j.allRows();
    for (const r of rows) {
      if (typeof r.ts !== 'number') continue;
      const v = r.value;
      if (typeof v !== 'number' || v <= 90) continue;
      let g = groups.get(r.host as string);
      if (!g) { g = { sum: 0, count: 0 }; groups.set(r.host as string, g); }
      g.sum += v; g.count++;
    }
    allMs = Number(process.hrtime.bigint() - t0) / 1e6;
  }

  assert(scanRes.length === 4, `s10 top-4 группы (получено ${scanRes.length})`);
  for (const g of scanRes) {
    const w = groups.get(g.host as string);
    assert(!!w, `s10 группа ${g.host} в эталоне`);
    if (!w) continue;
    assertClose(g.value_avg as number, w.sum / w.count, `s10 ${g.host} value_avg`, 1e-9);
    assertClose(g.ts_count as number, w.count, `s10 ${g.host} ts_count`);
  }
  assert(scanMs < allMs, `s10 scan ${scanMs.toFixed(0)}ms < allRows+group ${allMs.toFixed(0)}ms`);
  console.log(`  [perf] N=${N}: append=${appendMs.toFixed(0)}ms scan(where+groupBy+topk)=${scanMs.toFixed(0)}ms allRows+group=${allMs.toFixed(0)}ms`);
  assert(scanMs < 2000, `s10 scan < 2s (получено ${scanMs.toFixed(0)}ms)`);
  j.close();
}

console.log(`\nТесты scan: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
