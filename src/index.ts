// index.ts — public API of the vrack2-journal-db package.
//
// One face (ClickHouse model): Store — the catalog of tables,
// Table — a table, define*Table — a description (engine + tiers).
// The internal machinery (journals, segments, codecs, the SQL parser)
// is not exported — see RULES.md §5.

// --- values -------------------------------------------------

export { Store } from './Store.ts';
export { Table } from './Table.ts';
export { Interval } from './Interval.ts';
export {
  defineLogTable,
  defineUpsertTable,
  defineSummingTable,
  defineCollapsingTable
} from './compaction/define.ts';

// --- types -----------------------------------------------------

export type {
  AggFn,
  AggregateExpr,
  CompactResult,
  PurgeResult,
  ResolutionTier,
  RetentionTier,
  Row,
  ScanOptions,
  Schema,
  StoreStats,
  TableTierStat,
  TimelineBucket,
  RollupReport,
  TruncateResult
} from './types.ts';

export type {
  AnyTableDef,
  LogTableDef,
  UpsertTableDef,
  SummingTableDef,
  CollapsingTableDef,
  StorageConfig,
  TableDescription,
  TableRuntime
} from './compaction/define.ts';

export type { EngineKind } from './compaction/types.ts';
