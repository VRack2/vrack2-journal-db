// ============================================================
// test-table.ts — Table (Фаза 4): мультитирная таблица-метрик
//   GraphiteMergeTree: тир'ы разрешения, rollup fine→coarse, TTL purge,
//   чтение-склейка по «возрасту», идемпотентность rollup, предсказуемый
//   размер. Плюс валидация retention-конфига (parseRetention).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { Table, openTable, parseRetention } from '../src/table.ts';
import type { TableConfig } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-table');

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

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
    failed++;
    console.error(`FAIL (должен бросить исключение): ${msg}`);
  } catch {
    passed++;
  }
}

fs.rmSync(baseDir, { recursive: true, force: true });

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const NOW = 1_700_000_000_000;

// --------------------------------------------------
// 1. parseRetention — разбор и валидация
// --------------------------------------------------
{
  const tiers = parseRetention('5s:1d,15s:1w,1m:1mon');
  assert(tiers.length === 3, `parseRetention: 3 тир'а (факт ${tiers.length})`);
  assert(tiers[0].resMs === 5 * SEC && tiers[0].ttlMs === DAY, `r5s: 5s / 1d (факт ${tiers[0].resMs}/${tiers[0].ttlMs})`);
  assert(tiers[1].resMs === 15 * SEC && tiers[1].ttlMs === WEEK, `r15s: 15s / 1w (факт ${tiers[1].resMs}/${tiers[1].ttlMs})`);
  assert(tiers[2].resMs === MIN && tiers[2].ttlMs === MONTH, `r1m: 1m / 1mon (факт ${tiers[2].resMs}/${tiers[2].ttlMs})`);

  // одиночный тир
  const one = parseRetention('1h:1d');
  assert(one.length === 1 && one[0].resMs === HOUR && one[0].ttlMs === DAY, 'parseRetention: одиночный тир "1h:1d"');

  // пробелы допустимы
  const spaced = parseRetention(' 5s:1d , 15s:1w ');
  assert(spaced.length === 2, 'parseRetention: пробелы вокруг тиров');

  // ошибки
  assertThrows(() => parseRetention(''), 'parseRetention: пустая строка');
  assertThrows(() => parseRetention('5s'), 'parseRetention: нет ":" в тире');
  assertThrows(() => parseRetention('5s:1d,1s:1d'), 'parseRetention: разрешения убывают (5s → 1s)');
  assertThrows(() => parseRetention('5s:1d,15s:1h'), 'parseRetention: ttl убывают (1d → 1h)');
  assertThrows(() => parseRetention('abc:1d'), 'parseRetention: неизвестная единица "abc"');
}

// --------------------------------------------------
// 2. Таблица открывается, тиры-журналы создаются, append/query
// --------------------------------------------------
{
  const store = new Store(baseDir);
  const t = store.openTable('cpu', {
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    schema: { ts: 'delta', value: 'auto', host: 'dictionary' },
    nowProvider: () => NOW,
  });

  assert(t.name === 'cpu', 'table.name');
  assert(t.tiers.length === 3, `table.tiers: 3 (факт ${t.tiers.length})`);
  assert(t.tierJournalName(0) === 'cpu/r5000', `тир0 журнал "cpu/r5000" (факт ${t.tierJournalName(0)})`);
  assert(t.tierJournalName(1) === 'cpu/r15000', `тир1 журнал "cpu/r15000" (факт ${t.tierJournalName(1)})`);
  assert(t.tierJournalName(2) === 'cpu/r60000', `тир2 журнал "cpu/r60000" (факт ${t.tierJournalName(2)})`);
  assert(store.openJournals.has('cpu/r5000') && store.openJournals.has('cpu/r15000') && store.openJournals.has('cpu/r60000'), 'все тиры открыты в Store');
  assert(t.isOpen, 'table.isOpen');

  // append → query (свежие данные в тонком тире)
  for (let i = 0; i < 10; i++) {
    t.append({ ts: NOW - (i + 1) * 5 * SEC, value: 100 - i, host: 'web-1' });
  }
  t.flush();
  const rows = t.query('now-1d', 'now');
  assert(rows.length === 10, `query свежих: 10 строк (факт ${rows.length})`);
  // отсортировано по ts ↑
  let sorted = true;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i].ts as number) < (rows[i - 1].ts as number)) sorted = false;
  }
  assert(sorted, 'query: ответ отсортирован по ts ↑');
  // значение возвращается (lossless)
  assert(rows.some(r => r.value === 100), 'query: строка со значением 100 найдена');

  // повторный openTable с тем же именем → та же таблица (дедупликация)
  assert(store.openTable('cpu', { retention: '5s:1d' }) === t, 'openTable: повторный вызов возвращает ту же таблицу');

  store.closeAll();
}

