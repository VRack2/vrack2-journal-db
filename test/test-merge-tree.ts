// Тесты Фазы 2 — движки: rollup (promote/applyAgg), retention (tiersForRetention),
// Tier, MergeTree (мультитирная таблица + rollup + retention).
// Запуск: node test-merge-tree.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/Store.ts';
import {
  applyAgg,
  promote,
  tiersForRetention,
  validateTiers,
  MergeTree,
} from '../src/index.ts';

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
const baseDir = path.join(__dirname, '..', '.test-data-merge');
fs.rmSync(baseDir, { recursive: true, force: true });
let _tmpN = 0;
const tmpDir = () => path.join(baseDir, `t${_tmpN++}`);

const SCHEMA = { ts: 'delta', host: 'dictionary', value: 'auto' } as const;

// ============================================================================
console.log('applyAgg:');
// ============================================================================
{
  assert(applyAgg('count', [1, 2, 3]) === 3, 'count([1,2,3]) = 3');
  assert(applyAgg('sum', [1, 2, 3]) === 6, 'sum([1,2,3]) = 6');
  assert(applyAgg('min', [5, 1, 3]) === 1, 'min([5,1,3]) = 1');
  assert(applyAgg('max', [5, 1, 3]) === 5, 'max([5,1,3]) = 5');
  assert(applyAgg('avg', [2, 4]) === 3, 'avg([2,4]) = 3');
}

// ============================================================================
console.log('\npromote (группировка + agg):');
// ============================================================================
{
  // 6 строк, 2 бакета (60s), 2 хоста. avg по value.
  const rows = [
    { ts: 1000, host: 'h1', value: 10 },
    { ts: 2000, host: 'h1', value: 20 },
    { ts: 70000, host: 'h1', value: 30 },
    { ts: 1000, host: 'h2', value: 100 },
    { ts: 2000, host: 'h2', value: 200 },
    { ts: 70000, host: 'h2', value: 300 },
  ];
  const out = promote(rows, { value: 'avg' }, ['host'], 60000);

  // бакет 0 (0-59s): h1 → avg(10,20)=15; h2 → avg(100,200)=150
  // бакет 60000: h1 → 30; h2 → 300
  assert(out.length === 4, `4 группы (2 бакета × 2 хоста), got ${out.length}`);

  const g = (bucket: number, host: string) => out.find(r => r.ts === bucket && r.host === host);
  assert(g(0, 'h1')?.value === 15, `бакет0 h1 avg(10,20)=15`);
  assert(g(0, 'h2')?.value === 150, `бакет0 h2 avg(100,200)=150`);
  assert(g(60000, 'h1')?.value === 30, `бакет60s h1 = 30`);
  assert(g(60000, 'h2')?.value === 300, `бакет60s h2 = 300`);

  // sum-агрегация
  const out2 = promote(rows, { value: 'sum' }, ['host'], 60000);
  assert(out2.find(r => r.ts === 0 && r.host === 'h1')?.value === 30, 'sum бакет0 h1 = 30');

  // пустой ввод
  assert(promote([], { value: 'avg' }, ['host'], 60000).length === 0, 'пустой ввод → 0 строк');
}

// ============================================================================
console.log('\ntiersForRetention / validateTiers:');
// ============================================================================
{
  const tiers = tiersForRetention('5s:1d,15s:1w,1m:1mon');
  assert(tiers.length === 3, `'5s:1d,15s:1w,1m:1mon' → 3 тира`);
  assert(tiers[0].resMs === 5000, `tier0 res = 5000ms (5s)`);
  assert(tiers[0].ttlMs === 86_400_000, `tier0 ttl = 86400000ms (1d)`);
  assert(tiers[2].resMs > tiers[1].resMs, 'разрешения неубывают');

  assertThrows(() => tiersForRetention(''), 'пустая retention бросает');
  assertThrows(() => tiersForRetention('garbage'), 'мусор бросает');
  assertThrows(
    () => validateTiers([{ resMs: 10, ttlMs: 100 }, { resMs: 5, ttlMs: 200 }]),
    'убывающие разрешения бросают'
  );
}

