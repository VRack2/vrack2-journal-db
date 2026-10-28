// compaction/define.ts — Table descriptions (define*Table)
//
// A single "language" for declaring tables: one function per engine, each
// with its own parameters (like ClickHouse engines). They return a typed
// description (AnyTableDef) — it can be passed to store.create(def), written
// to the _store.json manifest, or handed to a colleague/an AI agent as a
// self-contained artifact.
//
//   const cpu = defineUpsertTable({
//     name: 'cpu',
//     desc: 'CPU state: the latest version per (host, metric)',
//     columns: { ts: 'delta', host: 'dictionary', metric: 'dictionary', value: 'auto' },
//     key: ['host', 'metric'],
//     version: 'ts',
//   });
//   store.create(cpu);
//
// Validation runs at the define* call — errors are visible at the declaration
// site, not at the first compact().

import type { AggFn, OpenJournalOptions, ResolutionTier, RetentionTier, Schema } from '../core/types.ts';
import { Descriptor } from './Descriptor.ts';
import { Aggregation } from '../metric/Aggregation.ts';
import ErrorManager from '../errors/ErrorManager.ts';

ErrorManager.registerMany('define', [
  { short: 'DEF_NAME_EMPTY', description: 'name must be a non-empty string', rules: { kind: 'string' } },
  { short: 'DEF_NAME_SLASH', description: 'name must not contain "/"', rules: { kind: 'string' } },
  { short: 'DEF_COLUMNS_OBJECT', description: 'columns must be an object "field → column type"', rules: { kind: 'string' } },
  { short: 'DEF_COLUMNS_EMPTY', description: 'columns must be a non-empty schema', rules: { kind: 'string' } },
  { short: 'DEF_RETENTION_AGG', description: 'retention/tiers requires an explicit agg (field → min|max|sum|avg|count)', rules: { kind: 'string' } },
  { short: 'DEF_TIERS_EMPTY', description: 'tiers must be a non-empty array of { resMs, ttlMs }', rules: { kind: 'string' } },
  { short: 'DEF_TIERS_POSITIVE', description: 'tiers resMs/ttlMs must be > 0', rules: { kind: 'string' } },
  { short: 'DEF_TIERS_ORDER', description: 'tiers resMs and ttlMs must not decrease (fine → coarse)', rules: { kind: 'string' } },
  { short: 'DEF_AGG_FIELD', description: 'agg field not found in columns', rules: { kind: 'string', field: 'string' } },
  { short: 'DEF_AGG_FN', description: 'agg fn must be min|max|sum|avg|count', rules: { kind: 'string', field: 'string', fn: 'string' } },
  { short: 'DEF_DIMS_EMPTY', description: 'dims must be a non-empty array of fields', rules: { kind: 'string' } },
  { short: 'DEF_DIMS_FIELD', description: 'dims field not found in columns', rules: { kind: 'string', field: 'string' } },
  { short: 'DEF_STORAGE_TIERS', description: 'storage.tiers must be objects { id, from, to, … }', rules: { kind: 'string' } },
  { short: 'DEF_KEY_EMPTY', description: 'key must be a non-empty array of identity-key fields', rules: { kind: 'string' } },
  { short: 'DEF_KEY_FIELD', description: 'key field not found in columns', rules: { kind: 'string', field: 'string' } },
  { short: 'DEF_COLUMN_NAME', description: 'a non-empty column name is required', rules: { kind: 'string' } },
  { short: 'DEF_COLUMN_NOT_FOUND', description: 'column not found in columns', rules: { kind: 'string', field: 'string' } },
  { short: 'DEF_SUMMING_SUM', description: 'summing: sum must be a non-empty array of numeric columns', rules: { kind: 'string' } },
  { short: 'DEF_CLUSTER_EMPTY', description: 'cluster must be a non-empty array of dimension fields', rules: { kind: 'string' } },
  { short: 'DEF_CLUSTER_FIELD', description: 'cluster field not found in columns', rules: { kind: 'string', field: 'string' } },
  { short: 'DEF_CLUSTER_TS', description: 'cluster must not contain ts (ts is the secondary sort)', rules: { kind: 'string' } },
  { short: 'DEF_CLUSTER_DUP', description: 'cluster fields must be unique', rules: { kind: 'string', field: 'string' } },
]);

