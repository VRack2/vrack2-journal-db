# vrack2-journal-db

TypeScript-реализация журнального движка метрик **vrack2** (ранее — jsdb, jsdb-new).
Append-only, columnar, с дедупликацией, компактизацией, надёжной записью (WAL +
атомарные файлы) и **метрическим движком** поверх: агрегации, векторный скан,
SQL-lite, retention-тиры — точные и быстрые, без PostgreSQL.

```
TypeScript (strict) · Node ≥ 20.19 · MIT · без нативных зависимостей
```

## Для чего это

Метрики, логи, счётчики, события — данные, которые постоянно пишутся, а потом
читаются по времени и агрегируются. vrack2-journal-db — журнал, который держит
их на диске с экономией места и надёжной записью, а сверху даёт быстрый
метрический движок: таймлайны, агрегации, top-N, квантили, retention-тиры.

Исторически это эволюция jsdb (JS → TS), а «metric engine» — надстройка поверх
журнала: `aggregate`/`timeline` (Фаза 1) → `scan` (Фаза 3) → `Table` с
retention-тирами (Фаза 4) → `sql`/`percentile` (Фаза 5). План и фазы —
`docs/metrics-engine-plan.md`.

## Какие проблемы решает

**Один файл на журнал вместо «таблицы».** Журнал — это каталог файлов-сегментов
(append-only). Новый сегмент — новый файл, старый не переписывается. Это даёт:

- **Надёжную запись**: строки сначала в WAL, сегмент пишется атомарно
  (tmp + rename), краш не оставляет «половину файла» (`Reliability.md`).
- **Масштабирование по размеру**: данные лежат во многих сегментах; чтение
  нужного периода не трогает остальные; компактизация и purge управляемы
  (`Maintenance.md`).
- **Параллельное чтение**: каждый читает свой кэш, блокировка только на запись
  (`Reliability.md`).

**Меньше места — колонки и кодексы.** Вместо повторения
`{"ts":1700000001,"level":"info"}` тысячи раз, данные хранятся колонками:
координаты — дельтами, строки — словарём, числа — числовыми кодеками (v3),
дубли — схлопываются в ссылку. На метрических рядах это ~10× меньше, чем в
наивном JSON (`Formats.md`).

**Быстрые агрегации без сканирования всего.** Сегменты хранят саммари
(min/max/sum/count); запрос на период, целиком лежащий в сегменте, отвечает из
саммари, не разжимая файл. `scan()` декодирует только запрошенные колонки,
`sql()` — SQL-lite поверх `scan()`.

**Предсказуемый размер на 30 дней.** `Table` — retention-тиры (5с/1д,
15с/1нед, 1м/1мес) + rollup: размер `≤ Σ(TTL × разрешение)` (`Retention.md`).

## Как это устроено

Четыре уровня:

```
Store   — каталог таблиц (create(def)/open(name)/describe()) + общий кэш сегментов
 └─ Journal — каталог: N сегментов + WAL + блокировка + активный сегмент
     └─ Segment — набор колонок + дедупликация строк (dedupMap)
         └─ Column — одна колонка со своей стратегией хранения
```

Каждое поле в схеме — колонка со своей стратегией: `raw`, `dictionary`, `delta`,
`rle`, `auto` (сам выбирает) или `catchall` (JSON-корзина для «лишних» полей).
Файлы сегментов — форматы **v1** (JSON), **v2** (gzip + CRC32) и **v3**
(числовые кодеки + zstd); старые версии читаются без миграции. Детали —
`docs/Formats.md`.

## Как использовать

Публичный API — одно лицо (ClickHouse-модель): **Store** (каталог таблиц) +
**Table** (таблица) + **define\*Table** (описание: движок + тиры). Внутренняя
механика (журналы, сегменты, кодексы, SQL-парсер) не экспортируется.

