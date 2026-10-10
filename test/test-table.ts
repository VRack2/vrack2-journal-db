// Тесты Table (Фазы 4-6) — мультитирная таблица метрик: create/define*Table,
// append, rollup (включая rollupOne и Rollup.promote/applyAgg), retention/purge,
// auto-обслуживание, aggregate, percentile, stats, close, валидация.
// Миграция test-merge-tree.ts (applyAgg/promote/tiers → Rollup/parseRetention).
// Запуск: node test-table.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/Store.ts';
import { Table, parseRetention } from '../src/Table.ts';
import { Rollup } from '../src/Rollup.ts';
import { defineLogTable, defineUpsertTable } from '../src/compaction/define.ts';
import type { Row } from '../src/types.ts';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
    failed++;
    console.error(`  ✗ FAIL (не бросило): ${msg}`);
  } catch {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'table');
fs.rmSync(baseDir, { recursive: true, force: true });
let _tmpN = 0;
const tmpDir = () => path.join(baseDir, `t${_tmpN++}`);

// Фиксированное «сейчас» — чтобы retention был детерминирован.
const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

// ============================================================================
console.log('parseRetention / validateTiers:');
// ============================================================================
{
  const tiers = parseRetention('5s:1d,15s:1w,1m:1mon');
  assert(tiers.length === 3, `'5s:1d,15s:1w,1m:1mon' → 3 тира`);
  assert(tiers[0].resMs === 5000, `tier0 res = 5000ms (5s)`);
  assert(tiers[0].ttlMs === DAY, `tier0 ttl = 1d`);
  assert(tiers[1].resMs === 15000, `tier1 res = 15000ms (15s)`);
  assert(tiers[1].ttlMs === WEEK, `tier1 ttl = 1w`);
  assert(tiers[2].resMs === 60000, `tier2 res = 60000ms (1m)`);
  assert(tiers[2].ttlMs === MONTH, `tier2 ttl = 30d`);
  assert(tiers[2].resMs > tiers[1].resMs && tiers[1].resMs > tiers[0].resMs, 'разрешения растут');

  assertThrows(() => parseRetention(''), 'пустая retention бросает');
  assertThrows(() => parseRetention('garbage'), 'мусор бросает');
  assertThrows(
    () => Table.validateTiers([{ resMs: 15000, ttlMs: WEEK }, { resMs: 5000, ttlMs: MONTH }]),
    'убывающие разрешения бросают'
  );
}