// ============================================================================
console.log('\nMergeTree: append / rollup / retention / query:');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const T = new MergeTree({
    name: 'mt',
    store,
    tiers: [
      { resMs: 1000, ttlMs: 5000 },    // тонкий: 1s, живёт 5s
      { resMs: 60000, ttlMs: 600000 }, // грубый: 60s, живёт 10min
    ],
    schema: SCHEMA,
    agg: { value: 'avg' },
    dims: ['host'],
  });

  assert(T.tierObjs.length === 2, '2 тира создано');
  assert(T.isOpen, 'открыта');

  // Записи в тонкий тир.
  T.append({ ts: 1000, host: 'h1', value: 10 });
  T.append({ ts: 2000, host: 'h1', value: 20 });
  T.append({ ts: 3000, host: 'h1', value: 30 });
  T.append({ ts: 99000, host: 'h1', value: 99 }); // свежая (ts > now-5s при now=100000)

  let stats = T.stats();
  assert(stats[0].rows === 4, `до rollup: в тонком тире 4 строки`);
  assert(stats[1].rows === 0, `до rollup: в грубом тире 0 строк`);

  // rollup при now = 100000: maxRollable = 100000 - 5000 = 95000.
  // ts 1000/2000/3000 ≤ 95000 → переносятся; ts 99000 > 95000 → остаётся.
  const report = T.rollup(100000);
  assert(report.rolledRows === 3, `rollup перенёс 3 строки (свежая осталась)`);
  assert(report.purgedRows === 3, `rollup удалил 3 строки из тонкого тира`);

  stats = T.stats();
  assert(stats[0].rows === 1, `после rollup: в тонком 1 строка (свежая 99000)`);
  assert(stats[1].rows === 1, `после rollup: в грубом 1 строка (агрегат)`);

  const coarse = T.tierObjs[1].allRows();
  assert(coarse.length === 1, 'грубый тир: 1 агрегированная строка');
  assert(coarse[0].ts === 0, `агрегат в бакете 0 (roundTime(1000..3000, 60000)=0)`);
  assert(coarse[0].host === 'h1', 'агрегат: host=h1');
  assert(coarse[0].value === 20, `агрегат: avg(10,20,30)=20, got ${coarse[0].value}`);

  // идемпотентность: второй rollup того же now — 0 пар
  const report2 = T.rollup(100000);
  assert(report2.pairs === 0, 'повторный rollup того же now — 0 пар (идемпотентно)');

  // query: склейка тонкого + грубого по ts ↑
  const q = T.query(0, 100000);
  assert(q.length === 2, `query вернул 2 строки (агрегат ts=0 + свежая ts=99000)`);
  assert(q[0].ts === 0 && q[1].ts === 99000, 'query отсортирован по ts ↑');

  // retention при now=100000: тонкий ttl=5000 → purge ts<95000 (свежая 99000 остаётся);
  // грубый ttl=600000 → purge ts< -500000 (ничего, агрегат ts=0… ts=0 < -500000? нет, 0 > -500000 → остаётся)
  const ret = T.retention(100000);
  assert(ret.purgedByTier.length === 2, 'retention вернул 2 значения (по тирам)');

  T.close();
  store.closeAll();
}

// ============================================================================
console.log('\nMergeTree: грубые тиры — upsert-движок (dedup при повторном rollup):');
// ============================================================================
{
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const T = new MergeTree({
    name: 'dedup',
    store,
    tiers: [
      { resMs: 1000, ttlMs: 5000 },
      { resMs: 60000, ttlMs: 600000 },
    ],
    schema: SCHEMA,
    agg: { value: 'sum' },
    dims: ['host'],
  });

  // Грубый тир должен быть upsert (key=[ts,host], version=ts)
  const coarseMeta = T.tierObjs[1].journal.metadata as { _engine?: { kind: string; key: string[] } } | null;
  assert(coarseMeta?._engine?.kind === 'upsert', 'грубый тир: движок upsert');
  assert(
    JSON.stringify(coarseMeta?._engine?.key) === JSON.stringify(['ts', 'host']),
    'грубый тир: key = [ts, host]'
  );
  // Тонкий — log
  const fineMeta = T.tierObjs[0].journal.metadata as { _engine?: { kind: string } } | null;
  assert(!fineMeta?._engine || fineMeta._engine.kind === 'log', 'тонкий тир: движок log (нет _engine)');

  T.close();
  store.closeAll();
}