```ts
import { Store, defineLogTable } from 'vrack2-journal-db';

const store = new Store('./data');

// Описание валидируется сразу при define*() — ошибки видны на месте объявления
const cpu = store.create(defineLogTable({
  name: 'cpu',
  desc: 'Метрики CPU: строка на (host) в момент ts',
  columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
  retention: '5s:1d,15s:1w,1m:1mon', // 5с/1день, 15с/1неделя, 1м/1месяц
  agg: { value: 'avg' },
}));

cpu.append({ ts: Date.now(), host: 'web-1', value: 42.3 });

cpu.query('now-30d', 'now');   // сам собирает ответ из нужных тиров по возрасту
cpu.allRows();                 // все строки, старые → новые
cpu.tail(10);                  // десять последних
cpu.stats();                   // строки/байты/диапазон ts на тир
cpu.compact();                 // слить закрытые сегменты (поведение — по движку)
cpu.purge('now-30d');          // удалить строки старше 30 дней
cpu.close();

// Store — каталог таблиц, общий кэш сегментов
store.tables();                // ['cpu']
store.describe();              // [{ name, columns, kind, rows, segments, sizeBytes }]
store.engineOf('cpu');         // 'log' | 'upsert' | 'summing' | 'collapsing'
store.closeAll();
```

### Движки

Одна `define*`-функция на движок, у каждой свои параметры (как движки
ClickHouse); поведение при `compact()` — своё:

| Движок | Параметры | Слияние при compact() |
|---|---|---|
| `defineLogTable` | — | строки не меняются; дубли схлопываются |
| `defineUpsertTable` | `key`, `version` | по key остаётся строка с max(`version`) |
| `defineSummingTable` | `key`, `sum`, [`version`] | по key суммируются колонки из `sum` |
| `defineCollapsingTable` | `key`, `sign`, [`version`] | по key гаснут пары +1/−1 в колонке `sign` |

```ts
import { Store, defineUpsertTable } from 'vrack2-journal-db';

const store = new Store('./data');
const state = store.create(defineUpsertTable({
  name: 'state',
  desc: 'Состояние: последняя версия по (host, metric)',
  columns: { ts: 'delta', host: 'dictionary', metric: 'dictionary', value: 'auto' },
  key: ['host', 'metric'],
  version: 'ts',
}));

state.append({ ts: 1, host: 'web-1', metric: 'cpu', value: 42 });
state.append({ ts: 2, host: 'web-1', metric: 'cpu', value: 43 });
state.compact();   // одна строка: value=43 (максимальная версия)
state.query('now-7d', 'now');
```

### Метрический движок

Коротко — что есть и как вызвать; полная справка в `docs/Querying.md` и
`docs/Retention.md`:

| Метод | Назначение |
|---|---|
| `timeline(interval, period)` | бакеты по времени: сколько строк в каждом (`Querying.md`) |
| `aggregate(start, end, aggs)` | точные min/max/sum/avg/count, по саммари, без скана строк (`Querying.md`) |
| `scan({select, where, groupBy, agg, order, limit})` | «мини-ClickHouse»: только запрошенные колонки, плотные массивы (`Querying.md`) |
| `sql('SELECT … WHERE … GROUP BY …')` | SQL-lite, компилируется в `scan()` (`Querying.md`) |
| `percentile(start, end, field, [0.5, 0.95, 0.99])` | точные k-вантили (`Querying.md`) |
| `store.create(defineLogTable({ retention, agg }))` | retention-тиры + rollup, предсказуемый размер (`Retention.md`) |

### Утилита

CLI `vrack2-journal` — записывать/смотреть метрики из shell:

```bash
npm i -g vrack2-journal-db

vrack2-journal create  --data ./data --name cpu \
                       --columns ts=delta,host=dictionary,value=auto
vrack2-journal append  --data ./data --name cpu --ts 1700000000 --field host=web-1,value=42
vrack2-journal query   --data ./data --name cpu --from now-1d --limit 50
vrack2-journal stats   --data ./data [--name cpu]
vrack2-journal compact --data ./data --name cpu
vrack2-journal tables  --data ./data
```

`--ts` — миллисекунды (значения < 1e12 трактуются как секунды);
`--from/--to` — число или строка вида `'now-1d'`. Движки кроме log — через
`create --engine upsert --key host --version ts` (аналогично summing/collapsing).

## Цифры (нагрузочный тест, 2M строк, `test-load.ts`)

| Метрика | Значение |
|---|---|
| Записано строк | 2 000 000 |
| Физически записано | 2 000 000 |
| Время записи | 2 210 мс (~900k строк/с) |
| Размер на диске | 145 МБ |
| Чтение всех строк | 11 324 мс |
| Размер «в JSON» | 153 МБ |
| Экономия | **5.9%** |
| Память в конце | 170 МБ (RSS) |
| Скорость записи | 905k строк/с |