// --------------------------------------------------
// 3. Rollup: перенос состарившегося в грубый тир + идемпотентность
// --------------------------------------------------
{
  const store = new Store(baseDir);
  const t = store.openTable('mem', {
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    schema: { ts: 'delta', value: 'auto', host: 'dictionary' },
    nowProvider: () => NOW,
  });

  // Данные в «возрастном» окне (1d, 1w]: должны уехать в тир1 (r15s).
  // 10 точек с шагом 5s, последние — 2 дня назад (возраст > 1d).
  const start = NOW - 2 * DAY;
  for (let i = 0; i < 10; i++) {
    t.append({ ts: start + i * 5 * SEC, value: 10 + i, host: 'web-1' });
  }
  t.flush();

  const st0 = t.stats();
  assert(st0[0].rows === 10, `до rollup: тир0 = 10 строк (факт ${st0[0].rows})`);
  assert(st0[1].rows === 0, `до rollup: тир1 = 0 (факт ${st0[1].rows})`);

  const rep = t.rollup();
  assert(rep.pairs === 2, `rollup: обработано 2 пары (факт ${rep.pairs})`);
  assert(rep.rolledRows === 10, `rollup: перекодировано 10 строк (факт ${rep.rolledRows})`);
  assert(rep.purgedRows === 10, `rollup: purged 10 строк из тир0 (факт ${rep.purgedRows})`);

  const st1 = t.stats();
  assert(st1[0].rows === 0, `после rollup: тир0 = 0 (purged; факт ${st1[0].rows})`);
  assert(st1[1].rows > 0, `после rollup: тир1 > 0 (факт ${st1[1].rows})`);
  assert(st1[2].rows === 0, `после rollup: тир2 = 0 (возраст < 1w; факт ${st1[2].rows})`);

  // Идемпотентность: повторный rollup того же окна ничего не меняет.
  const before = t.stats().map(s => s.rows);
  const rep2 = t.rollup();
  const after = t.stats().map(s => s.rows);
  assert(rep2.rolledRows === 0, `повторный rollup: 0 перекодировано (факт ${rep2.rolledRows})`);
  assert(JSON.stringify(before) === JSON.stringify(after), `повторный rollup: без дублей (до ${JSON.stringify(before)} / после ${JSON.stringify(after)})`);

  // Чтение после rollup: данные видны (из грубого тира).
  const rows = t.query('now-1w', 'now');
  assert(rows.length > 0, `query после rollup: данные есть (факт ${rows.length})`);

  store.closeAll();
}

