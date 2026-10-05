// ============================================================
// types.ts — Общие типы и формат сериализации
// ============================================================

export type ColumnType = 'raw' | 'dictionary' | 'delta' | 'rle' | 'auto' | 'catchall';

/** Схема журнала: поле → тип колонки */
export interface Schema {
  [field: string]: ColumnType;
}

// JSON-совместимые значения (то, что может лежать в строке)
export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** Строка журнала */
export type Row = Record<string, JsonValue>;

/** Метаданные журнала/сегмента */
export type Metadata = JsonObject;

// --------------------------------------------------
// Формат сериализованных колонок (на диске) — дискриминированный union
// --------------------------------------------------
export interface RawColumnData {
  type: 'raw';
  data: JsonValue[];
}

export interface DictionaryColumnData {
  type: 'dictionary';
  dictionary: JsonValue[];
  data: number[];
}

export interface DeltaColumnData {
  type: 'delta';
  baseValue: number | null;
  deltas: number[];
}

export interface RLERun {
  value: JsonValue;
  count: number;
}

export interface RLEColumnData {
  type: 'rle';
  runs: RLERun[];
}

export type AutoColumnData =
  | { type: 'auto'; decided: false; samples: JsonValue[] }
  | { type: 'auto'; decided: true; delegate: SerializedColumn };

export type SerializedColumn =
  | RawColumnData
  | DictionaryColumnData
  | DeltaColumnData
  | RLEColumnData
  | AutoColumnData;

// --------------------------------------------------
// Формат сериализованного сегмента (JSON-файл)
// --------------------------------------------------
export interface SerializedSegment {
  /** Версия формата payload'а. Отсутствует в файлах v1 (JS-реализация) */
  formatVersion?: number;
  id: string;
  schema: Schema;
  metadata: Metadata;
  rowCount: number;
  physicalRowCount: number;
  /** Сколько строк несёт числовой ts (строки без ts не учитываются).
   *  Опционально: отсутствует в файлах до этой версии поля. */
  tsCount?: number;
  minTs: number | null;
  maxTs: number | null;
  rowMap: number[];
  columns: Record<string, SerializedColumn>;
  /** Сегментные саммари числовых колонок (min/max/sum/count по непустым
   *  числовым значениям). Опционально: отсутствует в старых файлах —
   *  Segment.deserialize() пересчитывает на лету. */
  summaries?: Record<string, ColumnSummary>;
}

// --------------------------------------------------
// Агрегации (Фаза 1) — min/max/sum/avg/count по диапазону
// --------------------------------------------------

/** Поддерживаемые агрегационные функции. */
export type AggFn = 'min' | 'max' | 'sum' | 'avg' | 'count';

/** Выражение агрегации: поле + функция. */
export interface AggregateExpr {
  field: string;
  fn: AggFn;
}

/** Оператор сравнения в условии where() скана. */
export type ScanOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'in' | 'nin' | 'isNull' | 'isNotNull';

/** Одно условие фильтра scan(): поле + оператор + значение.
 *  Условия соединяются И (AND). Для in/nin значение — массив;
 *  для isNull/isNotNull значение не требуется. */
export interface ScanWhere {
  field: string;
  op: ScanOp;
  value?: JsonValue;
}

/**
 * Опции векторного скана Journal.scan().
 *
 * Два режима:
 *  - с `agg` (Фаза 3): возвращает агрегированные строки — по одной на группу
 *    (или одну строку без groupBy). Ключ агрегата — `поле_функция`;
 *    `count` — число числовых значений поля.
 *  - без `agg`: возвращает материализованные строки только по колонкам `select`
 *    (по умолчанию — все поля схемы), отфильтрованные, отсортированные,
 *    с offset/limit.
 *
 * Сегмент, не пересекающий [start, end], не читается с диска (решение по .meta).
 */