// ============================================================================
console.log('\ncreate(defineLogTable): append / query / манифест / open:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'cpu',
    columns: { ts: 'delta', value: 'auto', host: 'dictionary' },
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
    autoRollup: false, autoPurge: false, // rollup вызываем явно
  }));

  assert(t.tiers !== null && t.tiers.length === 3, '3 тира создано');
  assert(t.journalName(0) === 'cpu/r5000', `тир0 журнал cpu/r5000 (5s)`);
  assert(t.journalName(1) === 'cpu/r15000', `тир1 журнал cpu/r15000 (15s)`);
  assert(t.journalName(2) === 'cpu/r60000', `тир2 журнал cpu/r60000 (1m)`);
  assert(store.openJournals.has('cpu/r5000'), 'журнал тира0 в openJournals');
  assert(t.isOpen, 'таблица открыта');
  assert(t.agg['value'] === 'avg', 'agg.value = avg');
  assert(JSON.stringify(t.dims) === JSON.stringify(['host']), 'dims = [host]');

  for (let i = 0; i < 10; i++) {
    t.append({ ts: NOW - 1000 * (10 - i), host: 'web-1', value: i });
  }
  const q = t.query('now-1d', 'now');
  assert(q.length === 10, `query вернул 10 строк`);
  const vals = q.map(r => r['value'] as number).sort((a, b) => a - b);
  assert(JSON.stringify(vals) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'все 10 значений на месте');
  assert(q.every((r, i) => i === 0 || (r['ts'] as number) >= (q[i - 1]['ts'] as number)), 'сортировка по ts ↑');

  // манифест + open (dedup) + неизвестное имя
  assert(store.tables().includes('cpu'), 'cpu в store.tables() (манифест _store.json)');
  assert(store.engineOf('cpu') === 'log', 'store.engineOf(cpu) = log');
  assert(store.open('cpu') === t, 'store.open(cpu) вернул ту же открытую таблицу');
  assertThrows(() => store.open('нет-такой'), "open('нет-такой') бросает (нет ни в манифесте, ни на диске)");

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\nRollup: тонкий → грубый, идемпотентность:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'mem',
    columns: { ts: 'delta', value: 'auto' },
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
    autoRollup: false, autoPurge: false,
  }));

  for (let i = 0; i < 10; i++) {
    t.append({ ts: NOW - DAY * 2 + 1000 * i, value: i * 10 });
  }
  let st = t.stats();
  assert(st[0].rows === 10, `до rollup: в тире0 10 строк, got ${st[0].rows}`);
  assert(st[1].rows === 0, `до rollup: в тире1 0 строк`);
  assert(st[2].rows === 0, `до rollup: в тире2 0 строк`);

  const rep = t.rollup();
  assert(rep.pairs === 2, `rollup обработал 2 пары тиров, got ${rep.pairs}`);
  assert(rep.rolledRows === 10, `rollup перенёс 10 строк, got ${rep.rolledRows}`);
  assert(rep.purgedRows === 10, `rollup удалил 10 строк из тонкого тира, got ${rep.purgedRows}`);

  st = t.stats();
  assert(st[0].rows === 0, `после rollup: в тире0 0 строк, got ${st[0].rows}`);
  assert(st[1].rows > 0, `после rollup: в тире1 ${st[1].rows} строк (агрегаты)`);
  assert(st[2].rows === 0, `после rollup: в тире2 0 строк`);

  const rep2 = t.rollup();
  assert(rep2.pairs === 0, `повторный rollup — 0 пар (идемпотентно), got ${rep2.pairs}`);
  assert(rep2.rolledRows === 0, `повторный rollup — 0 перенесённых строк`);
  const st2 = t.stats();
  assert(st2[1].rows === st[1].rows, 'повторный rollup не создал новых строк');

  const q = t.query('now-1w', 'now');
  assert(q.length > 0, `query после rollup вернул ${q.length} строк`);

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\nRollup: агрегация avg, бакеты 15s:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'net',
    columns: { ts: 'delta', value: 'auto' },
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
    autoRollup: false, autoPurge: false,
  }));

  const B = Math.floor((NOW - 2 * DAY) / 15000) * 15000;
  t.append({ ts: B + 5000, value: 10 });
  t.append({ ts: B + 10000, value: 20 });
  t.append({ ts: B + 15000, value: 30 }); // другой бакет (B+15s)

  t.rollup();
  const st = t.stats();
  assert(st[1].rows === 2, `тир1: 2 строки (2 бакета), got ${st[1].rows}`);

  const coarse = t.journal(1).allRows();
  const v1 = coarse.map(r => r['value'] as number).sort((a, b) => a - b);
  assert(JSON.stringify(v1) === JSON.stringify([15, 30]), `тир1: avg(10,20)=15 и avg(30)=30, got ${JSON.stringify(v1)}`);

  const q = t.query(B, B + 30000);
  assert(q.length === 2, `query в окне вернул 2 строки, got ${q.length}`);

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\nRollup: склейка по трём тирам:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'io',
    columns: { ts: 'delta', value: 'auto' },
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
    autoRollup: false, autoPurge: false,
  }));

  // Данные в окне (1w, 1mon]: после одного rollup проходят tier0 → tier1 → tier2.
  const B = Math.floor((NOW - 10 * DAY) / 60000) * 60000;
  t.append({ ts: B + 5000, value: 100 });
  t.append({ ts: B + 10000, value: 200 });

  t.rollup(); // многоходовый: tier0 → tier1 (старше 1d) → tier2 (старше 1w)

  const st = t.stats();
  assert(st[0].rows === 0, `tier0: 0 строк, got ${st[0].rows}`);
  assert(st[1].rows === 0, `tier1: 0 строк (перенесено в tier2), got ${st[1].rows}`);
  assert(st[2].rows === 1, `tier2: 1 строка (агрегат 1m), got ${st[2].rows}`);

  // Окно шире бакета (B — округленный вниз бакет, строка лежит на B).
  const q = t.query(B - 1000, B + 61000);
  assert(q.length === 1, `query вернул 1 строку (агрегат 1m), got ${q.length}`);
  assert(q.length === 1 && q[0]['ts'] === B, `агрегат в бакете 1m, got ${JSON.stringify(q)}`);
  assert(q[0]['value'] === 150, `avg(100,200)=150, got ${q[0]?.value}`);

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\naggregate(): агрегация по бакетам в диапазоне:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'agg',
    columns: { ts: 'delta', value: 'auto' },
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
    autoRollup: false, autoPurge: false,
  }));

  // Свежие строки (в пределах 1d) — остаются в тонком тире.
  const B = Math.floor((NOW - 3600_000) / 60000) * 60000;
  for (let i = 0; i < 60; i++) {
    t.append({ ts: B + i * 1000, value: i });
  }

  // 60 строк значений 0..59 в одном бакете → avg = 29.5
  const aggr = t.aggregate('now-1d', 'now', [
    { field: 'value', fn: 'avg' },
    { field: 'value', fn: 'sum' },
    { field: 'value', fn: 'count' },
  ]);
  assert(aggr['value__avg'] === 29.5, `aggregate: value__avg = 29.5, got ${aggr['value__avg']}`);
  assert(aggr['value__sum'] === 1770, `aggregate: value__sum = 1770, got ${aggr['value__sum']}`);
  assert(aggr['value__count'] === 60, `aggregate: value__count = 60, got ${aggr['value__count']}`);

  assertThrows(
    () => t.aggregate('now-1d', 'now', []),
    'aggregate: пустой exprs бросает'
  );
  assertThrows(
    () => t.aggregate('now-1d', 'now', [{ field: 'value', fn: 'median' as never }]),
    'aggregate: неизвестная fn бросает'
  );

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\nstats() / close():');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'st',
    columns: { ts: 'delta', value: 'auto' },
    retention: '5s:1d,15s:1w',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
    autoRollup: false, autoPurge: false,
  }));

  for (let i = 0; i < 50; i++) {
    t.append({ ts: NOW - 2 * DAY + i * 10, value: i });
  }
  t.rollup();
  const st = t.stats();
  assert(st.length === 2, 'stats() — по 2 тира');
  assert(st[1].rows > 0, `stats тир1: ${st[1].rows} строк > 0`);
  assert(st[1].bytes > 0, 'stats тир1: bytes > 0');

  assert(store.openTables.has('st'), 'openTables: st открыта');
  t.close();
  assert(!store.openJournals.has('st/r5000') && !store.openJournals.has('st/r15000'), 'close: тиры закрыты');
  assert(!t.isOpen, 'close: t.isOpen = false');
  assertThrows(() => t.append({ ts: NOW, value: 1 }), 'append после close бросает');
  store.closeAll();
}

