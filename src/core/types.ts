// ============================================================
// types.ts — Common types
// ============================================================

export type ColumnType = 'raw' | 'dictionary' | 'delta' | 'rle' | 'auto' | 'catchall';

/** Journal schema: field → column type */
export interface Schema {
  [field: string]: ColumnType;
}

// JSON-compatible values (what can sit in a row)
export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** Journal row */
export type Row = Record<string, JsonValue>;

/** Journal/segment metadata */
export type Metadata = JsonObject;

// --------------------------------------------------
// Serialized column format (on disk) — discriminated union
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
// Aggregations — min/max/sum/avg/count over a range
// --------------------------------------------------

/** Supported aggregate functions. */
export type AggFn = 'min' | 'max' | 'sum' | 'avg' | 'count';

/** Aggregation expression: field + function. */
export interface AggregateExpr {
  field: string;
  fn: AggFn;
}

/** Comparison operator in a scan where() condition. */
export type ScanOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'in' | 'nin' | 'isNull' | 'isNotNull';

/** One scan() filter condition: field + operator + value.
 *  Conditions are joined with AND. For in/nin the value is an array;
 *  for isNull/isNotNull no value is required. */
export interface ScanWhere {
  field: string;
  op: ScanOp;
  value?: JsonValue;
}

/**
 * Options for the vector scan Journal.scan().
 *
 * Two modes:
 *  - with `agg`: returns aggregated rows — one per group (or a single row
 *    without groupBy). Aggregate key — `field_fn`; `count` — the number of
 *    numeric values of the field.
 *  - without `agg`: returns materialized rows only for the `select` columns
 *    (by default — all schema fields), filtered, sorted, with offset/limit.
 *
 * A segment that does not intersect [start, end] is not read from disk (decided by .meta).
 */
export interface ScanOptions {
  /** ts range [start, end] (both bounds inclusive). Numbers (ms) or strings like 'now-1h'. */
  start?: number | string;
  end?: number | string;
  /** Columns to project (non-agg mode). Default — all schema fields. */
  select?: string[];
  /** Filter: conditions joined with AND. */
  where?: ScanWhere[];
  /** Group-by field (one or several). Requires `agg`. */
  groupBy?: string | string[];
  /** Aggregates: field → list of functions. Presence enables aggregate mode. */
  agg?: Record<string, AggFn[]>;
  /** Result order: 'asc' | 'desc'.
   *  - with agg — by the first aggregate key (field_fn);
   *  - without agg — by the first select column (or 'ts' if it has numeric values). */
  order?: 'asc' | 'desc';
  /** Cap on the number of result rows (after sorting, after offset). */
  limit?: number;
  /** Skip the first N rows (after sorting, before limit). */
  offset?: number;
}

/** Per-segment summary of a numeric column: min/max/sum/count over non-empty
 *  numeric values (null/non-numerics are not counted). */
export interface ColumnSummary {
  min: number;
  max: number;
  sum: number;
  /** How many numeric values were counted (0 — none in the segment). */
  count: number;
}

/** Downsampling bucket: bounds + `field` aggregates in the bucket.
 *  Only the requested functions are present (and always `count`). */
export interface DownsampleBucket {
  /** Bucket start (ms, inclusive). */
  start: number;
  /** Bucket end (ms, exclusive; for the last one = period.end). */
  end: number;
  /** How many numeric values of `field` in the bucket (0 — empty). */
  count: number;
  /** Whether the bucket has data (count > 0). */
  hasData: boolean;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  avg?: number | null;
}

/** Result of journal compaction */
export interface CompactResult {
  mergedSegments: number;
  logicalRows: number;
  physicalBefore: number;
  physicalAfter: number;
  /** How many rows the engine collapsed (upsert/summing/collapsing); 0 for log. */
  collapsedRows: number;
}

export interface PurgeResult {
  /** How many rows were removed from the journal. */
  removedRows: number;
  /** How many segments were removed wholesale (older than the bound, without reading files). */
  removedSegments: number;
  /** How many segments were re-encoded without the old rows (they crossed the bound). */
  rewrittenSegments: number;
}

/** Result of fully clearing a table/journal (truncate). */
export interface TruncateResult {
  /** How many rows were removed. */
  removedRows: number;
}

