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
export { parseSql, parseInsert, SqlError, type InsertQuery } from './sql.ts';
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
  TimelineBucket,
  ResolutionTier,
  TableConfig,
  TableTierStat,
  RollupReport
} from './types.ts';

// ============================================================
// Фаза 4 — Table (мультитирная таблица-метрик, GraphiteMergeTree)
// ============================================================
export { Table, openTable, parseRetention } from './table.ts';
export type { TableStore } from './table.ts';

// ============================================================
// Фаза 1 — Движки компактизации (compaction/) + описания таблиц (define*Table)
// ============================================================
export { ENGINE_KINDS } from './compaction/Engine.ts';
export type { Engine } from './compaction/Engine.ts';
export { Descriptor, ENGINE_META_KEY } from './compaction/Descriptor.ts';
export { Log } from './compaction/Log.ts';
export { Upsert } from './compaction/Upsert.ts';
export { Summing } from './compaction/Summing.ts';
export { Collapsing } from './compaction/Collapsing.ts';
export {
  defineLogTable,
  defineUpsertTable,
  defineSummingTable,
  defineCollapsingTable,
  engineDescriptorOf
} from './compaction/define.ts';
export type {
  AnyTableDef,
  LogTableDef,
  UpsertTableDef,
  SummingTableDef,
  CollapsingTableDef,
  TableRuntime,
  TableDescription
} from './compaction/define.ts';
export type { EngineKind } from './compaction/types.ts';

// ============================================================
// Фаза 2 — Мультитирная метрика-таблица (metricTable/: Tier + rollup + retention)
// ============================================================
export { MergeTree } from './metricTable/MergeTree.ts';
export type {
  MergeTreeConfig,
  MergeTreeRollupReport,
  MergeTreeTierStat
} from './metricTable/MergeTree.ts';
export { Tier } from './metricTable/Tier.ts';
export { promote, applyAgg } from './metricTable/rollup.ts';
export type { RollupConfig } from './metricTable/rollup.ts';
export { tiersForRetention, validateTiers } from './metricTable/retention.ts';