// ============================================================================
console.log('\nПредсказуемый размер (100 строк в одном тире):');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'size',
    columns: { ts: 'delta', value: 'auto' },
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
    autoRollup: false, autoPurge: false,
  }));

  for (let i = 0; i < 100; i++) {
    t.append({ ts: NOW - 2 * DAY + i * 10, value: i });
  }
  t.flush(); // bytes считаются по закрытым сегментам
  const st = t.stats();
  assert(st[0].rows === 100, `тир0: 100 строк`);
  assert(st[0].bytes > 0 && st[0].bytes < 100 * 1000, `тир0: bytes в разумных пределах (${st[0].bytes})`);

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\ndefine*Table: валидация:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });

  const def = defineLogTable({
    name: 'fab',
    columns: { ts: 'delta', value: 'auto' },
    retention: '5s:1d,15s:1w',
    agg: { value: 'avg' },
  });
  const t = store.create(def);
  assert(t instanceof Table, 'create вернул Table');
  assert(t.agg['value'] === 'avg', 'agg.value = avg');
  assert(t.dims.length === 0, 'dims = [] (схема − ts − agg)');
  assert(t.tiers !== null && t.tiers.length === 2, '2 тира');

  assertThrows(
    () => defineLogTable({ name: 'x/y', columns: { ts: 'delta', value: 'auto' } }),
    'имя с "/" бросает'
  );
  assertThrows(
    () => defineLogTable({ name: 'noagg', columns: { ts: 'delta', value: 'auto' }, retention: '5s:1d' }),
    'retention без agg бросает'
  );
  assertThrows(
    () => defineLogTable({
      name: 'badagg', columns: { ts: 'delta', value: 'auto' },
      retention: '5s:1d', agg: { value: 'median' as never },
    }),
    'неизвестная agg-функция бросает'
  );
  assertThrows(
    () => defineLogTable({
      name: 'badtiers', columns: { ts: 'delta', value: 'auto' },
      tiers: [{ resMs: 15000, ttlMs: WEEK }, { resMs: 5000, ttlMs: MONTH }],
      agg: { value: 'avg' },
    }),
    'убывающие tiers бросают'
  );

  // Явные tiers (приоритет над retention) + одиночная таблица (без retention)
  const t2 = store.create(defineLogTable({
    name: 'explicit',
    columns: { ts: 'delta', value: 'auto' },
    tiers: [{ resMs: 5000, ttlMs: DAY }, { resMs: 15000, ttlMs: WEEK }],
    agg: { value: 'avg' },
  }));
  assert(t2.tiers !== null && t2.tiers.length === 2, 'явные tiers — 2 тира');
  assert(t2.journalName(0) === 'explicit/r5000', 'явные tiers: имя журнала explicit/r5000');

  const single = store.create(defineLogTable({
    name: 'single',
    columns: { ts: 'delta', value: 'auto' },
  }));
  assert(single.tiers === null, 'без retention — одиночный режим (tiers = null)');
  assert(single.journalName(0) === 'single', 'одиночный режим: журнал <name>');
  assertThrows(() => single.rollup(), 'rollup() одиночной таблицы бросает');

  store.closeAll();
}