/** One timeline bucket: a time interval and how many rows in it. */
export interface TimelineBucket {
  /** Bucket start (ms, inclusive). */
  start: number;
  /** Bucket end (ms, exclusive; for the last one = period.end). */
  end: number;
  /** How many rows have ts in [start, end). Rows without ts are not counted. */
  count: number;
  /** Whether the bucket has data (count > 0). */
  hasData: boolean;
}

// --------------------------------------------------
// Options and stats
// --------------------------------------------------
/** Strategy for locking a journal by a single owner. */
export type LockMode = 'pid' | 'off';

/** Write-ahead log strategy:
 * - `'off'` (default) — no WAL: rows sit in the in-memory active segment
 *   until flush. Zero extra writes per row (half the SSD wear), but a process
 *   crash loses everything not yet flushed.
 * - `'on'` — every row is WAL-logged (batched) before the segment append;
 *   a process crash replays the WAL on the next open (no row loss). */
export type WalMode = 'on' | 'off';

/** Blob compression: 'zstd' (default on Node ≥ 23.8) or
 *  'gzip' (older Node / explicit choice; if zstd is absent — falls back to gzip). */
export type CompressionMode = 'gzip' | 'zstd';

/** Blob compression kind: 'none' (no compression), 'gzip', 'zstd'. */
export type CompressionKind = 'none' | 'gzip' | 'zstd';

// --------------------------------------------------
// Retention — tiers and engine reporting
// --------------------------------------------------

/** Storage tier: data of a given age is re-encoded according to it. */
export interface RetentionTier {
  /** Tier identifier ('hot'|'warm'|'cold'|'archive' or custom). */
  id: string;
  /** Minimum data age (ms, inclusive). 0 — the freshest. */
  from: number;
  /** Maximum age (ms, exclusive). Infinity — the oldest. */
  to: number;
  /** Numeric codec of the values column ('f64'|'doubleDelta'|'gorilla'|'rle'). */
  codec: string;
  /** Target block size (ms) when merging (1h → 1d). */
  block: number;
  /** Compression: 'none' (raw), 'gzip', 'zstd'. */
  compress: 'none' | 'gzip' | 'zstd';
  /** Minimum ts interval (ms) for downsampling; 0 — no data loss. */
  minInterval: number;
  /** Delta-encode the ts column (doubleDelta). */
  tsDelta: boolean;
}

/** Current encoding of a segment file (from the v3 header). */
export interface SegmentEncoding {
  v3: boolean;
  compression: string;
  /** Numeric codecs: field → codec name. */
  codecs: Record<string, string>;
}

/** Tier status: how many segments/bytes/rows and the ts range. */
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

/** Plan item: what to do with a segment (reencode / merge / nothing). */
export interface ConversionPlan {
  segId: string;
  tier: string;
  action: 'none' | 'reencode' | 'merge';
  targetCodec: string;
  targetCompress: string;
  groupSize: number;
}

/** Retention-apply report: what was re-encoded/merged, before/after. */
export interface ApplyReport {
  reencoded: number;
  merged: number;
  skipped: number;
  beforeSegments: number;
  afterSegments: number;
  beforeBytes: number;
  afterBytes: number;
}

/** Compaction report of one tier (block merging). */
export interface CompactTierReport {
  tier: string;
  mergedGroups: number;
  beforeSegments: number;
  afterSegments: number;
}

// --------------------------------------------------
// Table — multi-tier table (GraphiteMergeTree)
//
// One metric → one table = several resolution tiers (each —
// a separate journal): fresh data at a fine resolution, old data at a
// coarse one (rollup by age + TTL). The size is predictable:
// Σ(resolution × ttl). Reading splits a range by "age" into tier windows
// and stitches the response in chronological order.
// --------------------------------------------------

/** Resolution tier: data is stored at step `resMs` until it "ages" to
 *  `ttlMs` (after which rollup moves it to a coarser tier).
 *  Tiers go from fine (0) to coarse; resolution and ttl are non-decreasing. */
export interface ResolutionTier {
  /** Sampling step on the tier (ms): 5s = 5000, 15s = 15000, 1m = 60000. */
  resMs: number;
  /** How long data lives on the tier (ms): 1d = 86400000. Beyond that — rollup. */
  ttlMs: number;
}

