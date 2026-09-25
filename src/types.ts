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
  minTs: number | null;
  maxTs: number | null;
  rowMap: number[];
  columns: Record<string, SerializedColumn>;
}

/** Результат компактизации журнала */
export interface CompactResult {
  mergedSegments: number;
  logicalRows: number;
  physicalBefore: number;
  physicalAfter: number;
}

// --------------------------------------------------
// Опции и статистика
// --------------------------------------------------
/** Стратегия блокировки журнала одним владельцем. */
export type LockMode = 'pid' | 'off';

export interface JournalOptions {
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
}

export interface StoreOptions {
  maxCacheSize?: number;
  defaultRowsPerSegment?: number;
  /** По умолчанию `'pid'` — см. `JournalOptions.lock`. */
  lock?: LockMode;
}

export interface OpenJournalOptions {
  rowsPerSegment?: number;
  maxCachedSegments?: number;
  /** Переопределяет `lock` из StoreOptions для этого журнала. */
  lock?: LockMode;
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