// ============================================================================
console.log('\npercentile():');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'pctl',
    columns: { ts: 'delta', value: 'auto' },
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
    autoRollup: false, autoPurge: false,
  }));

  for (let i = 0; i < 100; i++) {
    t.append({ ts: NOW - 3600_000 + i * 10, value: i + 1 });
  }
  const p = t.percentile('now-1d', 'now', [0.5, 0.9]);
  assert(p['p50'] === 50.5, `percentile: p50 = 50.5, got ${p['p50']}`);
  assert(Math.abs((p['p90'] as number) - 90.1) < 1e-9, `percentile: p90 ≈ 90.1, got ${p['p90']}`);
  assertThrows(() => t.percentile('now-1d', 'now', 0), 'percentile: level=0 бросает');

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\nRollup.applyAgg / Rollup.promote (чистые функции, было в merge-tree):');
// ============================================================================
{
  assert(Rollup.applyAgg('count', [1, 2, 3]) === 3, 'count([1,2,3]) = 3');
  assert(Rollup.applyAgg('sum', [1, 2, 3]) === 6, 'sum([1,2,3]) = 6');
  assert(Rollup.applyAgg('min', [5, 1, 3]) === 1, 'min([5,1,3]) = 1');
  assert(Rollup.applyAgg('max', [5, 1, 3]) === 5, 'max([5,1,3]) = 5');
  assert(Rollup.applyAgg('avg', [2, 4]) === 3, 'avg([2,4]) = 3');
  assert(Number.isNaN(Rollup.applyAgg('avg', [])), 'avg([]) = NaN (пустой ввод)');

  // 6 строк, 2 бакета (60s), 2 хоста. avg по value.
  const rows: Row[] = [
    { ts: 1000, host: 'h1', value: 10 },
    { ts: 2000, host: 'h1', value: 20 },
    { ts: 70000, host: 'h1', value: 30 },
    { ts: 1000, host: 'h2', value: 100 },
    { ts: 2000, host: 'h2', value: 200 },
    { ts: 70000, host: 'h2', value: 300 },
  ];
  const out = Rollup.promote(rows, { value: 'avg' }, ['host'], 60000);

  assert(out.length === 4, `4 группы (2 бакета × 2 хоста), got ${out.length}`);
  const g = (bucket: number, host: string) => out.find(r => r.ts === bucket && r.host === host);
  assert(g(0, 'h1')?.value === 15, 'бакет0 h1 avg(10,20)=15');
  assert(g(0, 'h2')?.value === 150, 'бакет0 h2 avg(100,200)=150');
  assert(g(60000, 'h1')?.value === 30, 'бакет60s h1 = 30');
  assert(g(60000, 'h2')?.value === 300, 'бакет60s h2 = 300');

  const out2 = Rollup.promote(rows, { value: 'sum' }, ['host'], 60000);
  assert(out2.find(r => r.ts === 0 && r.host === 'h1')?.value === 30, 'sum бакет0 h1 = 30');

  assert(Rollup.promote([], { value: 'avg' }, ['host'], 60000).length === 0, 'пустой ввод → 0 строк');

  // cfg-форма == явная форма
  const small: Row[] = [
    { ts: 1000, host: 'h1', value: 10 },
    { ts: 2000, host: 'h1', value: 30 },
  ];
  const byCfg = Rollup.promote(small, { agg: { value: 'max' }, dims: ['host'], res: 60000 });
  assert(byCfg.length === 1 && byCfg[0].value === 30, 'promote(rows, cfg): max(10,30)=30');
  assert(
    JSON.stringify(byCfg) === JSON.stringify(Rollup.promote(small, { value: 'max' }, ['host'], 60000)),
    'cfg-форма == явная форма'
  );
}