// ============================================================================
console.log('\nPhase 3: promote(rows, cfg) и MergeTree.rollup(cfg) — явный конфиг:');
// ============================================================================
{
  // cfg-форма promote
  const rows = [
    { ts: 1000, host: 'h1', value: 10 },
    { ts: 2000, host: 'h1', value: 30 },
  ];
  const byCfg = promote(rows, { agg: { value: 'max' }, dims: ['host'], res: 60000 });
  assert(byCfg.length === 1 && byCfg[0].value === 30, 'promote(rows, cfg): max(10,30)=30');
  const byCfg2 = promote(rows, { agg: { value: 'sum' }, dims: ['host'], res: 60000 });
  assert(byCfg2[0].value === 40, 'promote(rows, cfg): sum(10,30)=40');
  // эквивалентность двух форм
  assert(
    JSON.stringify(byCfg) === JSON.stringify(promote(rows, { value: 'max' }, ['host'], 60000)),
    'cfg-форма == явная форма'
  );

  // rollup(cfg) — один тир с явным agg, отличным от дефолта таблицы
  const dir = tmpDir();
  const store = new Store(dir, { autoCompact: false });
  const T = new MergeTree({
    name: 'cfg',
    store,
    tiers: [
      { resMs: 1000, ttlMs: 5000 },
      { resMs: 60000, ttlMs: 600000 },
    ],
    schema: SCHEMA,
    agg: { value: 'avg' }, // дефолт — avg
    dims: ['host'],
  });
  T.append({ ts: 1000, host: 'h1', value: 10 });
  T.append({ ts: 2000, host: 'h1', value: 30 });

  // rollup с явным cfg: max вместо avg, цель — тир res=60000
  const rep = T.rollup({ agg: { value: 'max' }, dims: ['host'], res: 60000 }, 100000);
  assert(rep.pairs === 1, 'rollup(cfg): 1 пара');
  const coarse = T.tierObjs[1].allRows();
  assert(coarse.length === 1 && coarse[0].value === 30, `rollup(cfg): max(10,30)=30 (не avg=20), got ${coarse[0]?.value}`);

  // rollup() — дефолтный agg (avg) для ещё одной таблицы
  const dir2 = tmpDir();
  const store2 = new Store(dir2, { autoCompact: false });
  const T2 = new MergeTree({
    name: 'def',
    store: store2,
    tiers: [
      { resMs: 1000, ttlMs: 5000 },
      { resMs: 60000, ttlMs: 600000 },
    ],
    schema: SCHEMA,
    agg: { value: 'avg' },
    dims: ['host'],
  });
  T2.append({ ts: 1000, host: 'h1', value: 10 });
  T2.append({ ts: 2000, host: 'h1', value: 30 });
  T2.rollup(100000); // все тиры, дефолтный avg
  const coarse2 = T2.tierObjs[1].allRows();
  assert(coarse2.length === 1 && coarse2[0].value === 20, `rollup(): avg(10,30)=20, got ${coarse2[0]?.value}`);

  // rollup(cfg) с неизвестным целевым тиром — ошибка
  assertThrows(() => T.rollup({ agg: { value: 'max' }, dims: ['host'], res: 999999 }), 'rollup(cfg): нет тира res=999999 → ошибка');

  T.close();
  store.closeAll();
  T2.close();
  store2.closeAll();
}

console.log(`\nТесты merge-tree (Phase 2-3): ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