// --------------------------------------------------
// Base + specific descriptions (discriminated union by kind)
// --------------------------------------------------

/** Storage tiers (lossless re-encode): codec/compression by data age. */
export interface StorageConfig {
  /** Tiers (default: RetentionEngine.defaultTiers()). */
  tiers?: RetentionTier[];
}

interface BaseTableDef {
  /** Table name (and directory name in the store). */
  name: string;
  /** Human- and AI-readable purpose: what the table is for and what it stores. */
  desc?: string;
  /** Schema: field → column type. */
  columns: Schema;

  // --- age-based merging rule (tiers/rollup), optional ------------
  /** Retention policy 'res:ttl,res:ttl' (resolution tiers).
   *  Set → the table has retention: a single 'res:ttl' pair is pure TTL
   *  (no rollup, agg optional); two or more tiers roll up and require `agg`. */
  retention?: string;
  /** Explicit tier array (fine to coarse). Takes precedence over `retention`.
   *  One tier — TTL only; two or more — rollup, requires an explicit `agg`. */
  tiers?: ResolutionTier[];
  /** Rollup aggregation: field → fn (min|max|sum|avg|count). Required with `retention`. */
  agg?: Record<string, AggFn>;
  /** Rollup dimension fields (group-by). Default: the engine key (without ts) or schema − ts − agg. */
  dims?: string[];
  /** Cluster key for compaction: dimension fields a compacted segment is sorted
   *  by (then ts ↑). Set → compact clusters segments physically (ClickHouse
   *  ORDER BY semantics); scans of these tables can skip whole segments by dims. */
  cluster?: string[];

  // --- storage (lossless re-encode), optional -------------------------
  /** Storage tiers (codec/compression by age, lossless). Disabled by default. */
  storage?: StorageConfig;

  // --- maintenance --------------------------------------------------------
  /** Auto-rollup on append (default true; multi-tier tables only). */
  autoRollup?: boolean;
  /** Auto-purge on append (default true). */
  autoPurge?: boolean;
  /** Throttling of auto-maintenance (ms, default 600 000; 0 — every append). */
  maintenanceMinIntervalMs?: number;
  /** "Current time" provider (tests). Default: Date.now. */
  nowProvider?: () => number;

  // --- physical (journal) --------------------------------------------------
  /** Rows per segment. */
  rowsPerSegment?: number;
  /** Physical journal options (lock, format, compression, codecs, walBatchSize, …). */
  opts?: OpenJournalOptions;
}

/** log — merging without changing rows. */
export interface LogTableDef extends BaseTableDef {
  kind: 'log';
}

/** upsert — keep the row with max(version) per key. */
export interface UpsertTableDef extends BaseTableDef {
  kind: 'upsert';
  key: string[];
  version: string;
}

/** summing — sum numeric columns `sum` per key. */
export interface SummingTableDef extends BaseTableDef {
  kind: 'summing';
  key: string[];
  sum: string[];
  version?: string;
}

/** collapsing — cancel out +1/-1 pairs in column `sign` per key. */
export interface CollapsingTableDef extends BaseTableDef {
  kind: 'collapsing';
  key: string[];
  sign: string;
  version?: string;
}

/** Any table description — what store.create() accepts and writes to the manifest. */
export type AnyTableDef = LogTableDef | UpsertTableDef | SummingTableDef | CollapsingTableDef;

/** Table runtime stats (from the journal directory on disk). */
export interface TableRuntime {
  /** Logical rows in closed segments (excluding the active one). */
  rows: number;
  /** Number of segment files. */
  segments: number;
  /** Segment size on disk, bytes. */
  sizeBytes: number;
}

/** Result of store.describe(): table description + runtime stats. */
export type TableDescription = AnyTableDef & TableRuntime;

// --------------------------------------------------
// Validation (basic rules)
// --------------------------------------------------