// --------------------------------------------------
// 4. Rollup: корректность агрегации (avg) и бакетов
// --------------------------------------------------
{
  const store = new Store(baseDir);
  const t = store.openTable('lat', {
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    schema: { ts: 'delta', value: 'auto', host: 'dictionary' },
    nowProvider: () => NOW,
  });

  // 3 точки в пределах ОДНОГО бакета 15s, в «возрастном» окне (> 1d).
  const B = Math.floor((NOW - 2 * DAY) / (15 * SEC)) * (15 * SEC); // начало бакета, кратное 15s
  const pts: Array<{ ts: number; value: number }> = [
    { ts: B + 5 * SEC, value: 10 },
    { ts: B + 10 * SEC, value: 20 },
    { ts: B + 15 * SEC, value: 30 }, // B+15s — это уже СЛЕДУЮЩИЙ бакет
  ];
  for (const p of pts) t.append({ ts: p.ts, value: p.value, host: 'web-1' });
  t.flush();
  t.rollup();

  const st = t.stats();
  assert(st[0].rows === 0, 'rollup-agg: тир0 purged');
  // 2 бакета (B: 10,20 → avg 15; B+15s: 30 → avg 30)
  assert(st[1].rows === 2, `rollup-agg: тир1 = 2 бакета (факт ${st[1].rows})`);

  const rows = t.query('now-1w', 'now').sort((a, b) => (a.ts as number) - (b.ts as number));
  assert(rows.length === 2, `rollup-agg: query вернул 2 бакета (факт ${rows.length})`);
  const b0 = rows.find(r => (r.ts as number) === B);
  const b1 = rows.find(r => (r.ts as number) === B + 15 * SEC);
  assert(!!b0 && Math.abs((b0.value as number) - 15) < 1e-9, `бакет B: avg(10,20)=15 (факт ${b0?.value})`);
  assert(!!b1 && Math.abs((b1.value as number) - 30) < 1e-9, `бакет B+15s: avg(30)=30 (факт ${b1?.value})`);

  store.closeAll();
}

// --------------------------------------------------
// 5. Склеивание ответа из нескольких тиров (recent / aged / old)
// --------------------------------------------------
{
  const store = new Store(baseDir);
  const t = store.openTable('cpu2', {
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    schema: { ts: 'delta', value: 'auto', host: 'dictionary' },
    nowProvider: () => NOW,
  });

  // Свежие (возраст < 1d) → останутся в тир0.
  t.append({ ts: NOW - 2 * MIN, value: 1, host: 'web-1' });
  t.append({ ts: NOW - 3 * MIN, value: 2, host: 'web-1' });
  // Старые (1d < возраст < 1w) → rollup в тир1.
  t.append({ ts: NOW - 2 * DAY, value: 3, host: 'web-1' });
  // Очень старые (1w < возраст < 1mon) → rollup в тир2.
  t.append({ ts: NOW - 10 * DAY, value: 4, host: 'web-1' });
  t.flush();

  t.rollup();
  const st = t.stats();
  assert(st[0].rows === 2, `склейка: тир0 = 2 (свежие; факт ${st[0].rows})`);
  assert(st[1].rows === 1, `склейка: тир1 = 1 (aged; факт ${st[1].rows})`);
  assert(st[2].rows === 1, `склейка: тир2 = 1 (old; факт ${st[2].rows})`);

  const rows = t.query('now-1mon', 'now').sort((a, b) => (a.ts as number) - (b.ts as number));
  assert(rows.length === 4, `склейка: 4 строки из 3 тиров (факт ${rows.length})`);
  // Порядок: oldest → newest
  assert(rows[0].value === 4, `склейка: первая = самая старая (value 4; факт ${rows[0]?.value})`);
  assert(rows[3].value === 1, `склейка: последняя = самая свежая (value 1; факт ${rows[3]?.value})`);

  store.closeAll();
}

// --------------------------------------------------
// 6. aggregate() — агрегация сквозь тиры
// --------------------------------------------------
{
  const store = new Store(baseDir);
  const t = store.openTable('agg', {
    retention: '5s:1d,15s:1w,1m:1mon',
    agg: { value: 'avg' },
    schema: { ts: 'delta', value: 'auto' },
    nowProvider: () => NOW,
  });
  for (let i = 0; i < 5; i++) t.append({ ts: NOW - (i + 1) * MIN, value: (i + 1) * 10 });
  t.flush();
  const out = t.aggregate('now-1d', 'now', [
    { field: 'value', fn: 'min' },
    { field: 'value', fn: 'max' },
    { field: 'value', fn: 'avg' },
    { field: 'value', fn: 'count' },
  ]);
  assert(out['value__min'] === 10, `aggregate min=10 (факт ${out['value__min']})`);
  assert(out['value__max'] === 50, `aggregate max=50 (факт ${out['value__max']})`);
  assert(Math.abs((out['value__avg'] as number) - 30) < 1e-9, `aggregate avg=30 (факт ${out['value__avg']})`);
  assert(out['value__count'] === 5, `aggregate count=5 (факт ${out['value__count']})`);
  store.closeAll();
}

