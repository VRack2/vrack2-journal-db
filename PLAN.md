# PLAN.md — кластеризующая компакция по измерениям («одна таблица на всё хранилище»)

> Self-notes. Цель: подготовка к модели ClickHouse-style: log-таблица { ts, dev, met, value },
> агрегация на чтении. Главная проблема — скан по измерениям при перемешанной записи:
> min/max по met/dev в любом сегменте покрывает всё, skip не работает.
> Решение: локальность измерений внутри ts-окна (кластеризующая компакция) + точные
> саммари измерений в .meta + расширение skipsWhere.
>
> Ground rules:
> - Прод-данных нет — обратная совместимость форматов НЕ требуется.
> - Ошибки — только кодовые через ErrorManager (никаких сырых throw).
> - После каждой фазы: `npm run typecheck && npm test` зелёные (полная цепочка, не выборочно).
> - RULES.md обязателен: одна сущность = файл, зависимости вниз (journal → compaction ✓, обратно ✗).
> - Байт версии в заголовке сегмент-файла остаётся; несовпадение версии — кодовая ошибка.

## Phase A — срезка мёртвых веток совместимости (делать первой: сужает формат до добавления полей)

Удалить:
1. `src/format/SegmentFileV2.ts` (v2 gzip+JSON + v1 plain-JSON read).
2. `src/journal/Migration.ts` + `Journal._ensureV3()` / `migrateToV3()` + вызовы из `compact()`/`compactBatch()`
   (комментарий «test-migration relies on this» поправить).
3. `src/journal/segmentFormat.ts` (единственный потребитель — Migration).
4. Опцию формата: `SegmentFormat` в `core/types.ts`, `format` в `JournalOptions`/`StoreOptions`/`OpenJournalOptions`,
   `Store` default `'v2'` → всё v3; `JRN_OPT_FORMAT` из `journal/errors.ts`; `SegmentEncoder` — всегда v3.
5. `SEG_V2_EXT` в `journal/constants.ts`; `isSegmentFile`/`idFromFile` — только `.seg`.
6. `test/test-migration.ts` + запись в цепочке `npm test` (package.json).
7. `Segment.serialize()/deserialize()` и тип `SerializedSegment` — после удаления v2 мёртвы в src
   (тесты `test-load`/`test-querying`/`test-compression`/`test-v3-format` читают через `SegmentFileV2`/v1 —
   переписать секции на v3 API или удалить). `Column.serialize()/deserialize()` ОСТАВИТЬ как
   `@internal`-окно формата (используется в test-optimization/test-compaction для проверок кодеков).

Формат-контур после A:
- `SegmentFile.read(buf)` — только JSDB v3; байт версии в заголовке [4] сохраняется;
  `buf[4] !== V4` → новая кодовая ошибка `SFW3_BAD_VERSION { version }` (вместо тихого чтения
  legacy v3 с JSON-rowMap; легаси-ветку `V3 = 3` в `SegmentFileV3.decode` и `header.rowMap` удалить).
- `Segment.deserialize`-проверка `formatVersion` уходит вместе с методом.

## Phase B — движок и операция кластеризующей компакции

1. `src/compaction/Cluster.ts` — static class `Cluster`:
   - `compare(a, b, cols): number` — по значениям колонок-измерений (строгие примитивы, null last),
     затем по ts ↑; стабильная сортировка строк (полуkeyOf-семантика, но локально: compaction не
     импортирует journal/scan — §9).
   - `sort(rows, cols): Row[]`.
2. Конфиг: `cluster?: string[]` в `BaseTableDef` (`compaction/define.ts`), валидация в `validateBase`:
   непустой массив, поля есть в columns, нет `ts`, нет дублей → коды `DEF_CLUSTER_EMPTY/FIELD/DUP/TS`.
   Ключ в метаданные журнала — `CLUSTER_META_KEY` рядом с `ENGINE_META_KEY` (`compaction/Descriptor.ts`),
   пишет `Table` при открытии journals (как descriptor).
3. `Segment.clusterKey: string[] | null` — поле сегмента; persist в v3-header (`clusterKey?`),
   читается при decode. `SegmentMeta`: поля `cluster: string[] | null` и `tsOrdered: boolean`
   (true = строки сегмента в ts-порядке; false у кластеризованных) в fromSegment/parse.