export interface ScanOptions {
  /** Диапазон ts [start, end] (обе границы включительно). Числа (мс) или строки вида 'now-1h'. */
  start?: number | string;
  end?: number | string;
  /** Колонки для выборки (режим без agg). По умолчанию — все поля схемы. */
  select?: string[];
  /** Фильтр: условия, соединённые И (AND). */
  where?: ScanWhere[];
  /** Поле группировки (одно или несколько). Требует `agg`. */
  groupBy?: string | string[];
  /** Агрегаты: поле → список функций. Наличие включает режим агрегации. */
  agg?: Record<string, AggFn[]>;
  /** Порядок результата: 'asc' | 'desc'.
   *  - с agg — по первому ключу агрегата (поле_функция);
   *  - без agg — по первой колонке select (или 'ts', если в ней есть числовые). */
  order?: 'asc' | 'desc';
  /** Ограничение числа строк результата (после сортировки, после offset). */
  limit?: number;
  /** Пропустить первые N строк (после сортировки, перед limit). */
  offset?: number;
}

/** Саммари числовой колонки на сегмент: min/max/sum/count по непустым
 *  числовым значениям (null/не-числа не считаются). */
export interface ColumnSummary {
  min: number;
  max: number;
  sum: number;
  /** Сколько числовых значений учтено (0 — в сегменте их нет). */
  count: number;
}

/** Бакет даунсэмплинга: границы + агрегаты `field` в бакете.
 *  Присутствуют только запрошенные функции (и всегда `count`). */
export interface DownsampleBucket {
  /** Начало бакета (ms, включительно). */
  start: number;
  /** Конец бакета (ms, не включительно; у последнего = период.end). */
  end: number;
  /** Сколько числовых значений `field` в бакете (0 — пустой). */
  count: number;
  /** Есть ли данные в бакете (count > 0). */
  hasData: boolean;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  avg?: number | null;
}

/** Результат компактизации журнала */
export interface CompactResult {
  mergedSegments: number;
  logicalRows: number;
  physicalBefore: number;
  physicalAfter: number;
}

export interface PurgeResult {
  /** Сколько строк удалено из журнала. */
  removedRows: number;
  /** Сколько сегментов удалено целиком (старше границы, без чтения файлов). */
  removedSegments: number;
  /** Сколько сегментов перекодировано без старых строк (пересекали границу). */
  rewrittenSegments: number;
}

/** Один бакет таймлайна: интервал времени и сколько строк в нём. */
export interface TimelineBucket {
  /** Начало бакета (ms, включительно). */
  start: number;
  /** Конец бакета (ms, не включительно; у последнего = period.end). */
  end: number;
  /** Сколько строк с ts в [start, end). Строки без ts не считаются. */
  count: number;
  /** Есть ли данные в бакете (count > 0). */
  hasData: boolean;
}

// --------------------------------------------------
// Опции и статистика
// --------------------------------------------------
/** Стратегия блокировки журнала одним владельцем. */
export type LockMode = 'pid' | 'off';

/** Формат файлов сегментов: v1/v2 (gzip+JSON) или v3 (бинарные блобы колонок).
 *  Чтение прозрачное — любой формат читается; запись идёт в выбранном формате. */
export type SegmentFormat = 'v2' | 'v3';

/** Способ сжатия блобов в v3: 'zstd' (по умолчанию при Node ≥ 23.8) или
 *  'gzip' (старые Node / явный выбор; zstd при отсутствии — откат на gzip). */
export type CompressionMode = 'gzip' | 'zstd';

// --------------------------------------------------
// Retention (Фаза 4) — тир'ы и отчётность движка
// --------------------------------------------------

/** Тир хранения: данные заданного возраста перекодируются по нему. */
export interface RetentionTier {
  /** Идентификатор тира ('hot'|'warm'|'cold'|'archive' или свой). */
  id: string;
  /** Минимальный возраст данных (мс, включительно). 0 — самые свежие. */
  from: number;
  /** Максимальный возраст (мс, исключительно). Infinity — самые старые. */
  to: number;
  /** Числовой кодек колонки значений ('f64'|'doubleDelta'|'gorilla'|'rle'). */
  codec: string;
  /** Целевой размер блока (мс) при слиянии (1h → 1d). */
  block: number;
  /** Сжатие: 'none' (raw), 'gzip', 'zstd'. */
  compress: 'none' | 'gzip' | 'zstd';
  /** Минимальный интервал ts (мс) для даунсэмплинга; 0 — без потерь данных. */
  minInterval: number;
  /** Дельта-кодировать колонку ts (doubleDelta). */
  tsDelta: boolean;
}

