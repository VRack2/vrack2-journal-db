// ============================================================
// index.ts — Публичный API пакета vrack2-journal-db
// ============================================================

export { Journal } from './journal.ts';
export { Store } from './store.ts';
export { Segment } from './segment.ts';
export { Interval } from './interval.ts';
export { LRUCache } from './cache.ts';
export { encodeSegment, decodeSegment, isCompressedFormat } from './codec.ts';
export {
  encodeV3,
  decodeV3,
  readSegment,
  isV3,
  type V3EncodeOptions
} from './v3.ts';
export {
  F64Codec,
  DoubleDeltaCodec,
  GorillaCodec,
  RleCodec,
  NUM_CODECS,
  getNumCodec,
  autoPickNumCodec,
  type NumCodec
} from './numcodecs.ts';
export {
  RetentionEngine,
  defaultTiers,
  type SegmentEncoding
} from './retention.ts';
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
  AggregateExpr,
  AggFn,
  ApplyReport,
  ColumnSummary,
  CompactResult,
  CompactTierReport,
  ColumnType,
  ConversionPlan,
  DownsampleBucket,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  CompressionMode,
  JournalOptions,
  JournalStats,
  LockMode,
  Metadata,
  OpenJournalOptions,
  PurgeResult,
  RetentionTier,
  Row,
  ScanOp,
  ScanOptions,
  Schema,
  SegmentFormat,
  SerializedColumn,
  SerializedSegment,
  StoreOptions,
  StoreStats,
  TierStatus,
  TimelineBucket
} from './types.ts';
