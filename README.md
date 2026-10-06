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
Store   — каталог с N журналами + общий кэш сегментов + openTable()
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

```ts
import { Journal, Store } from 'vrack2-journal-db';

const j = new Journal('./data');
j.open('events', { ts: 'delta', level: 'dictionary', val: 'auto' });

j.append({ ts: Date.now(), level: 'info', val: 42 });
j.append({ ts: Date.now(), level: 'warn', val: 99 });

j.allRows();                    // все строки, старые → новые
j.query(1700000000, 1700000090); // только в диапазоне ts
j.tail(3);                      // три последних

j.stats();                      // { totalRows, totalPhysicalRows, totalSize, … }
j.getTimeRange();               // { minTs, maxTs }

j.append({ ts: Date.now(), level: 'error', val: 200 });
j.append({ ts: Date.now(), level: 'error', val: 200 }); // дубль — не занимает место

j.compact();                    // слить закрытые сегменты в один
j.purge('now-30d');             // удалить строки старше 30 дней
j.close();
```

Несколько журналов в одном каталоге, общий кэш сегментов и метрическая таблица:

```ts
const store = new Store('./data');
store.openJournal('events', { ts: 'delta', val: 'auto' });
store.query('events', 1700000000, 1700000100);
store.query('events', { from: 'now-1d', to: 'now' });   // границы — число или строка

const cpu = store.openTable('cpu', {
  retention: '5s:1d,15s:1w,1m:1mon',  // 5с/1день, 15с/1неделя, 1м/1месяц
  agg: { value: 'avg' },
});
cpu.append({ ts: Date.now(), value: 42.3 });
cpu.query('now-30d', 'now');    // сам собирает ответ из нужных тиров по возрасту
```

### Метрический движок

Коротко — что есть и как вызвать; полная справка в `docs/Querying.md` и
`docs/Retention.md`:

| Метод | Назначение |
|---|---|
| `timeline(interval, period)` | бакеты по времени: сколько строк в каждом (`Querying.md`) |
| `aggregate(start, end, aggs)` / `downsample(…)` | точные min/max/sum/avg/count, по саммари, без скана строк (`Querying.md`) |
| `scan({select, where, groupBy, agg, order, limit})` | «мини-ClickHouse»: только запрошенные колонки, плотные массивы (`Querying.md`) |
| `sql('SELECT … WHERE … GROUP BY …')` | SQL-lite, компилируется в `scan()` (`Querying.md`) |
| `percentile(start, end, field, [0.5, 0.95, 0.99])` | точные k-вантили (`Querying.md`) |
| `store.openTable(…, { retention, agg })` | retention-тиры + rollup, предсказуемый размер (`Retention.md`) |

### Утилита

CLI `vrack2-journal` — записывать/смотреть метрики из shell:

```bash
npm i -g vrack2-journal-db
vrack2-journal append --data ./data --name cpu --ts 1700000000 --field value=42
vrack2-journal stats   --data ./data --name cpu
vrack2-journal compact --data ./data --name cpu
```

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
| `src/types.ts` | Общие типы; сериализованные колонки — дискриминированные union'ы |
| `src/columns.ts` | Шесть типов колонок: Raw, Dictionary, Delta, RLE, Auto, Catchall |
| `src/segment.ts` | Сегмент: набор колонок + дедупликация строк (dedupMap) |
| `src/journal.ts` | Журнал: WAL, блокировки, flush, clear(), purge(), timeline(), page()/tail(), compact(), `aggregate`/`downsample`, `scan()`, `sql()`, `percentile()`, `migrateToV3()` |
| `src/interval.ts` | «Язык интервалов» (VRackDB-совместимо, в мс): parseInterval, partOfPeriod, period, roundTime, getIntervals |
| `src/store.ts` | Хранилище нескольких журналов с общим кэшем сегментов; `openTable()` |
| `src/cache.ts` | LRU-кэш (используется Journal и Store) |
| `src/codec.ts` | Формат файла v2: gzip + CRC32; чтение старых v1-файлов |
| `src/v3.ts` | Формат v3: бинарные блобы колонок (кодек + словарь + zstd/gzip + CRC32), мульти-версионный ридер v1/v2/v3 |
| `src/numcodecs.ts` | Числовые кодексы v3: f64, doubleDelta, gorilla, rle8, simple8b, dictionary + `autoPickNumCodec` |
| `src/retention.ts` | Retention-тиры: парсинг `'5s:1d,…'`, выбор тира по возрасту, rollup (fine→coarse) |
| `src/table.ts` | `Table`: N журналов-тиров + retention + rollup + `query`/`percentile`/`stats` |
| `src/sql.ts` | SQL-lite: парсер подмножества SQL → опции `scan()` |

## Тесты

```bash
npm test          # 18 сценариев, 980 проверок (test-load.ts — отдельный, долгий)
npm run typecheck # tsc --noEmit в strict-режиме
```

Сценарии: базовый цикл записи/чтения; оптимизации хранения; запросы по времени и
меткам; сжатие v2 + целостность + совместимость с v1; гибкая схема; компактизация;
purge; timeline; aggregate; interval; надёжность (WAL, блокировки); **v3-формат**;
**scan**; **retention**; **table**; **migration** (v2 → v3); **sql**.

Долгий нагрузочный тест (2M строк) не в `npm test`:

```sh
node --max-old-space-size=8192 test/test-load.ts   # LOAD_ROWS=500000 — быстрее
```

## Отличия от JS-версии (`../new`)

JS-версия — базовый функционал: журналы, колонки, дедупликация, запросы по времени,
файлы v1. TypeScript-версия содержит всё то же плюс: строгую типизацию (strict
mode), сжатие файлов с контрольной суммой (v2, старые файлы читает), гибкую схему
(null-падинг, catchall, эволюция схемы), компактизацию и надёжность (WAL,
блокировки).

Плюс весь метрический движок, которого в JS-версии нет: формат **v3** с
числовыми кодеками (doubleDelta, Gorilla, RLE) и мульти-версионный ридер;
векторный `scan()` (select/where/groupBy/agg/order/limit); **Table** с
retention-тирами и rollup'ом (стиль GraphiteMergeTree); SQL-lite (`sql()`);
точные квантили (`percentile()`).
