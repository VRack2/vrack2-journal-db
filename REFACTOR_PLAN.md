# REFACTOR_PLAN.md — Приведение `src/` (корень) к RULES.md

**Дата:** 2026-10-09
**Скоуп:** только корневые файлы `src/`. Папки `compaction/` и `metricTable/` не трогаем (только исправляем
импорты, если они тянут переименованные файлы). Тесты — только правка импортов/имён.

## Цели (соответствие правилам)

- Правило 1/7: пачки `export function` вокруг одной сущности → класс (статический) с этим именем.
- Правило 2/8: файл = PascalCase = имя класса; запрещён camelCase-файл с классом.
- Правило 3: неэкспортируемое = приватное; `export function _thing()` — убрать.
- Правило 5: публичный API = только `index.ts`; реестры/вспомогательные типы не выносятся наружу без смысла.
- Правило 6: один файл = одна сущность (класс / функции одной сущности / типы).
- Правило 9: нет циклических импортов между файлами.
- Правило 10: `npm run typecheck` + `npm test` + правило 3 секунд.

## Целевая структура `src/`

```
src/
├─ index.ts                  # фасад (правило 5) — единственный публичный API
├─ types.ts                  # только типы (остаётся без изменений)
├─ Journal.ts                # class Journal  (был: journal.ts, 2276 строк)
├─ Percentile.ts             # static class Percentile: key(q), of(vals, q)  (было: percentileKey/percentileOf в journal.ts)
├─ Store.ts                  # class Store   (было: store.ts)
├─ Table.ts                  # class Table + static open/parseRetention/DEFAULT_MAINTENANCE_INTERVAL_MS + type TableStore (было: table.ts)
├─ Segment.ts                # class Segment (было: segment.ts)
├─ Interval.ts               # class Interval (было: interval.ts)
├─ LRUCache.ts               # class LRUCache (было: cache.ts)
├─ RetentionEngine.ts        # class RetentionEngine + static defaultTiers + type SegmentEncoding (было: retention.ts)
├─ Sql.ts                    # static class Sql: parse(query), parseInsert(query) + приватный токенайзер (было: sql.ts)
├─ SqlError.ts               # class SqlError (было: в sql.ts)
├─ SegmentFile.ts            # static class SegmentFile: read(buf) [любой формат v1/v2/v3], isWrapped(buf)
├─ SegmentFileV2.ts          # static class SegmentFileV2: encode(data), decode(buf)  (было: codec.ts)
├─ SegmentFileV3.ts          # static class SegmentFileV3: encode(seg, opts), decode(buf), isV3(buf), type V3EncodeOptions (было: v3.ts)
├─ Compression.ts            # static class Compression: compress(buf, mode), decompress(buf, mode), zstdAvailable(), default()  (было: в v3.ts)
├─ columns/
│  ├─ Column.ts              # abstract class Column
│  ├─ RawColumn.ts
│  ├─ CatchAllColumn.ts
│  ├─ DictionaryColumn.ts
│  ├─ DeltaColumn.ts
│  ├─ RLEColumn.ts
│  ├─ AutoColumn.ts
│  └─ ColumnFactory.ts       # static: types (было COLUMN_TYPES), create(type) (было createColumn)
├─ numcodecs/
│  ├─ types.ts               # interface NumCodec
│  ├─ BitWriter.ts           # internal (не экспортируется из index)
│  ├─ BitReader.ts           # internal
│  ├─ F64Codec.ts
│  ├─ DoubleDeltaCodec.ts
│  ├─ GorillaCodec.ts
│  ├─ RleCodec.ts
│  └─ NumCodecs.ts           # static: registry (было NUM_CODECS), get(name) (getNumCodec), autoPick(values) (autoPickNumCodec)
├─ compaction/               # без изменений (кроме импортов)
└─ metricTable/              # без изменений (кроше: retention.ts → '../Table.ts')
```

## Соответствие имён (старое → новое)