/** Статус тира: сколько сегментов/байт/строк и диапазон ts. */
export interface TierStatus {
  id: string;
  from: number;
  to: number;
  segments: number;
  bytes: number;
  rows: number;
  oldestTs: number | null;
  newestTs: number | null;
}

/** Пункт плана: что сделать с сегментом (reencode / merge / ничего). */
export interface ConversionPlan {
  segId: string;
  tier: string;
  action: 'none' | 'reencode' | 'merge';
  targetCodec: string;
  targetCompress: string;
  groupSize: number;
}

/** Отчёт применения retention: что перекодировано/слито, до/после. */
export interface ApplyReport {
  reencoded: number;
  merged: number;
  skipped: number;
  beforeSegments: number;
  afterSegments: number;
  beforeBytes: number;
  afterBytes: number;
}

/** Отчёт компактизации одного тира (слияние блоков). */
export interface CompactTierReport {
  tier: string;
  mergedGroups: number;
  beforeSegments: number;
  afterSegments: number;
}

// --------------------------------------------------
// Table (Фаза 4) — мультитирная таблица (GraphiteMergeTree)
//
// Один метрик → одна таблица = несколько тиров разрешения (каждый —
// отдельный журнал): свежие данные на тонком разрешении, старые — на
// грубом (rollup по возрасту + TTL). Размер предсказуем:
// Σ(разрешение × ttl). Чтение разбивает диапазон по «возрасту» на окна
// тиров и склеивает ответ в хронологическом порядке.
// --------------------------------------------------

/** Тир разрешения: данные хранятся на шаге `resMs`, пока не «возрастут» до
 *  `ttlMs` (после чего rollup переносит их на более грубый тир).
 *  Тир'ы идут от тонких (0) к грубым; разрешение и ttl неубывающие. */
export interface ResolutionTier {
  /** Шаг отсчёта на тире (мс): 5s = 5000, 15s = 15000, 1m = 60000. */
  resMs: number;
  /** Сколько данные живут на тире (мс): 1d = 86400000. Дальше — rollup. */
  ttlMs: number;
}

/** Конфигурация таблицы. */
export interface TableConfig {
  /** Retention-политика строкой: '5s:1d,15s:1w,1m:1mon' (res:ttl,…).
   *  Если задан `tiers`, `retention` игнорируется. */
  retention?: string;
  /** Явный массив тиров (от тонких к грубым). Приоритет над `retention`. */
  tiers?: ResolutionTier[];
  /** Агрегация при rollup: поле → функция (что держать в бакете),
   *  например { value: 'avg' }. Пропущенное поле считается размером (dimension),
   *  и rollup группирует по нему (per-host и т.п.). По умолчанию — первая
   *  не-ts колонка схемы с fn 'avg'. */
  agg?: Record<string, AggFn>;
  /** Схема колонок (одна на все тиры). По умолчанию { ts: 'delta', value: 'auto' }. */
  schema?: Schema;
  /** Строк в сегменте на тир (по умолчанию из Store). */
  rowsPerSegment?: number;
  /** Провайдер «текущего времени» (для тестов и детерминированного rollup).
   *  По умолчанию Date.now. */
  nowProvider?: () => number;
}

/** Статус одного тира таблицы. */
export interface TableTierStat {
  /** Индекс тира (0 — самый тонкий). */
  tier: number;
  /** Разрешение тира (мс). */
  resMs: number;
  /** TTL тира (мс). */
  ttlMs: number;
  /** Строк на тире (закрытые сегменты + активный). */
  rows: number;
  /** Размер на диске (закрытые сегменты, байты). */
  bytes: number;
  /** Диапазон ts на тире (null, если пусто). */
  minTs: number | null;
  maxTs: number | null;
}