/**
 * Validate a cluster key against the table columns (shared by define*Table
 * and Table.setCluster): non-empty string array, fields exist, no ts, unique.
 * Returns a normalized copy.
 */
export function validateClusterFields(columns: Schema, cluster: unknown, kind: string): string[] {
  if (!Array.isArray(cluster) || cluster.length === 0) {
    throw ErrorManager.make('DEF_CLUSTER_EMPTY', { kind });
  }
  const seen = new Set<string>();
  for (const f of cluster) {
    if (typeof f !== 'string' || f.length === 0 || !(f in columns)) {
      throw ErrorManager.make('DEF_CLUSTER_FIELD', { kind, field: String(f) });
    }
    if (f === 'ts') throw ErrorManager.make('DEF_CLUSTER_TS', { kind });
    if (seen.has(f)) throw ErrorManager.make('DEF_CLUSTER_DUP', { kind, field: f });
    seen.add(f);
  }
  return cluster.slice();
}

function validateBase(cfg: BaseTableDef, kind: string): void {
  if (typeof cfg.name !== 'string' || cfg.name.trim().length === 0) {
    throw ErrorManager.make('DEF_NAME_EMPTY', { kind });
  }
  if (cfg.name.includes('/')) {
    throw ErrorManager.make('DEF_NAME_SLASH', { kind });
  }
  if (!cfg.columns || typeof cfg.columns !== 'object') {
    throw ErrorManager.make('DEF_COLUMNS_OBJECT', { kind });
  }
  if (Object.keys(cfg.columns).length === 0) {
    throw ErrorManager.make('DEF_COLUMNS_EMPTY', { kind });
  }
  // --- retention/agg/dims --------------------------------------------------
  // A single-tier retention ('res:ttl') is pure TTL: no rollup pair to merge
  // into a coarser tier, so no agg is required. Two or more tiers require agg.
  if (cfg.retention !== undefined || cfg.tiers !== undefined) {
    const tierCount = cfg.tiers !== undefined
      ? (Array.isArray(cfg.tiers) ? cfg.tiers.length : 0)
      : String(cfg.retention).split(',').length;
    if (tierCount > 1 && (!cfg.agg || Object.keys(cfg.agg).length === 0)) {
      throw ErrorManager.make('DEF_RETENTION_AGG', { kind });
    }
  }
  if (cfg.tiers !== undefined) {
    if (!Array.isArray(cfg.tiers) || cfg.tiers.length === 0) {
      throw ErrorManager.make('DEF_TIERS_EMPTY', { kind });
    }
    for (const t of cfg.tiers) {
      if (!t || !Number.isFinite(t.resMs) || t.resMs <= 0 || !Number.isFinite(t.ttlMs) || t.ttlMs <= 0) {
        throw ErrorManager.make('DEF_TIERS_POSITIVE', { kind });
      }
    }
    for (let i = 1; i < cfg.tiers.length; i++) {
      if (cfg.tiers[i].resMs < cfg.tiers[i - 1].resMs || cfg.tiers[i].ttlMs < cfg.tiers[i - 1].ttlMs) {
        throw ErrorManager.make('DEF_TIERS_ORDER', { kind });
      }
    }
  }
  if (cfg.agg) {
    for (const [f, fn] of Object.entries(cfg.agg)) {
      if (!(f in cfg.columns)) {
        throw ErrorManager.make('DEF_AGG_FIELD', { kind, field: f });
      }
      if (!Aggregation.isAggFn(fn)) {
        throw ErrorManager.make('DEF_AGG_FN', { kind, field: f, fn: String(fn) });
      }
    }
  }
  if (cfg.dims) {
    if (!Array.isArray(cfg.dims) || cfg.dims.length === 0) {
      throw ErrorManager.make('DEF_DIMS_EMPTY', { kind });
    }
    for (const f of cfg.dims) {
      if (typeof f !== 'string' || !(f in cfg.columns)) {
        throw ErrorManager.make('DEF_DIMS_FIELD', { kind, field: String(f) });
      }
    }
  }
  if (cfg.storage && cfg.storage.tiers) {
    for (const t of cfg.storage.tiers) {
      if (!t || typeof t.id !== 'string' || !Number.isFinite(t.from) || !Number.isFinite(t.to)) {
        throw ErrorManager.make('DEF_STORAGE_TIERS', { kind });
      }
    }
  }
  if (cfg.cluster !== undefined) {
    cfg.cluster = validateClusterFields(cfg.columns, cfg.cluster, kind);
  }
}

