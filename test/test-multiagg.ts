// Тесты multi-aggregate rollup (multi-agg): объявление agg-списка, multi-формат
// rollup-колонок (value_min/value_max/value_sum/value_count/value_last+ts/
// value_first+ts), ассоциативная склейка тиров для last/first через границу
// тиров и через два промоута, честная sum-семантика counter-метрик,
// обратная совместимость одиночной AggFn (легаси-формат), фолдинг
// пред-агрегированных строк (Aggregation.fromRollupRow/merge).
// Запуск: node test-multiagg.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/Store.ts';
import { defineLogTable } from '../src/compaction/define.ts';
import { Rollup } from '../src/metric/Rollup.ts';
import { Aggregation } from '../src/metric/Aggregation.ts';
import type { Row } from '../src/core/types.ts';

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
const baseDir = path.join(__dirname, '..', 'test-data', 'multiagg');
fs.rmSync(baseDir, { recursive: true, force: true });
let _tmpN = 0;
const tmpDir = () => path.join(baseDir, `t${_tmpN++}`);

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ============================================================================
console.log('Rollup.accumulate multi-формат (чистая функция):');
// ============================================================================
{
  const rows: Row[] = [
    { ts: 1000, host: 'a', value: 5 },
    { ts: 2000, host: 'a', value: 9 },
    { ts: 3000, host: 'a', value: 2 },
    { ts: 4500, host: 'a', value: 7 },
  ];
  const out = Rollup.promote(rows, {
    agg: { value: ['min', 'max', 'sum', 'count', 'last', 'first'] },
    dims: ['host'], res: 5000,
  });
  assert(out.length === 1, `1 бакет, got ${out.length}`);
  const r = out[0];
  assert(r['value_min'] === 2, `value_min = 2, got ${r['value_min']}`);
  assert(r['value_max'] === 9, `value_max = 9, got ${r['value_max']}`);
  assert(r['value_sum'] === 23, `value_sum = 23, got ${r['value_sum']}`);
  assert(r['value_count'] === 4, `value_count = 4, got ${r['value_count']}`);
  assert(r['value_last'] === 7 && r['value_last_ts'] === 4500, `value_last = 7@4500, got ${r['value_last']}@${r['value_last_ts']}`);
  assert(r['value_first'] === 5 && r['value_first_ts'] === 1000, `value_first = 5@1000, got ${r['value_first']}@${r['value_first_ts']}`);
  assert(r['value'] === undefined, `bare value-колонки нет (multi-формат)`);
}
{
  // Легаси-форма (одна fn) — прежний выход: одна скалярная колонка.
  const out = Rollup.promote(
    [{ ts: 1000, value: 2 }, { ts: 2000, value: 4 }],
    { agg: { value: 'avg' }, dims: [], res: 5000 },
  );
  assert(out[0]['value'] === 3 && out[0]['value_avg'] === undefined, `легаси: value = avg = 3, без value_avg`);
}
{
  // Склейка пред-агрегированных строк (tier→tier): last/first по (value, ts).
  const coarse: Row[] = [
    { ts: 0, host: 'a', value_min: 10, value_max: 20, value_sum: 30, value_count: 2, value_last: 20, value_last_ts: 900, value_first: 10, value_first_ts: 100 },
    { ts: 0, host: 'a', value_min: 1, value_max: 5, value_sum: 6, value_count: 2, value_last: 5, value_last_ts: 4900, value_first: 1, value_first_ts: 4100 },
  ];
  const out = Rollup.promote(coarse, {
    agg: { value: ['min', 'max', 'sum', 'count', 'last', 'first'] },
    dims: ['host'], res: 10_000,
  });
  const r = out[0];
  assert(r['value_min'] === 1 && r['value_max'] === 20, `merge: min=1 max=20, got ${r['value_min']}/${r['value_max']}`);
  assert(r['value_sum'] === 36 && r['value_count'] === 4, `merge: sum=36 count=4, got ${r['value_sum']}/${r['value_count']}`);
  assert(r['value_last'] === 5 && r['value_last_ts'] === 4900, `merge: last=5@4900 (по большему ts), got ${r['value_last']}@${r['value_last_ts']}`);
  assert(r['value_first'] === 10 && r['value_first_ts'] === 100, `merge: first=10@100 (по меньшему ts), got ${r['value_first']}@${r['value_first_ts']}`);
}