// --------------------------------------------------
// 7. stats() — rows/bytes на тир; closeTable
// --------------------------------------------------
{
  const store = new Store(baseDir);
  const t = store.openTable('st', { retention: '5s:1d,15s:1w', nowProvider: () => NOW });
  for (let i = 0; i < 50; i++) t.append({ ts: NOW - 2 * DAY - i * 5 * SEC, value: i });
  t.flush();
  t.rollup();
  const st = t.stats();
  assert(st.length === 2, `stats: 2 тир'а (факт ${st.length})`);
  assert(st[1].rows > 0 && st[1].bytes > 0, `stats: тир1 rows>0 и bytes>0 (факт ${st[1].rows}/${st[1].bytes})`);

  store.closeTable('st');
  assert(!store.openJournals.has('st/r5000') && !store.openJournals.has('st/r15000'), 'closeTable: тиры закрыты');
  assert(!store.openTables.has('st'), 'closeTable: таблица удалена из реестра');

  assertThrows(() => store.closeTable('нет-такой'), 'closeTable: неизвестное имя бросает');
  store.closeAll();
}

// --------------------------------------------------
// 8. Предсказуемый размер: Σ(разрешение × ttl)
// --------------------------------------------------
{
  const tiers = parseRetention('5s:1d,15s:1w,1m:1mon');
  let total = 0;
  for (let i = 0; i < tiers.length; i++) {
    const span = i === 0 ? tiers[0].ttlMs : tiers[i].ttlMs - tiers[i - 1].ttlMs;
    total += Math.round(span / tiers[i].resMs);
  }
  // 1d/5s + 6d/15s + 23d/1m = 17280 + 34560 + 33120 = 84960
  assert(total === 84960, `предсказуемый размер за 1 месяц: 84960 точек (факт ${total})`);
}

// --------------------------------------------------
// 9. openTable фабрика + валидация конфига
// --------------------------------------------------
{
  const store = new Store(baseDir);
  const t = openTable(store, 'fab', {
    retention: '5s:1d,15s:1w',
    agg: { value: 'avg' },
    nowProvider: () => NOW,
  });
  assert(t instanceof Table, 'openTable: возвращает Table');
  assert(t.agg['value'] === 'avg', 'openTable: agg задан');
  assert(t.dims.length === 0, 'openTable: без dims (только ts+value)');

  assertThrows(() => openTable(store, 'x/y', { retention: '5s:1d' }), 'openTable: имя с "/" бросает');
  assertThrows(() => openTable(store, 'noconf', {}), 'openTable: без retention/tiers бросает');
  const badAgg = { retention: '5s:1d', agg: { value: 'median' } } as unknown as TableConfig;
  assertThrows(() => openTable(store, 'badagg', badAgg), 'openTable: неверный agg.fn бросает');

  // Явные tiers (вместо retention)
  const t2 = store.openTable('explicit', {
    tiers: [
      { resMs: 5 * SEC, ttlMs: DAY },
      { resMs: 15 * SEC, ttlMs: WEEK },
    ],
    nowProvider: () => NOW,
  });
  assert(t2.tiers.length === 2, 'explicit tiers: 2 тира');

  assertThrows(
    () => new Table(store, 'bad', { tiers: [{ resMs: 15 * SEC, ttlMs: WEEK }, { resMs: 5 * SEC, ttlMs: MONTH }] }),
    'Table: убывающие разрешения в tiers бросают',
  );
  store.closeAll();
}

console.log(`\nТесты table: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