/** Отчёт rollup за один вызов. */
export interface RollupReport {
  /** Сколько пар тиров (fine→coarse) обработано. */
  pairs: number;
  /** Сколько строк прочитано из мелких тиров и перекодировано в грубые. */
  rolledRows: number;
  /** Сколько строк удалено из мелких тиров (purge после переноса). */
  purgedRows: number;
}

export interface JournalOptions {
  /** Сколько строк в одном файле сегмента до flush'а (по умолчанию 10 000).
   *  Меньше — больше файлов (удобно для тестов и точной дедупликации);
   *  больше — меньше операций ФС и износа SSD, но крупнее перекодирование
   *  «пересекающего» сегмента при purge/compact. */
  rowsPerSegment?: number;
  maxCachedSegments?: number;
  /** Размер пачки WAL: сколько строк накапливать в памяти перед записью на диск.
   *  1 — писать каждую строку сразу (максимальная устойчивость к краху, медленнее). */
  walBatchSize?: number;
  /** Блокировка журнала одним владельцем (файл `.lock` + PID владельца):
   * - `'pid'` (по умолчанию) — open() бросает ошибку, если журнал уже открыт
   *   живым процессом; устаревшую блокировку (мёртвый PID) забирает себе.
   * - `'off'` — библиотека не создаёт и не проверяет `.lock`: координация
   *   владельцев целиком на стороне приложения. Нужно, например, когда база
   *   живёт в worker_threads: воркер может умереть при живом процессе, и
   *   PID-блокировка будет выглядеть «занятой» навсегда. */
  lock?: LockMode;
  /** Формат файлов сегментов (по умолчанию `'v2'`). `'v3'` — бинарные блобы
   *  колонок (числовые кодек + словарь + сжатие), файлы `.seg`; v1/v2 читаются. */
  format?: SegmentFormat;
  /** Сжатие блобов в v3 (по умолчанию `'zstd'` при Node ≥ 23.8, иначе `'gzip'`).
   *  `compression` игнорируется в v2. */
  compression?: CompressionMode;
  /** Явный выбор числового кодека для колонки в v3: поле → имя кодека
   *  ('f64' | 'doubleDelta' | 'gorilla' | 'rle'). Пропущенные — авто-выбор. */
  codecs?: Record<string, string>;
  /** Тир'ы retention (Фаза 4). По умолчанию defaultTiers() — см. retention.ts. */
  retention?: RetentionTier[];
}

export interface StoreOptions {
  maxCacheSize?: number;
  defaultRowsPerSegment?: number;
  /** По умолчанию `'pid'` — см. `JournalOptions.lock`. */
  lock?: LockMode;
  /** Формат файлов сегментов для всех журналов (по умолчанию `'v2'`). */
  format?: SegmentFormat;
  /** Сжатие блобов в v3 (по умолчанию `'zstd'` при Node ≥ 23.8, иначе `'gzip'`). */
  compression?: CompressionMode;
  /** Числовые кодеки v3 по умолчанию: поле → имя кодека. */
  codecs?: Record<string, string>;
}

export interface OpenJournalOptions {
  rowsPerSegment?: number;
  maxCachedSegments?: number;
  /** Переопределяет `lock` из StoreOptions для этого журнала. */
  lock?: LockMode;
  /** Переопределяет `format` из StoreOptions для этого журнала. */
  format?: SegmentFormat;
  /** Переопределяет `compression` из StoreOptions. */
  compression?: CompressionMode;
  /** Переопределяет `codecs` из StoreOptions. */
  codecs?: Record<string, string>;
}

export interface JournalStats {
  name: string | null;
  isOpen: boolean;
  segmentCount: number;
  totalRows: number;
  totalPhysicalRows: number;
  dedupRatio: string;
  timeRange: [number, number] | null;
}

export interface StoreStats {
  baseDir: string;
  journalCount: number;
  openJournalCount: number;
  totalSegments: number;
  cacheSize: number;
  cacheMaxSize: number;
  journals: string[];
}