## Документация

Подробности реализации разбиты по темам в `docs/`:

| Файл | Что внутри |
|---|---|
| `docs/Formats.md` | Типы колонок, числовые кодексы (v3), форматы v1/v2/v3, сжатие, CRC32, структура каталога |
| `docs/Reliability.md` | WAL, атомарная запись, восстановление после краха, блокировка, целостность |
| `docs/Maintenance.md` | Дедупликация, ленивое чтение и кэш, компактизация, purge |
| `docs/Querying.md` | `timeline`, `aggregate`/`downsample`, `scan`, `sql`, `percentile`, гибкая схема |
| `docs/Retention.md` | `Table`, retention-тиры, rollup, предсказуемый размер |
| `docs/metrics-engine-plan.md` | План метрического движка и его фазы |

## Структура кода

| Файл | Назначение |
|---|---|
| `src/index.ts` | Фасад — единственный публичный API пакета |
| `src/types.ts` | Общие типы; сериализованные колонки — дискриминированные union'ы |
| `src/Segment.ts` | Сегмент: набор колонок + дедупликация строк (dedupMap) |
| `src/Journal.ts` | Журнал: WAL, блокировки, flush, clear(), purge(), timeline(), page()/tail(), compact(), `aggregate`/`downsample`, `scan()`, `sql()`, `percentile()`, `migrateToV3()` |
| `src/Interval.ts` | «Язык интервалов» (VRackDB-совместимо, в мс): parseInterval, partOfPeriod, period, roundTime, getIntervals |
| `src/Store.ts` | Каталог таблиц: `create(def)`, `open(name)`, `describe()`, `tables()`, `engineOf(name)`; общий кэш сегментов; манифест `_store.json` |
| `src/LRUCache.ts` | LRU-кэш (используется Journal и Store) |
| `src/SegmentFile.ts` | Мульти-версионный фасад: `read(buf)` (v1/v2/v3 → сегмент), `isWrapped(buf)` |
| `src/SegmentFileV2.ts` | Формат файла v2: gzip + CRC32; чтение старых v1-файлов |
| `src/SegmentFileV3.ts` | Формат v3: бинарные блобы колонок (кодек + словарь + zstd/gzip + CRC32) |
| `src/Compression.ts` | Сжатие блобов: gzip, zstd |
| `src/Percentile.ts` | Квантили (p50/p90/p95/p99) |
| `src/RetentionEngine.ts` | Retention-тиры: выбор тира по возрасту, перекодирование, слияние блоков (1h → 1d) |
| `src/Table.ts` | `Table`: N журналов-тиров + retention + rollup + `query`/`percentile`/`stats`; парсинг `'5s:1d,…'` |
| `src/Sql.ts` / `src/SqlError.ts` | SQL-lite: парсер подмножества SQL → опции `scan()` / `insert()` |
| `src/columns/` | Шесть типов колонок: Raw, Dictionary, Delta, RLE, Auto, Catchall + `ColumnFactory` |
| `src/numcodecs/` | Числовые кодексы v3: f64, doubleDelta, gorilla, rle + `NumCodecs` (`registry`/`get`/`autoPick`) |
| `src/compaction/` | Движки компактизации: Log, Upsert, Summing, Collapsing + `Descriptor` |
| `src/metricTable/` | Мультитирная метрика-таблица (Фаза 2): `Tier`, rollup (fine→coarse), `MergeTree` |

## Тесты

```bash
npm test          # 19 сценариев, 1094 проверки (test-load.ts — отдельный, долгий)
npm run typecheck # tsc --noEmit в strict-режиме
```

Сценарии: базовый цикл записи/чтения; оптимизации хранения; запросы по времени и
меткам; сжатие v2 + целостность + совместимость с v1; гибкая схема; компактизация;
**движки** (log/upsert/summing/collapsing); purge; timeline; aggregate; interval;
надёжность (WAL, блокировки); **v3-формат**; **scan**; **retention**; **table**;
**migration** (v2 → v3); **sql**.

Долгий нагрузочный тест (2M строк) не в `npm test`:

```sh
node --max-old-space-size=8192 test/test-load.ts   # LOAD_ROWS=500000 — быстрее
```
