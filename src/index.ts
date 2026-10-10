// ============================================================
// index.ts — Публичный API пакета vrack2-journal-db
//
// Одно лицо (ClickHouse-модель): Store — каталог таблиц,
// Table — таблица, define*Table — описание (движок + тиры).
// Внутренняя механика (журналы, сегменты, кодексы, SQL-парсер)
// не экспортируется — см. RULES.md §5.
// ============================================================

// --- значения -------------------------------------------------

export { Store } from './Store.ts';
export { Table } from './Table.ts';
export {
  defineLogTable,
  defineUpsertTable,
  defineSummingTable,
  defineCollapsingTable
} from './compaction/define.ts';

// --- типы -----------------------------------------------------

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
  RollupReport
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
