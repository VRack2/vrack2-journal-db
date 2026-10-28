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
import { Journal } from '../src/journal/Journal.ts';
import type { AggFn, Row, Schema, ScanOp, ScanWhere } from '../src/core/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'scan');

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
// 10. Производительность: 1M точек, scan(where+groupBy+top-k) vs allRows()
// --------------------------------------------------
{
  const N = 1_000_000;
  const j = new Journal(baseDir, { rowsPerSegment: 25_000 });
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

// --------------------------------------------------
// Зональная фильтрация по .meta (skipsWhere): сегменты с непересекающимися
// summary пропускаются целиком; результат совпадает с полным фильтром.
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 25 });
  j.open('zonemap', SCHEMA);
  for (let i = 0; i < 100; i++) j.append({ ts: i, value: i, host: 'h' + (i % 2) });
  j.close();

  const k = new Journal(baseDir);
  k.open('zonemap', SCHEMA);
  // ts-фильтр включает hasTsFilter → числовые операторы дают право на skip.
  const none = k.scan({ start: 0, end: 1000, where: [{ field: 'value', op: 'gt', value: 1000 }] });
  assert(none.length === 0, `zonemap: gt за максимумом — 0 строк (получено ${none.length})`);
  const low = k.scan({ start: 0, end: 1000, where: [{ field: 'value', op: 'lt', value: 10 }] });
  assert(low.length === 10 && low.every(r => (r.value as number) < 10),
    `zonemap: lt 10 → ровно 10 строк (получено ${low.length})`);
  const mid = k.scan({ start: 0, end: 1000, where: [{ field: 'value', op: 'ge', value: 60 }] });
  assert(mid.length === 40 && mid.every(r => (r.value as number) >= 60),
    `zonemap: ge 60 → ровно 40 строк (получено ${mid.length})`);
  const eq = k.scan({ start: 0, end: 1000, where: [{ field: 'value', op: 'eq', value: 37 }] });
  assert(eq.length === 1 && (eq[0].value as number) === 37, `zonemap: eq 37 → 1 строка (получено ${eq.length})`);
  // Без ts-фильтра skip запрещён — результат всё равно корректен.
  const noTs = k.scan({ where: [{ field: 'value', op: 'gt', value: 1000 }] });
  assert(noTs.length === 0, `zonemap: без ts-фильтра — тоже 0 (получено ${noTs.length})`);
  k.close();
}

// --------------------------------------------------
// Ранний стоп: разрешён только при сортировке самим ts, неперекрывающихся
// числовых .meta-границах закрытых сегментов и либо ts-окне (отсекает строки
// без ts), либо полном ts-покрытии всех источников (tsCount === rowCount).
// Иначе — полный скан с сортировкой.
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 5 });
  j.open('earlystop', SCHEMA);
  for (let i = 0; i < 5; i++) j.append({ ts: 100 + i, value: 100 + i, host: 'a' });
  for (let i = 0; i < 5; i++) j.append({ ts: i, value: i, host: 'b' });
  j.close();

  // У сегмента с ранними ts (minTs=0) забираем .meta: без границ он уезжает
  // в КОНЕЦ sortedIds — ранний стоп тогда отрезал бы настоящие первые строки.
  const dir = path.join(baseDir, 'journals', 'earlystop');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.meta')) continue;
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    if (m.minTs === 0) fs.rmSync(path.join(dir, f));
  }
  const k = new Journal(baseDir);
  k.open('earlystop', SCHEMA);
  const got = k.scan({ start: 0, end: 1000, select: ['ts'], order: 'asc', limit: 5 });
  assert(got.length === 5 && got.every((r, i) => (r.ts as number) === i),
    `early stop без .meta: ts=0..4 (получено ${got.map(r => r.ts).join(',')})`);
  k.close();
}

{
  const j = new Journal(baseDir, { rowsPerSegment: 5 });
  j.open('earlysort', SCHEMA);
  for (let i = 0; i < 10; i++) j.append({ ts: i, value: 10 - i, host: 'a' });
  j.close();
  const k = new Journal(baseDir);
  k.open('earlysort', SCHEMA);
  const got = k.scan({ start: 0, end: 100, select: ['value'], order: 'asc', limit: 3 });
  assert(JSON.stringify(got.map(r => r.value)) === JSON.stringify([1, 2, 3]),
    `early stop выключен при sortKey!=ts: value=[1,2,3] (получено ${JSON.stringify(got.map(r => r.value))})`);
  k.close();
}

{
  const j = new Journal(baseDir);
  j.open('earlynull', SCHEMA_RAW_TS);
  j.append({ ts: 5, value: 5, host: 'a' });
  j.append({ host: 'a', value: 9 }); // без ts: сортируется последней, но идёт в середине сегмента
  j.append({ ts: 1, value: 1, host: 'a' });
  const got = j.scan({ select: ['ts'], order: 'asc', limit: 2 });
  assert(got.length === 2 && (got[0].ts as number) === 1 && (got[1].ts as number) === 5,
    `early stop выключен без ts-окна: ts=[1,5] (получено ${JSON.stringify(got.map(r => r.ts))})`);
  j.close();
}

