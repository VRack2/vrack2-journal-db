// ============================================================
// index.ts — Публичный API пакета vrack2-journal-db
// ============================================================

export { Journal } from './journal.ts';
export { Store } from './store.ts';
export { Segment } from './segment.ts';
export { LRUCache } from './cache.ts';
export { encodeSegment, decodeSegment, isCompressedFormat } from './codec.ts';
export {
  AutoColumn,
  CatchAllColumn,
  COLUMN_TYPES,
  Column,
  createColumn,
  DeltaColumn,
  DictionaryColumn,
  RawColumn,
  RLEColumn
} from './columns.ts';

export type {
  CompactResult,
  ColumnType,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  JournalOptions,
  JournalStats,
  Metadata,
  OpenJournalOptions,
  Row,
  Schema,
  SerializedColumn,
  SerializedSegment,
  StoreOptions,
  StoreStats
} from './types.ts';