// ============================================================================
console.log('\nrollupOne(cfg): явный agg/цель (было rollup(cfg) в merge-tree):');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'cfg',
    columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
    retention: '1s:5s,60s:10m',
    agg: { value: 'avg' },
    dims: ['host'],
    nowProvider: () => 100000,
    autoRollup: false, autoPurge: false,
  }));
  t.append({ ts: 1000, host: 'h1', value: 10 });
  t.append({ ts: 2000, host: 'h1', value: 30 });

  // Явный cfg: max вместо avg таблицы, цель — тир res=60000.
  const rep = t.rollupOne({ agg: { value: 'max' }, dims: ['host'], res: 60000 }, 100000);
  assert(rep.tierIndex === 1 && rep.resMs === 60000, `rollupOne: целевой тир 1 (60s), got ${rep.tierIndex}`);
  assert(rep.sourceRows === 2, `rollupOne: 2 исходных строки, got ${rep.sourceRows}`);
  assert(rep.promotedRows === 1, `rollupOne: 1 агрегат, got ${rep.promotedRows}`);
  const coarse = t.journal(1).allRows();
  assert(coarse.length === 1 && coarse[0].value === 30, `rollupOne: max(10,30)=30 (не avg=20), got ${coarse[0]?.value}`);

  // rollup() — agg по умолчанию таблицы (avg)
  const dir2 = tmpDir();
  const store2 = new Store(dir2, { autoCompact: false });
  const t2 = store2.create(defineLogTable({
    name: 'def',
    columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
    retention: '1s:5s,60s:10m',
    agg: { value: 'avg' },
    dims: ['host'],
    nowProvider: () => 100000,
    autoRollup: false, autoPurge: false,
  }));
  t2.append({ ts: 1000, host: 'h1', value: 10 });
  t2.append({ ts: 2000, host: 'h1', value: 30 });
  t2.rollup();
  const coarse2 = t2.journal(1).allRows();
  assert(coarse2.length === 1 && coarse2[0].value === 20, `rollup(): avg(10,30)=20, got ${coarse2[0]?.value}`);

  // Неизвестная/нижняя цель — ошибка
  assertThrows(
    () => t.rollupOne({ agg: { value: 'max' }, dims: ['host'], res: 999999 }),
    'rollupOne: нет тира res=999999 → ошибка'
  );
  assertThrows(
    () => t.rollupOne({ agg: { value: 'max' }, dims: ['host'], res: 1000 }),
    'rollupOne: тир 0 — не цель rollup → ошибка'
  );

  t.close();
  store.closeAll();
  t2.close();
  store2.closeAll();
}