// ============================================================================
console.log('Aggregation: fromRollupRow / merge / rollupColumnsOf:');
// ============================================================================
{
  const cols = Aggregation.rollupColumnsOf('value', ['min', 'last', 'first', 'avg']);
  assert(cols.join(',') === 'value_min,value_last,value_last_ts,value_first,value_first_ts,value_avg', `rollupColumnsOf: ${cols.join(',')}`);
  const row: Row = { ts: 5000, value_last: 42, value_last_ts: 4990 };
  assert(Aggregation.hasRollupCols(row, 'value'), `hasRollupCols: rollup-строка распознана`);
  assert(!Aggregation.hasRollupCols({ ts: 1, value: 3 }, 'value'), `hasRollupCols: raw-строка — не rollup`);
  const acc = Aggregation.fromRollupRow(row, 'value');
  assert(acc !== null && acc.lastVal === 42 && acc.lastTs === 4990 && acc.count === 1, `fromRollupRow: last=42@4990, count=1`);
  const a = Aggregation.newAcc();
  Aggregation.addValue(a, 1, 100);
  Aggregation.addValue(a, 7, 200);
  const b = Aggregation.newAcc();
  Aggregation.addValue(b, 3, 50);
  Aggregation.addValue(b, 4, 150);
  Aggregation.merge(a, b);
  assert(a.count === 4 && a.sum === 15 && a.min === 1 && a.max === 7, `merge: count=4 sum=15 min=1 max=7`);
  assert(a.lastVal === 7 && a.lastTs === 200 && a.firstVal === 3 && a.firstTs === 50, `merge: last=7@200 first=3@50`);
}

// ============================================================================
console.log('Валидация объявления:');
// ============================================================================
{
  assertThrows(() => defineLogTable({
    name: 'bad', columns: { ts: 'delta', host: 'auto', value: 'auto' },
    retention: '1m:1h,10m:1d', agg: { value: ['min', 'median'] as never }, dims: ['host'],
  }), 'agg: неизвестная fn в списке → ошибка');
  assertThrows(() => defineLogTable({
    name: 'bad', columns: { ts: 'delta', host: 'auto', value: 'auto' },
    retention: '1m:1h,10m:1d', agg: { value: [] as never }, dims: ['host'],
  }), 'agg: пустой список → ошибка');
  const ok = defineLogTable({
    name: 'ok', columns: { ts: 'delta', host: 'auto', value: 'auto' },
    retention: '1m:1h,10m:1d', agg: { value: ['min', 'max', 'sum', 'count', 'last', 'first'] }, dims: ['host'],
  });
  assert(Array.isArray(ok.agg?.value), 'agg: список принят');
}

