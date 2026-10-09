// ============================================================
// index.ts — Публичный API пакета vrack2-journal-db
// ============================================================

export { Journal } from './Journal.ts';
export { Store } from './Store.ts';
export { Segment } from './Segment.ts';
export { Interval } from './Interval.ts';
export { LRUCache } from './LRUCache.ts';
export { SegmentFile } from './SegmentFile.ts';
export { SegmentFileV2 } from './SegmentFileV2.ts';
export { SegmentFileV3 } from './SegmentFileV3.ts';
export type { V3EncodeOptions } from './SegmentFileV3.ts';
export { Compression } from './Compression.ts';
export { F64Codec } from './numcodecs/F64Codec.ts';
export { DoubleDeltaCodec } from './numcodecs/DoubleDeltaCodec.ts';
export { GorillaCodec } from './numcodecs/GorillaCodec.ts';
export { RleCodec } from './numcodecs/RleCodec.ts';
export { NumCodecs } from './numcodecs/NumCodecs.ts';
export type { NumCodec } from './numcodecs/types.ts';
export { RetentionEngine } from './RetentionEngine.ts';
export type { RetentionHost } from './RetentionEngine.ts';
export { Sql } from './Sql.ts';
export { SqlError } from './SqlError.ts';
export type { InsertQuery } from './Sql.ts';
export { Column } from './columns/Column.ts';
export { RawColumn } from './columns/RawColumn.ts';
export { CatchAllColumn } from './columns/CatchAllColumn.ts';
export { DictionaryColumn } from './columns/DictionaryColumn.ts';
export { DeltaColumn } from './columns/DeltaColumn.ts';
export { RLEColumn } from './columns/RLEColumn.ts';
export { AutoColumn } from './columns/AutoColumn.ts';
export { ColumnFactory } from './columns/ColumnFactory.ts';

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
  SegmentEncoding,
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
export { Table, openTable, parseRetention } from './Table.ts';
export type { TableStore } from './Table.ts';

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