4. `Journal.clusterCompact(start?: number, end?: number): ClusterReport`:
   - выборка закрытых сегментов, пересекающих ts-окно (по `.meta`, без загрузки; окно по умолчанию — всё);
   - батчи по ts-соседям из `sortedIds()` с бюджетом строк (механика как `AutoCompactor.pickBatch`) —
     память ограничена батчем, НЕ всю таблицу;
   - `store.merge(ids, engineMerge ∘ Cluster.sort(rows, clusterKey))`; новый сегмент получает
     `clusterKey` (тот же spec). `ClusterReport { mergedSegments, windows, rows }` — новый тип в core/types.
   - порядок сегментов по ts сохраняется: батчи берутся из `sortedIds()` (minTs ↑), новый id,
     сортировка `sortedIds()` не меняется.
5. Переживание дописывания новых сегментов: свежие сегменты некластеризованы (`clusterKey = null`,
   `tsOrdered = true`) и корректно сканируются всегда. Кластеризация включается в общий трансформ
   `compactBatch()` (рядом с `ENGINE_META_KEY`): если в метаданных журнала есть `CLUSTER_META_KEY`,
   background auto-compaction (`AutoCompactor.mergeBatch → compactBatch`) кластеризует автоматически —
   отдельного фона не нужно; явная команда `Table.clusterCompact(start?, end?)` — для разовой
   перекомпоновки существующих данных.
6. Для существующих таблиц (описаны в `_store.json` без `cluster`): `Table.setCluster(cols)` —
   валидация, запись в `this.def`, обновление манифеста (`Store` — маленький internal-хелпер
   `_updateDef(def)` поверх существующего `_writeManifest`), переоткрытие подхватит metadata.
   Разовую перекомпоновку вызывает отдельно `clusterCompact()`.

## Phase C — саммари измерений в .meta + расширение skipsWhere

1. `core/types.ts`: `DimSummary = { t: 'set'; v: (string | number | boolean | null)[] }`
   (точный набор, когда мощность ≤ `DIM_SET_LIMIT` = 64 и значения примитивны)
   | `{ t: 'range'; min: number; max: number }` (числовой домен — мин/макс по всем строкам).
2. Источник набора — бесплатнаяdictionary-подложка: `Column.distinct(limit): (string|number|boolean|null)[] | null`
   — base возвращает null; `DictionaryColumn` — `dictionary` (это distinct по ФИЗИЧЕСКИМ значениям ⊇
   логические → безопасный суперсет для skip); `RLEColumn` — по runs; `AutoColumn` — через delegate.
3. `SegmentMeta.fromSegment` считает `dims: Record<string, DimSummary> | null` только для колонок из
   `seg.clusterKey` (иначе .meta раздувается). Это производные данные — `loadClosed` восстанавливает
   их детерминированно из колонок, как и всё остальное в сайдкаре.
4. `skipsWhere`: для `field ∈ dims` (НЕ требует `hasTsFilter` — набор/диапазон покрывают ВСЕ строки
   сегмента, включая без-ts; это отдельная консервативная ветка, задокументировать в комментарии метода):
   - `t: 'set'`: `eq` → skip, если значения нет в наборе; `in` → skip, если пересечения нет;
     `isNull` → skip, если null нет в наборе;
   - `t: 'range'`: `eq/in` только с числовым target (как сейчас, но без требования ts-фильтра —
     range посчитан по всем строкам);
   - `ne/nin/isNotNull/lt/le/gt/ge` для нечисловых — по-прежнему никогда не skip.
   Числовые колонки вне dims — прежняя логика через `summaries` с `hasTsFilter`.

## Phase D — scan: корректность и замер сублинейности

1. Инвариант раннего стопа (`execute.ts:30-59`) ломается на кластеризованных сегментах: внутри них
   строки в порядке измерений, не ts. Правка: `canEarlyStop` требует `meta.tsOrdered !== false` у всех
   закрытых сегментов (плюс сохранить текущие гейты); per-segment early-return в `processSegment` — тот же флаг.
   Без `limit`-раннего стопа результат не меняется (`sortRows` по ts в конце — `TieredQuery.mergeAsc` цел).
2. Pushdown уже есть (4.0.0): where/select/limit во все тиры + k-way merge — новых изменений не требует,
   но зафиксировать регрессом.
3. Замер на тестовом объёме (`test-cluster.ts`): ~50 метрик × 20 девайсов, несколько месяцев,
   десятки сегментов; после кластеризации `scan({ where: [{met eq}], start, end: месяц })` —
   счётчик загрузок (обёртка `store.loadClosed`) обязан быть долей от общего числа сегментов окна
   (детерминированное утверждение по счётчику, не по wall-time).

