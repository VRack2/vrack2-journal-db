// ============================================================
// test-sql.ts — SQL-lite поверх scan() (Фаза 5):
//   - SELECT/aggregate (avg/min/max/sum/count) + GROUP BY;
//   - WHERE (=, !=, <, <=, >, >=, BETWEEN, IN, NOT IN, IS [NOT] NULL);
//   - ORDER BY / LIMIT / OFFSET;
//   - raw-режим (SELECT * / SELECT fields);
//   - парсинг ошибок (SqlError).
// Каждый запрос проверяется против brute-force по allRows().
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import { parseSql, SqlError } from '../src/sql.ts';
import type { Schema, Row } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-sql');

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

fs.rmSync(baseDir, { recursive: true, force: true });

const T0 = 1_700_000_000_000; // фиксированная база (мс)
const H = 3_600_000;
const DAY = 86_400_000;

const schema: Schema = {
  ts: 'delta',
  host: 'dictionary',
  value: 'auto',
  level: 'dictionary',
  count: 'auto',
};

// --------------------------------------------------
// Данные: 3 хоста × 200 точек × 3 уровня, ts в пределах 2 суток.
// --------------------------------------------------
function makeRows(): Row[] {
  const rows: Row[] = [];
  const hosts = ['web-1', 'web-2', 'db-1'];
  const levels = ['info', 'warn', 'error'];
  let i = 0;
  for (const host of hosts) {
    for (let k = 0; k < 200; k++) {
      const ts = T0 + i * 60_000; // по 1 минуте
      const value = Math.round((10 + ((i * 37) % 90) + (host === 'db-1' ? 5 : 0)) * 10) / 10;
      const level = levels[i % levels.length];
      rows.push({ ts, host, value, level, count: 1 + (i % 5) });
      i++;
    }
  }
  return rows;
}

/** Глобальный набор строк (одни и те же для всех секций). */
const ROWS = makeRows();