// ============================================================================
console.log('\nupsert + retention: движок тиров, dedup в грубом тире:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineUpsertTable({
    name: 'dedup',
    columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
    key: ['host'],
    version: 'ts',
    retention: '1s:5s,60s:10m',
    agg: { value: 'sum' },
    dims: ['host'],
    autoRollup: false, autoPurge: false,
  }));

  const meta = (i: number) => (t.journal(i).metadata ?? {}) as { _engine?: { kind: string; key: string[] } };
  assert(meta(1)._engine?.kind === 'upsert', 'грубый тир: движок upsert (из метаданных журнала)');
  assert(
    JSON.stringify(meta(1)._engine?.key) === JSON.stringify(['ts', 'host']),
    'грубый тир: key = [ts, host] (бакет — часть ключа)'
  );
  assert(meta(0)._engine?.kind === 'upsert', 'тонкий тир: тот же движок (единая семантика таблицы)');

  // dedup в грубом тире: две строки одного (ts, host) → compact оставляет более позднюю.
  // compact сливает закрытые сегменты (>= 2) — фиксируем каждый append flush'ом.
  t.journal(1).append({ ts: 120000, host: 'h1', value: 10 });
  t.journal(1).flush();
  t.journal(1).append({ ts: 120000, host: 'h1', value: 20 });
  t.journal(1).flush();
  t.compact();
  const rows = t.journal(1).allRows();
  assert(rows.length === 1, `compact: 2 строки (ts,host) → 1, got ${rows.length}`);
  assert(rows[0].value === 20, `upsert: более поздняя строка побеждает (value=20), got ${rows[0]?.value}`);

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\nauto-обслуживание: rollup + purge при append ( advancing nowProvider ):');
// ============================================================================
{
  let curNow = 100000;
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'auto',
    columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
    retention: '1s:5s,60s:10m',
    agg: { value: 'avg' },
    dims: ['host'],
    nowProvider: () => curNow,
    autoRollup: true, autoPurge: true,
    maintenanceMinIntervalMs: 0, // каждый append — обслуживание
  }));

  // Каждый append запускает обслуживание (maintenanceMinIntervalMs: 0).
  // Шаг 1: ts=1000 ≤ now-5s → переносится в грубый бакет 0.
  t.append({ ts: 1000, host: 'h1', value: 10 });
  let st = t.stats();
  assert(st[0].rows === 0, `auto: тонкий тир пуст (перенесено), got ${st[0].rows}`);
  let coarse = t.journal(1).allRows();
  assert(coarse.length === 1 && coarse[0].value === 10 && coarse[0].ts === 0, `auto: бакет 0, avg(10)=10, got ${JSON.stringify(coarse)}`);

  // Шаг 2: время прошло, новая строка → rollup в бакет 120s.
  curNow = 200000;
  t.append({ ts: 150000, host: 'h1', value: 20 });
  st = t.stats();
  assert(st[0].rows === 0, `auto: тонкий тир пуст, got ${st[0].rows}`);
  coarse = t.journal(1).allRows().sort((a, b) => Number(a.ts) - Number(b.ts));
  assert(
    coarse.length === 2 && coarse[0].ts === 0 && coarse[1].ts === 120000,
    `auto: два бакета (0 и 120s), got ${JSON.stringify(coarse.map(r => r.ts))}`
  );

  // Шаг 3: время прошло ещё — авто-purge (ttl 10m) уносит старые бакеты.
  curNow = 800000;
  t.append({ ts: 750000, host: 'h1', value: 30 });
  st = t.stats();
  assert(st[0].rows === 0, `auto: тонкий тир пуст, got ${st[0].rows}`);
  coarse = t.journal(1).allRows();
  assert(coarse.length === 1, `auto: старые бакеты purged, остался новый, got ${coarse.length}`);
  assert(coarse[0].ts === 720000, `auto: новый бакет 720000, got ${coarse[0]?.ts}`);
  assert(coarse[0].value === 30, `auto: avg(30)=30, got ${coarse[0]?.value}`);

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('\nretention/purge: явное удаление по границе:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'ret',
    columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
    retention: '1s:5s,60s:10m',
    agg: { value: 'avg' },
    dims: ['host'],
    nowProvider: () => 100000,
    autoRollup: false, autoPurge: false,
  }));

  t.append({ ts: 1000, host: 'h1', value: 10 });
  t.append({ ts: 99000, host: 'h1', value: 99 }); // свежая (ts > 100000-5000)

  t.rollup(100000); // ts=1000 → грубый бакет 0; ts=99000 остаётся в тонком
  let st = t.stats();
  assert(st[0].rows === 1, `retention: тонкий тир — 1 свежая строка, got ${st[0].rows}`);
  assert(st[1].rows === 1, `retention: грубый тир — 1 агрегат, got ${st[1].rows}`);

  // Явный purge: оставить ts >= 99000 (грубый агрегат ts=0 уходит).
  const p = t.purge(99000);
  assert(p.removedRows === 1, `purge(99000): удалена 1 строка (агрегат ts=0), got ${p.removedRows}`);
  st = t.stats();
  assert(st[0].rows === 1, 'после purge: свежая строка на месте');
  assert(st[1].rows === 0, 'после purge: грубый тир пуст');

  const q = t.query(0, 100000);
  assert(q.length === 1 && q[0].ts === 99000, `query: осталась свежая строка ts=99000, got ${JSON.stringify(q)}`);

  t.close();
  store.closeAll();
}

console.log(`\nТесты table (Фазы 4-6): ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
