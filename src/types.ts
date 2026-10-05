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

/** Способ сжатия блобов в v3: 'gzip' (по умолчанию, Node ≥ 18) или
 *  'zstd' (Node ≥ 23.8; при отсутствии — автоматический откат на gzip). */
export type CompressionMode = 'gzip' | 'zstd';

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
  /** Сжатие блобов в v3 (по умолчанию `'gzip'`). `compression` игнорируется в v2. */
  compression?: CompressionMode;
  /** Явный выбор числового кодека для колонки в v3: поле → имя кодека
   *  ('f64' | 'doubleDelta' | 'gorilla' | 'rle'). Пропущенные — авто-выбор. */
  codecs?: Record<string, string>;
}

export interface StoreOptions {
  maxCacheSize?: number;
  defaultRowsPerSegment?: number;
  /** По умолчанию `'pid'` — см. `JournalOptions.lock`. */
  lock?: LockMode;
  /** Формат файлов сегментов для всех журналов (по умолчанию `'v2'`). */
  format?: SegmentFormat;
  /** Сжатие блобов в v3 (по умолчанию `'gzip'`). */
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