| Было (src/) | Стало |
|---|---|
| `journal.ts` → `class Journal` | `Journal.ts` → `class Journal` |
| `journal.ts` → `percentileKey(q)`, `percentileOf(vals, q)` | `Percentile.key(q)`, `Percentile.of(vals, q)` |
| `journal.ts` → `DEFAULT_ROWS_PER_SEGMENT`, `DEFAULT_COMPACT_MIN_SEGMENTS` | `Journal.DEFAULT_ROWS_PER_SEGMENT`, `Journal.DEFAULT_COMPACT_MIN_SEGMENTS` |
| `store.ts` → `class Store` | `Store.ts` → `class Store` |
| `segment.ts` → `class Segment` | `Segment.ts` → `class Segment` |
| `interval.ts` → `class Interval` | `Interval.ts` → `class Interval` |
| `cache.ts` → `class LRUCache` | `LRUCache.ts` → `class LRUCache` |
| `sql.ts` → `class SqlError` | `SqlError.ts` → `class SqlError` |
| `sql.ts` → `parseSql(query)`, `parseInsert(query)` | `Sql.parse(query)`, `Sql.parseInsert(query)` |
| `retention.ts` → `class RetentionEngine`, `defaultTiers()`, `type SegmentEncoding` | `RetentionEngine.ts` → `class RetentionEngine`, `RetentionEngine.defaultTiers()`, `type SegmentEncoding` |
| `table.ts` → `class Table`, `openTable(...)`, `parseRetention(...)`, `DEFAULT_MAINTENANCE_INTERVAL_MS`, `type TableStore` | `Table.ts` → `class Table`, `Table.open(...)`, `Table.parseRetention(...)`, `Table.DEFAULT_MAINTENANCE_INTERVAL_MS`, `type TableStore` |
| `codec.ts` → `encodeSegment(data)`, `decodeSegment(buf)`, `isCompressedFormat(buf)` | `SegmentFileV2.encode(data)`, `SegmentFileV2.decode(buf)`, `SegmentFile.isWrapped(buf)` |
| `v3.ts` → `encodeV3(seg, opts)`, `decodeV3(buf)`, `isV3(buf)`, `type V3EncodeOptions` | `SegmentFileV3.encode(seg, opts)`, `SegmentFileV3.decode(buf)`, `SegmentFileV3.isV3(buf)`, `type V3EncodeOptions` |
| `v3.ts` → `readSegment(buf)` | `SegmentFile.read(buf)` |
| `v3.ts` → `zstdAvailable()`, `defaultCompression()`, `compress`, `decompress` | `Compression.zstdAvailable()`, `Compression.default()`, `Compression.compress(buf, mode)`, `Compression.decompress(buf, mode)` |
| `columns.ts` → `Column`, `RawColumn`, `CatchAllColumn`, `DictionaryColumn`, `DeltaColumn`, `RLEColumn`, `AutoColumn`, `COLUMN_TYPES`, `createColumn` | `columns/` — по классам; `ColumnFactory.types`, `ColumnFactory.create(type)` |
| `numcodecs.ts` → `F64Codec`, `DoubleDeltaCodec`, `GorillaCodec`, `RleCodec`, `type NumCodec`, `NUM_CODECS`, `getNumCodec`, `autoPickNumCodec` | `numcodecs/` — по классам; `NumCodecs.registry`, `NumCodecs.get(name)`, `NumCodecs.autoPick(values)` |

## Ключевые решения

1. **`SegmentFile` (диспетчер) отдельно от V2/V3.** `readSegment` читает v1/v2/v3 — это
   формат-независимая сущность «файл сегмента». Иначе V3-класс владел бы чтением V2 (как сейчас).
   `isCompressedFormat` (проверка магических байт, общие у v2/v3) → `SegmentFile.isWrapped`.
2. **`Compression` — отдельный класс.** Сжатие (gzip/zstd) используют и V3, и Journal, и Store.
   «сжатие/кодек» — буквально в примере правила 1. Локальный тип `Compression` из v3.ts
   переименовать в `CompressionKind` (избегать коллизии с именем класса).
3. **`Percentile` — static class.** `percentileKey`/`percentileOf` — чистые функции, общие для
   `Journal.percentile()` и `Table.percentile()`. Правило 1: слово-сущность есть → класс.