## Phase E — примитивы модели «агрегация на чтении»

1. `defineLogTable({ retention })` — единый TTL: валиден одно-тирный `retention: 'res:ttl'`
   (Maintenance auto-purge режет по ttlMs; пар роллапа нет → только TTL). Проверить тестом, что
   single-tier table: rollup — no-op, purge работает. Если нужен TTL без агрегации вообще —
   это `Table.purge()` + `autoPurge` (задокументировать в docs/Retention.md).
2. `aggregate()` в tier-режиме — пробел (сейчас `TBL_SCAN_AGG` запрещает agg/groupBy в `Table.scan`,
   а `Table.aggregate` материализует все строки через `query()` без where). Дописать:
   - `Table.aggregate(start, end, exprs, where?)`: single-journal → `journal.scan({ start, end, where, agg })`
     (саммари-фастпуть сегментов уже есть); tier → прогнать agg-скан по окну каждого тира и склеить
     группы через аккумуляторы `Aggregation` (min/max/sum/count адитивны; avg = sum/count) —
     новый метод в `TieredQuery.aggregate(...)`.
   - `groupBy` через scan уже отдаёт строки-группы; в tier-режиме склеить одинаковые ключи групп тем же способом.
3. `timeline` — достаточно (есть поверх тиров).

## Phase F — тесты, доки

- `test/test-cluster.ts` (в цепочку `npm test` вместо `test-migration`):
  1. кластеризация сохраняет мультимножество строк; порядок внутри сегмента — по (dims, ts), порядок
     сегментов по ts не изменился;
  2. регрессы skip по измерениям: eq/in по `met`/`dev` после кластеризации (счётчик загрузок);
     частично перекомпонованные данные (смешанные кластеризованные/нет сегменты — результат полон,
     skip применялся только к кластеризованным); смена spec → старый clusterKey считается некластеризованным;
  3. dims в .meta: малый домен → set, большой → range/null; восстановление сайдкара из сегмента идентично;
  4. ранний стоп с limit на кластеризованных сегментах корректен;
  5. сублинейный замер (Phase D.3);
  6. `setCluster` для существующей таблицы: манифест пережил перезапуск, компакция подхватывает spec.
- `test-table.ts`: валидация `cluster` (DEF_CLUSTER_*), `aggregate` с where и groupBy в tier-режиме
  совпадает с single-journal; single-tier retention TTL.
- `test-scan.ts`: dims-скипы без ts-фильтра (set), консерватизм ne/nin.
- CHANGELOG.md — секция (breaking: v2/v1/migrateToV3 удалены; `.meta` dims; cluster; aggregate/where).
- docs: `Formats.md` (заголовок только v4 + `SFW3_BAD_VERSION`, `.meta` `dims`/`cluster`/`tsOrdered`),
  `Maintenance.md` (`clusterCompact`, авто-кластеризация через auto-compact, `setCluster`),
  `Querying.md` (skip по измерениям, сублинейный скан), `Retention.md` (TTL одно-тирной log-таблицы).
  README — примеры одно-табличной модели (`defineLogTable({ cluster: ['met','dev'], retention: '5s:30d' })`).
- RULES.md — зафиксировать: `compaction/Cluster.ts` как сущность операции; новые поля `.meta` — только
  производные (rebuild from segment); запрет неформатных throw (уже есть практика ErrorManager).

## Порядок и проверки

A (чистка) → B (движок/операция) → C (саммари/skip) → D (скан/замер) → E (aggregate) → F (доки).
Каждая фаза: `npm run typecheck` + полный `npm test`; коммиты в стиле репо (`feat(cluster): …`, `refactor(format): …`).
Done = все фазы зелёные + `npm run build`.

## Риски / решения

- Инвариант «append ts-неубывающий» документирован в README — кластеризация его локально ломает,
  поэтому `tsOrdered` в .meta обязателен (иначе limit-сканы дают не те строки).
- `dims` только для `clusterKey`-колонок: cheap .meta; некластеризованные сегменты skip по измерениям
  не дают (консервативно) — корректность не страдает.
- Смена `cluster`-спецификации: сегменты со старым `clusterKey` — кандидат на перекомпакцию; skip по
  dims для них применять можно (set точен всегда), но перекомпоновка — по команде.
- Память `clusterCompact`: батч-бюджет по строкам, как у AutoCompactor; никогда не вся таблица.