/** Brute-force: применяет where-опции scan() вручную к всем строкам. */
function bruteFilter(rows: Row[], opts: {
  start?: number; end?: number;
  where?: { field: string; op: string; value?: unknown }[];
}): Row[] {
  const out = rows.filter(r => {
    if (opts.start !== undefined && opts.end !== undefined) {
      const ts = r.ts as number;
      if (typeof ts !== 'number' || ts < opts.start || ts > opts.end) return false;
    }
    for (const w of opts.where ?? []) {
      const v = (r as Record<string, unknown>)[w.field];
      const t = w.value;
      const tn = t as unknown as number;
      switch (w.op) {
        case 'eq': if (v !== t) return false; break;
        case 'ne': if (v === t) return false; break;
        case 'lt': if (typeof v !== 'number' || !(v < tn)) return false; break;
        case 'le': if (typeof v !== 'number' || !(v <= tn)) return false; break;
        case 'gt': if (typeof v !== 'number' || !(v > tn)) return false; break;
        case 'ge': if (typeof v !== 'number' || !(v >= tn)) return false; break;
        case 'in': if (!Array.isArray(t) || !t.includes(v)) return false; break;
        case 'nin': if (!Array.isArray(t) || t.includes(v)) return false; break;
        case 'isNull': if (v !== null && v !== undefined) return false; break;
        case 'isNotNull': if (v === null || v === undefined) return false; break;
      }
    }
    return true;
  });
  return out;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --------------------------------------------------
// 1. parseSql — базовый синтаксис
// --------------------------------------------------
{
  const o = parseSql('SELECT avg(value), host WHERE value > 90 GROUP BY host ORDER BY value_avg DESC LIMIT 20');
  assert(!!o.agg && Array.isArray(o.agg['value']) && o.agg['value'].includes('avg'), 'parseSql: avg(value) в agg');
  assert(JSON.stringify(o.groupBy) === JSON.stringify(['host']), 'parseSql: groupBy host');
  assert(!!o.where && o.where.length === 1 && o.where[0].op === 'gt' && o.where[0].value === 90, 'parseSql: where value>90');
  assert(o.order === 'desc', 'parseSql: order desc');
  assert(o.limit === 20, 'parseSql: limit 20');

  const o2 = parseSql('SELECT host, value WHERE ts BETWEEN \'now-1h\' AND \'now\' AND host = \'web-1\' LIMIT 10');
  assert(o2.start === 'now-1h' && o2.end === 'now', 'parseSql: ts BETWEEN → start/end');
  assert(JSON.stringify(o2.select) === JSON.stringify(['host', 'value']), 'parseSql: select host,value');
  assert(!!o2.where && o2.where.length === 1 && o2.where[0].op === 'eq' && o2.where[0].value === 'web-1', 'parseSql: where host=web-1');
  assert(o2.limit === 10, 'parseSql: limit 10');

  const o3 = parseSql('SELECT * WHERE level IN (\'error\', \'warn\') LIMIT 5');
  assert(o3.select === undefined, 'parseSql: SELECT * → select по умолчанию');
  assert(!!o3.where && o3.where.length === 1 && o3.where[0].op === 'in', 'parseSql: IN → in');
  assert(JSON.stringify(o3.where![0].value) === JSON.stringify(['error', 'warn']), 'parseSql: IN значения');
}

// --------------------------------------------------
// 2. Ошибки парсинга
// --------------------------------------------------
{
  const bad = [
    'SELEC value',                        // опечатка в ключе
    'SELECT foo(value)',                  // неизвестная функция
    'SELECT value WHERE value ~ 5',       // неизвестный оператор
    'SELECT value WHERE BETWEEN 1 AND 2', // нет поля в BETWEEN
    'SELECT value WHERE value =',         // нет значения
    'SELECT value LIMIT abc',             // limit не число
    'SELECT value WHERE value IN (',      // не закрытый IN
    'SELECT value WHERE x IS NOT',        // IS NOT без NULL
  ];
  for (const q of bad) {
    let threw = false;
    try { parseSql(q); } catch (e) { threw = e instanceof SqlError || e instanceof Error; }
    assert(threw, `parseSql бросает ошибку: ${q}`);
  }
}

// --------------------------------------------------
// 3. Выполнение: агрегаты + groupBy против brute-force
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100, lock: 'off' });
  j.open('m', schema, {});
  for (const r of ROWS) j.append(r);
  j.flush();
  j.close();

  // avg(value) по host
  const sql = "SELECT avg(value), min(value), max(value), sum(value), count(value), host GROUP BY host ORDER BY value_avg DESC";
  const res = new Journal(baseDir, { lock: 'off' });
  res.open('m', schema, {});
  const out = res.sql(sql);

  // brute-force: сгруппируем по host
  const groups = new Map<string, number[]>();
  for (const r of ROWS) {
    const arr = groups.get(r.host as string) ?? [];
    if (typeof r.value === 'number') arr.push(r.value as number);
    groups.set(r.host as string, arr);
  }
  assert(out.length === groups.size, `agg: число групп ${out.length} === ${groups.size}`);
  for (const g of out) {
    const host = g['host'] as string;
    const vals = groups.get(host) ?? [];
    assert(Math.abs((g['value_avg'] as number) - avg(vals)) < 1e-9, `agg ${host}: value_avg`);
    assert(g['value_min'] === Math.min(...vals), `agg ${host}: value_min`);
    assert(g['value_max'] === Math.max(...vals), `agg ${host}: value_max`);
    assert(Math.abs((g['value_sum'] as number) - vals.reduce((a, b) => a + b, 0)) < 1e-6, `agg ${host}: value_sum`);
    assert(g['value_count'] === vals.length, `agg ${host}: value_count`);
  }
  // order desc по value_avg
  const avgs = out.map(g => g['value_avg'] as number);
  for (let i = 1; i < avgs.length; i++) assert(avgs[i - 1] >= avgs[i], 'agg: order desc по value_avg');

  // where value > X + groupBy
  const X = 50;
  const res2 = new Journal(baseDir, { lock: 'off' });
  res2.open('m', schema, {});
  const out2 = res2.sql(`SELECT avg(value), count(value), host WHERE value > ${X} GROUP BY host`);
  const groups2 = new Map<string, number[]>();
  for (const r of ROWS) {
    if (typeof r.value === 'number' && (r.value as number) > X) {
      const arr = groups2.get(r.host as string) ?? [];
      arr.push(r.value as number);
      groups2.set(r.host as string, arr);
    }
  }
  assert(out2.length === groups2.size, 'where>50 agg: число групп');
  for (const g of out2) {
    const host = g['host'] as string;
    const vals = groups2.get(host) ?? [];
    assert(Math.abs((g['value_avg'] as number) - avg(vals)) < 1e-9, `where>50 agg ${host}: value_avg`);
  }
  res.close(); res2.close();
}