// ============================================================================
console.log('Таблица: multi-agg rollup + чтение через границу тиров:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'metrics',
    columns: { ts: 'delta', dev: 'auto', met: 'auto', value: 'auto' },
    retention: '5s:10m, 1m:2h, 15m:1d',
    agg: { value: ['min', 'max', 'sum', 'count', 'last', 'first'] },
    dims: ['dev', 'met'],
    rowsPerSegment: 8, nowProvider: () => NOW, autoRollup: false, autoPurge: false,
  }));
  assert(t.rollupColumns('value').includes('value_last_ts'), `rollupColumns('value') содержит value_last_ts`);
  assert(t.rollupColumns('dev').length === 0, `rollupColumns('dev') — пусто (не agg-поле)`);

  // gauge-метрика temp: 40 старых значений (2 часа назад, шаг 1м), пики 87 в середине
  for (let i = 0; i < 40; i++) {
    const v = i === 21 ? 87 : 40 + (i % 5);
    t.append({ ts: NOW - 2 * HOUR + i * MIN, dev: 'cpu', met: 'temp', value: v });
  }
  // counter-метрика requests: по 1 за событие, 30 штук (час назад)
  for (let i = 0; i < 30; i++) t.append({ ts: NOW - HOUR + i * 60_000, dev: 'http', met: 'requests', value: 1 });
  // свежие (raw-тир): последние 5 минут
  for (let i = 0; i < 5; i++) t.append({ ts: NOW - 4 * MIN + i * MIN, dev: 'cpu', met: 'temp', value: 55 });
  t.flush();

  const rep = t.rollup();
  assert(rep.pairs >= 1, `rollup: ${rep.pairs} пар`);

  // coarse-строки лежат в multi-формате
  const coarseRows = t.journal(1).scan({});
  const sample = coarseRows.find(r => r['dev'] === 'cpu');
  assert(sample !== undefined && sample['value_last_ts'] !== undefined, `coarse-строка содержит value_last_ts`);
  assert(sample!['value'] === undefined || sample!['value'] === null, `coarse-строка: bare value пустой`);

  // «пик температуры за сутки» — окно глубже raw-тира: max не пропал
  const aggMax = t.aggregate('now-1d', 'now', [{ field: 'value', fn: 'max' }], [
    { field: 'dev', op: 'eq', value: 'cpu' }, { field: 'met', op: 'eq', value: 'temp' },
  ]);
  assert(aggMax['value_max'] === 87, `max за сутки (через тир-колонки) = 87, got ${aggMax['value_max']}`);

  // «последнее значение за сутки» — last, а не среднее
  const aggLast = t.aggregate('now-1d', 'now', [{ field: 'value', fn: 'last' }], [
    { field: 'dev', op: 'eq', value: 'cpu' }, { field: 'met', op: 'eq', value: 'temp' },
  ]);
  assert(aggLast['value_last'] === 55, `last за сутки = 55 (свежее значение), got ${aggLast['value_last']}`);

  // «первое значение за сутки»
  const aggFirst = t.aggregate('now-1d', 'now', [{ field: 'value', fn: 'first' }], [
    { field: 'dev', op: 'eq', value: 'cpu' }, { field: 'met', op: 'eq', value: 'temp' },
  ]);
  assert(aggFirst['value_first'] === 40, `first за сутки = 40, got ${aggFirst['value_first']}`);

  // counter: sum за сутки = 30 (не «среднее»)
  const aggSum = t.aggregate('now-1d', 'now', [{ field: 'value', fn: 'sum' }, { field: 'value', fn: 'count' }], [
    { field: 'dev', op: 'eq', value: 'http' }, { field: 'met', op: 'eq', value: 'requests' },
  ]);
  assert(aggSum['value_sum'] === 30 && aggSum['value_count'] === 30, `counter sum за сутки = 30, got ${aggSum['value_sum']}`);

  // avg через тир-колонки = sum/count (в окне temp: 40 старых + 5 свежих)
  const aggAvg = t.aggregate('now-1d', 'now', [{ field: 'value', fn: 'avg' }], [
    { field: 'dev', op: 'eq', value: 'cpu' }, { field: 'met', op: 'eq', value: 'temp' },
  ]);
  let expSum = 0;
  for (let i = 0; i < 40; i++) expSum += i === 21 ? 87 : 40 + (i % 5);
  expSum += 55 * 5;
  assert(Math.abs((aggAvg['value_avg'] as number) - expSum / 45) < 1e-9, `avg = sum/count = честный, got ${aggAvg['value_avg']}`);

  t.close();
  store.closeAll();
}