4. **Цикл journal ↔ retention (правило 9).** Сейчас: `journal.ts` → `retention.ts` (value)
   и `retention.ts` → `journal.ts` (`import type Journal`). Решение: в `RetentionEngine.ts`
   объявить структурный интерфейс `RetentionJournal` (нужные методы: `journalPath`,
   `closedSegmentIds`, `closedSegmentFile`, `closedSegmentInfo`, `getClosedSegment`,
   `reencodeClosedSegment`, `mergeClosedSegments`, `newSegmentId`) — `Journal` удовлетворяет
   ему структурно, импорт `Journal` в RetentionEngine.ts убирается полностью.
5. **`makeEngine(desc)` (journal.ts) остаётся module-private в `Journal.ts`** (`_makeEngine` /
   `// @internal`). Это маршрутизация kind→движок для compact; перенос в `Engine.ts` создаёт
   runtime-цикл (Log/Upsert/Summing/Collapsing наследуют `Engine`). Обновить комментарий в
   `compaction/Engine.ts` («Маршрутизация kind→класс — в journal.ts» → «в Journal.ts»).
6. **Публичный API = только классы + типы.** Старые имена-функции (`encodeSegment`, `parseSql`,
   `openTable`, …) исчезают — пользователь подтвердил, что совместимость имён не критична.
   `index.ts` переписывается как фасад по новым путям/именам.
7. **`BitWriter`/`BitReader`** — internal: свои файлы в `numcodecs/`, но НЕ экспортируются из
   `index.ts` (правило 3: не экспортируемое = приватное).
8. **`makeEngine`, `AggAcc`-хелперы, `isScanOp`/`keyOf`/`whereOne`, `resolveTs`,
   `installShutdownHooks`+`activeJournals`** — приватные помощники `Journal`: либо private static
   методы класса, либо module-private с `// @internal` (границы: shutdown-hooks — глобальное
   состояние → module-private; остальное — куда логичнее по месту использования).

## Порядок работы

1. `columns/` — разбить `columns.ts` (самодостаточный, не импортирует корень).
2. `numcodecs/` — разбить `numcodecs.ts` (самодостаточный).
3. `Compression.ts` — вынести сжатие из v3.ts.
4. `SegmentFileV2.ts`, `SegmentFileV3.ts`, `SegmentFile.ts` — из codec.ts + v3.ts.
5. `Percentile.ts` — из journal.ts.
6. `SqlError.ts`, `Sql.ts` — из sql.ts.
7. `RetentionEngine.ts` — из retention.ts (+ структурный интерфейс, разрыв цикла).
8. `Journal.ts` — из journal.ts (без percentile; приватные хелперы — в класс/module-private).
9. `Table.ts` — из table.ts (openTable→Table.open, parseRetention→Table.parseRetention,
   константа→static).
10. `Store.ts`, `Segment.ts`, `Interval.ts`, `LRUCache.ts` — переименование + импорт `Table.open`.
11. `index.ts` — новый фасад.
12. `test/` — импорты/имена под новый API.
13. `metricTable/retention.ts` — `import { Table } from '../Table.ts'`, `Table.parseRetention(...)`.
14. Проверка (см. ниже).

## Проверка (правило 10)

1. `npm run typecheck` (`tsc --noEmit`) — без ошибок.
2. `npm test` — все 20 тестов зелёные.
3. Пройтись глазами по каждому новому файлу: за 3 секунды понятно, кто владелец каждого
   export. Если нет — доработать группировку.
4. `npm run build` — lib/ собирается (опционально, артефакт).

## Вне скоупа (кандидаты на отдельную задачу)

- `metricTable/rollup.ts` (`promote`, `applyAgg` — `applyAgg` буквально «плохой пример» в правиле 8),
  `metricTable/retention.ts` (facade-обёртка над Table.parseRetention + дублирующая validateTiers)
  — camelCase-файлы со свободными функциями, по правилам должны быть классами.
- `lib/` — скомпилированный артефакт, обновляется `npm run build`.