// --------------------------------------------------
// 4. raw-режим + WHERE + ORDER + LIMIT/OFFSET
// --------------------------------------------------
{
  // SELECT * WHERE host = 'web-1' ORDER BY ts DESC LIMIT 5
  const r1 = new Journal(baseDir, { lock: 'off' });
  r1.open('m', schema, {});
  const out1 = r1.sql("SELECT * WHERE host = 'web-1' ORDER BY ts DESC LIMIT 5");
  const bf1 = bruteFilter(ROWS,{ where: [{ field: 'host', op: 'eq', value: 'web-1' }] })
    .sort((a, b) => (b.ts as number) - (a.ts as number)).slice(0, 5);
  assert(out1.length === bf1.length, `raw: SELECT * host=web-1 length ${out1.length}===${bf1.length}`);
  for (let i = 0; i < bf1.length; i++) {
    assert(out1[i]['host'] === bf1[i]['host'] && (out1[i]['value'] as number) === (bf1[i]['value'] as number),
      `raw: строка ${i} совпадает`);
  }

  // LIMIT offset, count
  const r2 = new Journal(baseDir, { lock: 'off' });
  r2.open('m', schema, {});
  const out2 = r2.sql("SELECT host, value WHERE level = 'warn' ORDER BY ts ASC LIMIT 2, 3");
  const bf2 = bruteFilter(ROWS,{ where: [{ field: 'level', op: 'eq', value: 'warn' }] })
    .sort((a, b) => (a.ts as number) - (b.ts as number)).slice(2, 5);
  assert(out2.length === bf2.length, `raw: LIMIT 2,3 length ${out2.length}===${bf2.length}`);
  for (let i = 0; i < bf2.length; i++) {
    assert((out2[i]['host'] as string) === (bf2[i]['host'] as string), `raw: LIMIT 2,3 host[${i}]`);
  }

  // OFFSET
  const r3 = new Journal(baseDir, { lock: 'off' });
  r3.open('m', schema, {});
  const out3 = r3.sql("SELECT host WHERE level = 'error' ORDER BY ts ASC LIMIT 3 OFFSET 1");
  const bf3 = bruteFilter(ROWS,{ where: [{ field: 'level', op: 'eq', value: 'error' }] })
    .sort((a, b) => (a.ts as number) - (b.ts as number)).slice(1, 4);
  assert(out3.length === bf3.length, `raw: OFFSET length ${out3.length}===${bf3.length}`);

  // IN / NOT IN
  const r4 = new Journal(baseDir, { lock: 'off' });
  r4.open('m', schema, {});
  const out4 = r4.sql("SELECT host WHERE level IN ('error','warn')");
  const bf4 = bruteFilter(ROWS,{ where: [{ field: 'level', op: 'in', value: ['error', 'warn'] }] });
  assert(out4.length === bf4.length, `raw: IN length ${out4.length}===${bf4.length}`);
  const out4b = r4.sql("SELECT host WHERE level NOT IN ('error','warn')");
  const bf4b = bruteFilter(ROWS,{ where: [{ field: 'level', op: 'nin', value: ['error', 'warn'] }] });
  assert(out4b.length === bf4b.length, `raw: NOT IN length ${out4b.length}===${bf4b.length}`);

  // IS NULL / IS NOT NULL (поле count не должно быть null, host — не null)
  const r5 = new Journal(baseDir, { lock: 'off' });
  r5.open('m', schema, {});
  const out5 = r5.sql("SELECT host WHERE level IS NOT NULL");
  const bf5 = bruteFilter(ROWS,{ where: [{ field: 'level', op: 'isNotNull' }] });
  assert(out5.length === bf5.length, `raw: IS NOT NULL length ${out5.length}===${bf5.length}`);

  // BETWEEN на не-ts поле (value)
  const r6 = new Journal(baseDir, { lock: 'off' });
  r6.open('m', schema, {});
  const out6 = r6.sql('SELECT host WHERE value BETWEEN 40 AND 60');
  const bf6 = bruteFilter(ROWS,{ where: [
    { field: 'value', op: 'ge', value: 40 },
    { field: 'value', op: 'le', value: 60 },
  ]});
  assert(out6.length === bf6.length, `raw: BETWEEN length ${out6.length}===${bf6.length}`);

  r1.close(); r2.close(); r3.close(); r4.close(); r5.close(); r6.close();
}

// --------------------------------------------------
// 5. Диапазон ts (BETWEEN на ts) через реальные мс
// --------------------------------------------------
{
  const r = new Journal(baseDir, { lock: 'off' });
  r.open('m', schema, {});
  const start = T0;
  const end = T0 + 10 * H;
  // ts в select — scan() в raw-режиме сортирует по ts, только если он в проекции
  const out = r.sql(`SELECT ts, host, value WHERE ts BETWEEN ${start} AND ${end} ORDER BY ts ASC`);
  const bf = bruteFilter(ROWS,{ start, end }).sort((a, b) => (a.ts as number) - (b.ts as number));
  assert(out.length === bf.length, `ts BETWEEN length ${out.length}===${bf.length}`);
  for (let i = 0; i < Math.min(out.length, 5); i++) {
    assert((out[i]['ts'] as number) === (bf[i]['ts'] as number), `ts BETWEEN ts[${i}]`);
  }
  r.close();
}

console.log(`\nSQL-lite (Фаза 5): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
