# vrack2-journal-db

Метрики, счётчики и логи в одном процессе Node.js. Пишете строки — читаете их
по времени и агрегируете: min/max/sum/avg, квантили, top-N. Без отдельного
сервера, без PostgreSQL, без нативных зависимостей.

```
TypeScript (strict) · Node ≥ 18 · MIT · без нативных зависимостей
```

## Для чего

Для данных, которые постоянно пишут и потом читают по времени: метрики,
счётчики, события, логи. vrack2-journal-db держит их на диске в компактном
виде и даёт быстрые агрегации, живя в том же процессе, что и ваш код.

## Быстрый старт

```ts
import { Store, defineLogTable } from 'vrack2-journal-db';

const store = new Store('./data');   // ./data — каталог на диске

// Одна таблица: строки вида { ts, host, value }
const cpu = store.create(defineLogTable({
  name: 'cpu',
  columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
}));                                 // → Table

cpu.append({ ts: Date.now(), host: 'web-1', value: 42.3 });   // → void

cpu.query('now-30d', 'now');   // → [{ ts, host, value }, …] — строки за последние 30 дней
// то же самое числом (миллисекунды) — строка и число взаимозаменяемы:
cpu.query(Date.now() - 30 * 86_400_000, Date.now());
cpu.tail(10);                  // → последние 10 строк
cpu.allRows();                 // → все строки, старые → новые
cpu.stats();                   // → [{ tier: 0, resMs: 0, ttlMs: 0, rows, bytes, minTs, maxTs }]
cpu.compact();                 // → { mergedSegments, logicalRows, physicalBefore, physicalAfter, collapsedRows }
cpu.purge('now-30d');          // → { removedRows, removedSegments, rewrittenSegments }
cpu.close();                   // → void

// Уже существующую таблицу открывают по имени
const cpu2 = store.open('cpu');  // → Table (та же таблица)
```

Время задаётся числом (миллисекунды) или строкой вида `'now-1d'`, `'now-1h-30m'`,
`'now'` — единицы: `ms s m h d w mon y` (`mon` = 30 дней, `y` = 365 дней).
Число без единиц — это уже миллисекунды (`900000` = 15 минут).

## Как хранит данные

**Таблица** — именованный набор строк. Внутри каждая таблица — это **журнал**:
каталог на диске, в котором лежат **сегменты** (файлы).

```
./data/
├─ _store.json          # описание таблиц: схема, движок, retention
└─ journals/
   └─ cpu/
      ├─ *.seg / *.json # сегменты — сами данные
      ├─ *.meta         # границы min/max ts + саммари (для быстрых чтений)
      ├─ wal.log        # буфер записи — страховка при крахе
      └─ .lock          # владелец журнала (PID процесса)
```

Данные **только добавляются**: каждый новый блок строк — новый файл-сегмент,
старые файлы не переписываются (append-only). Из этого следуют сразу три вещи:

- запись надёжна — см. ниже;
- чтение параллельное: каждый процесс читает свой кэш, блокировка только на запись;
- очистка простая: сегмент, целиком старше нужного срока, удаляется одним `unlink`.

**Сегмент** — один файл с чанком строк (по умолчанию до 10 000). Внутри строки
хранятся **по колонкам**, со сжатием: числа — дельтами, строки — словарём,
повторы — RLE. Поэтому файл меньше, чем тот же объём в JSON.

**Почему краш не теряет данные.** `append()` не пишет файл на каждую строку —
это было бы медленно. Порядок такой:

1. Строка кладётся в **буфер в памяти**.
2. Буфер сбрасывается в файл `wal.log` **пачками** — каждые 512 строк или 1 МБ
   (один системный вызов, а не один на строку). `wal.log` — это *write-ahead log*
   («сначала на диск, потом в данные»): страховка. Процесс умрёт сразу после
   `append()` — строки уже на диске. Уйти могут только при `kill -9` / обрыве
   питания — это ограничение любой WAL.
3. Когда сегмент набирает 10 000 строк, он **пишется в файл целиком**: сначала во
   временный файл, потом `rename`. Переименование атомарное — на диске никогда не
   будет «половины файла». После этого эти строки удаляются из `wal.log`.
4. Если процесс умер до того, как сегмент дописали, — при следующем открытии
   `wal.log` дочитывается, и строки возвращаются.

Один владелец на журнал: при открытии кладётся `.lock` с PID. Второй процесс,
попытавшийся открыть тот же журнал, получит ошибку. Владелец умер (PID не жив) —
блокировку заберут автоматически.

## Как читать

| Метод | Что делает | Возвращает |
|---|---|---|
| `query(from, to)` | строки в диапазоне времени | `[{ ts, host, value }, …]` |
| `tail(n)` | последние n строк | `[{ … }, …]` — последние n |
| `aggregate(from, to, exprs)` | min / max / sum / avg / count за период | `{ value_avg: 42.3, value_max: 99.9, ts_count: 7184 }` |
| `timeline(interval, from, to)` | сколько строк в каждом интервале | `[{ start, end, count, hasData }, …]` |
| `scan({ select, where, groupBy, order, limit })` | выбрать колонки, отфильтровать, сгруппировать | `[{ … }, …]`; со `groupBy` — по строке на группу |
| `sql('SELECT … WHERE …')` | небольшой SQL, компилируется в `scan()` | `[{ … }, …]`; `INSERT` — число записанных строк |
| `percentile(from, to, [0.5, 0.95])` | квантили p50 / p95 / … (колонка `value`) | `{ p50: 38.2, p95: 91.4 }` |