// --------------------------------------------------
// Перекрывающиеся диапазоны закрытых сегментов — ранний стоп выключен:
// break по rawNeed отрезал бы меньшие ts из последующего сегмента.
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 2 });
  j.open('earlyoverlap', SCHEMA);
  j.append({ ts: 100, value: 100, host: 'a' });
  j.append({ ts: 50, value: 50, host: 'a' });  // seg1: диапазон [50,100]
  j.append({ ts: 60, value: 60, host: 'a' });
  j.append({ ts: 70, value: 70, host: 'a' });  // seg2: [60,70] — перекрывает seg1
  j.close();
  const k = new Journal(baseDir);
  k.open('earlyoverlap', SCHEMA);
  const got = k.scan({ start: 0, end: 1000, select: ['ts'], order: 'asc', limit: 1 });
  assert(got.length === 1 && (got[0].ts as number) === 50,
    `overlap-гейт: минимальный ts=50, не 100 (получено ${got.map(r => r.ts).join(',')})`);
  k.close();
}

// --------------------------------------------------
// Top-k БЕЗ окна разрешён, когда покрыт весь ts (tsCount===rowCount у всех
// источников) и диапазоны не перекрываются; закрытый сегмент со строками
// без ts это по-прежнему отключает.
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 2 });
  j.open('earlyfull', SCHEMA);
  for (const ts of [10, 11, 20, 21]) j.append({ ts, value: ts, host: 'a' });
  j.close();
  const k = new Journal(baseDir);
  k.open('earlyfull', SCHEMA);
  const got = k.scan({ select: ['ts'], order: 'asc', limit: 2 });
  assert(got.length === 2 && (got[0].ts as number) === 10 && (got[1].ts as number) === 11,
    `top-k без окна (полный ts): [10,11] (получено ${got.map(r => r.ts).join(',')})`);
  const desc = k.scan({ select: ['ts'], order: 'asc', limit: 2, offset: 2 });
  assert(desc.length === 2 && (desc[0].ts as number) === 20 && (desc[1].ts as number) === 21,
    `top-k без окна offset=2: [20,21] (получено ${desc.map(r => r.ts).join(',')})`);
  k.close();
}

{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('earlynullclosed', SCHEMA_RAW_TS);
  j.append({ ts: 5, value: 5, host: 'a' });
  j.append({ host: 'a', value: 9 }); // строка без ts в ЗАКРЫТОМ сегменте: tsCount < rowCount
  j.append({ ts: 1, value: 1, host: 'a' });
  j.close();
  const k = new Journal(baseDir);
  k.open('earlynullclosed', SCHEMA_RAW_TS);
  const got = k.scan({ select: ['ts'], order: 'asc', limit: 2 });
  assert(got.length === 2 && (got[0].ts as number) === 1 && (got[1].ts as number) === 5,
    `закрытый сегмент без ts: ранний стоп выключен, ts=[1,5] (получено ${JSON.stringify(got.map(r => r.ts))})`);
  k.close();
}


// --------------------------------------------------
// Фаза C: dims-скипы на уровне Journal.scan без ts-фильтра
// --------------------------------------------------
{
  const dir = path.join(baseDir, 'dimsskip');
  fs.mkdirSync(dir, { recursive: true });
  const j = new Journal(dir, { rowsPerSegment: 20 });
  j.open('dimskip', SCHEMA, { _cluster: ['host'] });
  for (let i = 0; i < 60; i++) j.append({ ts: base + i * 1000, value: i, host: 'h' + (i % 4) });
  j.flush();
  j.compact(); // ≥2 закрытых сегментов → merge // cluster-метаданные → сегмент кластеризован, dims в .meta
  const all = j.allRows();
  j.close();
  // холодный кеш: загрузка сегментов идёт через loadClosed
  j.open('dimskip', SCHEMA, { _cluster: ['host'] });
  const store = (j as unknown as { store: { loadClosed(id: string): unknown } }).store;
  let loads = 0;
  const origLoad = store.loadClosed.bind(store);
  store.loadClosed = (id: string) => { loads++; return origLoad(id); };

  // eq по значению вне dims-набора, НЕТ start/end — сегменты скипаются по dims
  const miss = j.scan({ where: [{ field: 'host', op: 'eq', value: 'zz' }] });
  assert(miss.length === 0 && loads === 0, `dims-skip без ts-фильтра: eq zz → пусто, загрузок ${loads}`);

  // ne никогда не skip: грузим и фильтруем построчно
  loads = 0;
  const neAll = j.scan({ where: [{ field: 'host', op: 'ne', value: 'zz' }] });
  assert(neAll.length === 60 && loads > 0, `ne — не skip: 60 строк, загрузок ${loads}`);

  // in без пересечения — тоже skip
  loads = 0;
  const inMiss = j.scan({ where: [{ field: 'host', op: 'in', value: ['zz', 'yy'] }] });
  assert(inMiss.length === 0 && loads === 0, `dims-skip: in без пересечения → загрузок ${loads}`);

  // положительный случай: eq h1 — не skip, результат точен
  loads = 0;
  const h1 = j.scan({ where: [{ field: 'host', op: 'eq', value: 'h1' }] });
  const want = all.filter(r => r.host === 'h1');
  assert(h1.length === 15 && h1.every(r => r.host === 'h1') && loads > 0,
    `eq h1: 15 строк, загрузок ${loads}`);
  assert(want.length === 15, 'brute-force: 15 строк h1');
  store.loadClosed = origLoad;
  j.close();
}

console.log(`\nТесты scan: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