// ============================================================================
console.log('Двухходовый промоут: last/first живут через два тира:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'm',
    columns: { ts: 'delta', tag: 'auto', value: 'auto' },
    retention: '1m:1h, 10m:1d, 1h:30d',
    agg: { value: ['min', 'max', 'sum', 'count', 'last', 'first'] },
    dims: ['tag'],
    rowsPerSegment: 8, nowProvider: () => NOW, autoRollup: false, autoPurge: false,
  }));
  // данные возрастом ~10 дней: уйдут в tier1, потом в tier2
  for (let i = 0; i < 60; i++) t.append({ ts: NOW - 10 * DAY + i * MIN, tag: 'x', value: i });
  t.flush();
  t.rollup(); // tier0 → tier1
  t.rollup(); // tier1 → tier2 (пред-агрегированные строки склеиваются)
  const tier2 = t.journal(2).scan({});
  assert(tier2.length > 0, `tier2 содержит строки после двух промоутов (${tier2.length})`);
  const agg = t.aggregate('now-30d', 'now', [
    { field: 'value', fn: 'min' }, { field: 'value', fn: 'max' },
    { field: 'value', fn: 'sum' }, { field: 'value', fn: 'count' },
    { field: 'value', fn: 'last' }, { field: 'value', fn: 'first' },
  ]);
  assert(agg['value_min'] === 0 && agg['value_max'] === 59, `2 промоута: min=0 max=59, got ${agg['value_min']}/${agg['value_max']}`);
  assert(agg['value_sum'] === 1770 && agg['value_count'] === 60, `2 промоута: sum=1770 count=60, got ${agg['value_sum']}/${agg['value_count']}`);
  assert(agg['value_last'] === 59 && agg['value_first'] === 0, `2 промоута: last=59 first=0, got ${agg['value_last']}/${agg['value_first']}`);
  t.close();
  store.closeAll();
}

// ============================================================================
console.log('Обратная совместимость: легаси-таблица (одна AggFn):');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'legacy',
    columns: { ts: 'delta', tag: 'auto', value: 'auto' },
    retention: '1m:1h, 10m:1d',
    agg: { value: 'avg' },
    dims: ['tag'],
    rowsPerSegment: 8, nowProvider: () => NOW, autoRollup: false, autoPurge: false,
  }));
  for (let i = 0; i < 20; i++) t.append({ ts: NOW - 3 * HOUR + i * MIN, tag: 'x', value: i });
  t.flush();
  t.rollup();
  const coarse = t.journal(1).scan({});
  assert(coarse.length > 0 && typeof coarse[0]['value'] === 'number', `легаси: coarse-строка с bare value (avg)`);
  assert(coarse[0]['value_min'] === undefined, `легаси: value_min-колонок нет`);
  const agg = t.aggregate('now-1d', 'now', [{ field: 'value', fn: 'avg' }]);
  assert(typeof agg['value_avg'] === 'number', `легаси: aggregate avg работает, got ${agg['value_avg']}`);
  // last на легаси-таблице — fold-путь (raw + легаси-скаляры как значения бакетов)
  const aggLast = t.aggregate('now-1d', 'now', [{ field: 'value', fn: 'last' }]);
  assert(typeof aggLast['value_last'] === 'number', `легаси: aggregate last работает (fold), got ${aggLast['value_last']}`);
  t.close();
  store.closeAll();
}

// ============================================================================
console.log('Персистентность: multi-agg def через reopen (манифест):');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir);
  // reopen не восстанавливает nowProvider (функция) — данные берём от реального now
  const t = store.create(defineLogTable({
    name: 'm', columns: { ts: 'delta', tag: 'auto', value: 'auto' },
    retention: '1m:1h,10m:1d', agg: { value: ['min', 'max', 'last'] }, dims: ['tag'],
    autoRollup: false, autoPurge: false,
  }));
  t.append({ ts: Date.now() - 2 * HOUR, tag: 'x', value: 7 });
  t.flush();
  t.close();
  store.closeAll();
  const store2 = new Store(dir);
  const t2 = store2.open('m');
  assert(t2.rollupColumns('value').includes('value_last'), `reopen: multiFields восстановлен из манифеста`);
  t2.rollup();
  const agg = t2.aggregate('now-1d', 'now', [{ field: 'value', fn: 'last' }]);
  assert(agg['value_last'] === 7, `reopen: last после rollup = 7, got ${agg['value_last']}`);
  t2.close();
  store2.closeAll();
}

console.log(`\nТесты multi-agg rollup: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