function validateKey(cfg: BaseTableDef & { key: unknown }, kind: string): void {
  if (!Array.isArray(cfg.key) || cfg.key.length === 0) {
    throw ErrorManager.make('DEF_KEY_EMPTY', { kind });
  }
  for (const f of cfg.key) {
    if (typeof f !== 'string' || !(f in cfg.columns)) {
      throw ErrorManager.make('DEF_KEY_FIELD', { kind, field: String(f) });
    }
  }
}

function requireColumn(cfg: BaseTableDef, field: unknown, kind: string): string {
  if (typeof field !== 'string' || field.length === 0) {
    throw ErrorManager.make('DEF_COLUMN_NAME', { kind });
  }
  if (!(field in cfg.columns)) {
    throw ErrorManager.make('DEF_COLUMN_NOT_FOUND', { kind, field });
  }
  return field;
}

// --------------------------------------------------
// define* — one function per engine
// --------------------------------------------------

/** log (MergeTree): merging without changing rows. */
export function defineLogTable(cfg: Omit<LogTableDef, 'kind'>): LogTableDef {
  validateBase(cfg, 'log');
  return { ...cfg, kind: 'log' };
}

/** upsert (ReplacingMergeTree): keep the row with max(version) per key. */
export function defineUpsertTable(cfg: Omit<UpsertTableDef, 'kind'>): UpsertTableDef {
  validateBase(cfg, 'upsert');
  validateKey(cfg, 'upsert');
  const version = requireColumn(cfg, cfg.version, 'upsert');
  return { ...cfg, kind: 'upsert', version };
}

/** summing (SummingMergeTree): sum numeric columns `sum` per key. */
export function defineSummingTable(cfg: Omit<SummingTableDef, 'kind'>): SummingTableDef {
  validateBase(cfg, 'summing');
  validateKey(cfg, 'summing');
  if (!Array.isArray(cfg.sum) || cfg.sum.length === 0) {
    throw ErrorManager.make('DEF_SUMMING_SUM', { kind: 'summing' });
  }
  const sum = cfg.sum.map(s => requireColumn(cfg, s, 'summing'));
  const version = cfg.version != null ? requireColumn(cfg, cfg.version, 'summing') : undefined;
  return { ...cfg, kind: 'summing', sum, version };
}

/** collapsing (CollapsingMergeTree): cancel out +1/-1 pairs in column `sign` per key. */
export function defineCollapsingTable(cfg: Omit<CollapsingTableDef, 'kind'>): CollapsingTableDef {
  validateBase(cfg, 'collapsing');
  validateKey(cfg, 'collapsing');
  const sign = requireColumn(cfg, cfg.sign, 'collapsing');
  const version = cfg.version != null ? requireColumn(cfg, cfg.version, 'collapsing') : undefined;
  return { ...cfg, kind: 'collapsing', sign, version };
}

// --------------------------------------------------
// Description → engine descriptor (for metadata/compact)
// --------------------------------------------------

/** Extracts the engine descriptor from a table description (what compact() needs). */
export function engineDescriptorOf(def: AnyTableDef): Descriptor {
  switch (def.kind) {
    case 'log':
      return new Descriptor({ kind: 'log' });
    case 'upsert':
      return new Descriptor({ kind: 'upsert', key: def.key, version: def.version });
    case 'summing':
      return new Descriptor({ kind: 'summing', key: def.key, sum: def.sum, version: def.version });
    case 'collapsing':
      return new Descriptor({ kind: 'collapsing', key: def.key, sign: def.sign, version: def.version });
  }
}