/** Status of one table tier. */
export interface TableTierStat {
  /** Tier index (0 — the finest). */
  tier: number;
  /** Tier resolution (ms). */
  resMs: number;
  /** Tier TTL (ms). */
  ttlMs: number;
  /** Rows on the tier (closed segments + active). */
  rows: number;
  /** Size on disk (closed segments, bytes). */
  bytes: number;
  /** ts range on the tier (null if empty). */
  minTs: number | null;
  maxTs: number | null;
}

/** Rollup report for one invocation. */
export interface RollupReport {
  /** How many tier pairs (fine→coarse) were processed. */
  pairs: number;
  /** How many rows were read from fine tiers and re-encoded into coarse ones. */
  rolledRows: number;
  /** How many rows were removed from fine tiers (purge after the move). */
  purgedRows: number;
}

export interface JournalOptions {
  /** How many rows in one segment file before flush (default 10 000).
   *  Smaller — more files (convenient for tests and exact deduplication);
   *  larger — fewer FS operations and less SSD wear, but a bigger re-encoding
   *  of the "crossing" segment during purge/compact. */
  rowsPerSegment?: number;
  maxCachedSegments?: number;
  /** WAL strategy (default `'off'` — see `WalMode`). `'on'`: rows are
   *  WAL-logged before the segment append and replayed after a process crash;
   *  costs ~1 extra (unflushed) copy of every row. */
  wal?: WalMode;
  /** WAL batch size: how many rows to accumulate in memory before writing to disk.
   *  1 — write every row immediately (maximum crash resistance, slower). */
  walBatchSize?: number;
  /** Locking the journal by a single owner (`.lock` file + owner PID):
   * - `'pid'` (default) — open() throws if the journal is already open by a
   *   live process; a stale lock (dead PID) is taken over.
   * - `'off'` — the library neither creates nor checks `.lock`: owner
   *   coordination is entirely on the application side. Needed, e.g., when the
   *   database lives in worker_threads: a worker may die while the process is
   *   alive, and the PID lock would look "held" forever. */
  lock?: LockMode;
  /** Blob compression (default `'zstd'` on Node ≥ 23.8, otherwise `'gzip'`). */
  compression?: CompressionMode;
  /** Explicit numeric codec choice for a column: field → codec name
   *  ('f64' | 'doubleDelta' | 'gorilla' | 'rle'). Omitted — auto-picked. */
  codecs?: Record<string, string>;
  /** Retention tiers. Default: defaultTiers() — see retention.ts. */
  retention?: RetentionTier[];
  /** Auto-compact (default true): after flush(), automatically merge
   *  closed segments once >= compactMinSegments have accumulated. Idempotent
   *  (compact() requires >= 2 segments), self-limiting. Disable: false. */
  autoCompact?: boolean;
  /** How many closed segments to accumulate before auto-compaction (default 4). */
  compactMinSegments?: number;
}

export interface StoreOptions {
  maxCacheSize?: number;
  defaultRowsPerSegment?: number;
  /** Default `'pid'` — see `JournalOptions.lock`. */
  lock?: LockMode;
  /** Default WAL strategy for all journals (default `'off'` — see `WalMode`). */
  wal?: WalMode;
  /** Blob compression for all journals (default `'zstd'` on Node ≥ 23.8, otherwise `'gzip'`). */
  compression?: CompressionMode;
  /** Default numeric codecs: field → codec name. */
  codecs?: Record<string, string>;
  /** Auto-compact default for all journals (default true).
   *  Overridden by OpenJournalOptions.autoCompact for an individual journal. */
  autoCompact?: boolean;
  /** Threshold of closed segments for auto-compaction (default 4). */
  compactMinSegments?: number;
}

export interface OpenJournalOptions {
  rowsPerSegment?: number;
  maxCachedSegments?: number;
  /** Overrides `lock` from StoreOptions for this journal. */
  lock?: LockMode;
  /** Overrides `wal` from StoreOptions for this journal. */
  wal?: WalMode;
  /** Overrides `compression` from StoreOptions. */
  compression?: CompressionMode;
  /** Overrides `codecs` from StoreOptions. */
  codecs?: Record<string, string>;
  /** Overrides `autoCompact` from StoreOptions. */
  autoCompact?: boolean;
  /** Overrides `compactMinSegments` from StoreOptions. */
  compactMinSegments?: number;
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