Чтение по времени дешёвое: файлы, целиком вне диапазона, **не читаются** — их
границы (min/max ts) лежат в маленьком файле `.meta` рядом с сегментом, поэтому
сам сегмент разжимать не нужно.

```ts
cpu.aggregate('now-1h', 'now', [
  { field: 'value', fn: 'avg' },
  { field: 'value', fn: 'max' },
  { field: 'ts',    fn: 'count' },
]);
// → { value_avg: 42.3, value_max: 99.9, ts_count: 7184 }

// Границы можно давать числом (мс) — или смешивать число и строку:
cpu.aggregate(Date.now() - 3_600_000, Date.now(), [
  { field: 'value', fn: 'avg' },
]);
// → { value_avg: 42.3 }

cpu.aggregate('now-1h', Date.now(), [
  { field: 'value', fn: 'max' },
]);
// → { value_max: 99.9 }

// timeline: ширина бакета — число (мс) или строка с единицей:
cpu.timeline(3_600_000, 'now-1d', 'now');
// → [{ start, end, count, hasData }, …] — 24 почасовых бакета за сутки

cpu.timeline('15m', 'now-1h', 'now');
// → [{ start, end, count, hasData }, …] — 4 15-минутных бакета за час
```

## Движки

У таблицы есть **движок** — правило, что делать со строками при `compact()`:

| Движок | Что делает `compact()` |
|---|---|
| `defineLogTable` | строки не меняются; дубли схлопываются |
| `defineUpsertTable` | по ключу остаётся строка с максимальным `version` |
| `defineSummingTable` | по ключу суммируются указанные числовые колонки |
| `defineCollapsingTable` | по ключу гаснут пары +1/−1 в колонке `sign` |

```ts
// «Состояние»: по (host, metric) оставляем самую свежую версию
const state = store.create(defineUpsertTable({
  name: 'state',
  columns: { ts: 'auto', host: 'dictionary', metric: 'dictionary', value: 'auto' },
  key: ['host', 'metric'],
  version: 'ts',
}));

state.append({ ts: 1, host: 'web-1', metric: 'cpu', value: 42 });   // → void
state.append({ ts: 2, host: 'web-1', metric: 'cpu', value: 43 });   // → void
state.compact();   // → { mergedSegments, logicalRows, physicalBefore, physicalAfter, collapsedRows }
state.allRows();   // → [{ ts: 2, host: 'web-1', metric: 'cpu', value: 43 }] — по (host, metric) одна строка: макс. версия
```

## Retention — чтобы размер не рос вечно

`retention` задаёт, сколько и с каким разрешением хранить:

```ts
const cpu = store.create(defineLogTable({
  name: 'cpu',
  columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
  retention: '5s:1d,15s:1w,1m:1mon',   // 5-сек на 1 день, 15-сек на 1 неделю, 1-мин на 1 месяц
  agg: { value: 'avg' },                // как склеивать при сгущении: среднее по value
}));
```

Свежие данные лежат в тонком разрешении; по мере старения их автоматически
сгущают в более грубые бакеты и удаляют после TTL. Это происходит само по мере
`append()` (rollup + purge), с троттлингом, чтобы не дёргать диск на каждую
строку. Итоговый размер ограничен: `≤ Σ(TTL × разрешение)`.

## CLI

```bash
npm i -g vrack2-journal-db

vrack2-journal create  --data ./data --name cpu --columns ts=delta,host=dictionary,value=auto
vrack2-journal append  --data ./data --name cpu --ts 1700000000 --field host=web-1,value=42
vrack2-journal query   --data ./data --name cpu --from now-1d --limit 50
vrack2-journal stats   --data ./data
vrack2-journal compact --data ./data --name cpu
vrack2-journal tables  --data ./data
```

`--ts` — миллисекунды (числа меньше 1e12 трактуются как секунды); `--from/--to` —
число или `'now-1d'`.

Все команды печатают JSON: `query` — сами строки (до `--limit`), `stats` —
`{ store, tables }`, `compact` — `{ table, compact: … }`, `tables` — `{ count, tables }`.

## Нагрузочный тест (2 млн строк)

| Метрика | Значение |
|---|---|
| Записано | 2 000 000 строк |
| Время записи | ~2.2 с (≈ 900k строк/с) |
| Размер на диске | 145 МБ |
| Тот же объём в JSON | 153 МБ |

Экономия места зависит от данных: повторяющиеся строки и числовые ряды дают
больше, чем «всё разное».

## Тесты

```bash
npm test          # все сценарии
npm run typecheck # tsc --noEmit (strict)
```

## Документация

Подробности по темам — в `docs/`:

| Файл | Что |
|---|---|
| `Formats.md` | типы колонок, форматы файлов (v1/v2/v3), кодексы, сжатие |
| `Reliability.md` | WAL, атомарная запись, восстановление, блокировка |
| `Maintenance.md` | дедупликация, кэш, compact, purge |
| `Querying.md` | query / aggregate / scan / sql / percentile |
| `Retention.md` | retention-тиры, rollup, размер |
