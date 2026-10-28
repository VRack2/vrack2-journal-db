// Table.ts — one table class for time series.
//
// No retention — one journal <name>. With retention — journals <name>/r<res>
// (resolution tiers): rollup moves aged-out data to coarser tiers, TTL purges.
//
// Compaction engine from def.kind: 'log' | 'upsert' | 'summing' | 'collapsing'.
//
//   const t = store.open('cpu', {
//     columns: { ts: 'delta', value: 'auto', host: 'dictionary' },
//     retention: '5s:1d,15s:1w,1m:1mon',
//     agg: { value: 'avg' },
//   });
//   t.append({ ts: now, value: 42.3, host: 'web-1' });
//   t.query('now-30d', 'now');
//   t.rollup();
//
// Tier rules live in TableDef; rollup in RollupManager; tier reads in
// TieredQuery; append-time throttled upkeep in Maintenance. Table is the
// facade that wires them over one or more journals.

import path from 'node:path';
import { Interval } from '../core/Interval.ts';
import { Journal } from '../journal/Journal.ts';
import { Percentile } from '../core/Percentile.ts';
import { Rollup } from '../metric/Rollup.ts';
import type { RollupConfig } from '../metric/Rollup.ts';
import type {
  AggFn,
  AggregateExpr,
  CompactResult,
  Metadata,
  OpenJournalOptions,
  PurgeResult,
  ResolutionTier,
  Row,
  RollupReport,
  Schema,
  ScanOptions,
  TableTierStat,
  TimelineBucket,
  TruncateResult,
} from '../core/types.ts';
import type { AnyTableDef } from '../compaction/define.ts';
import { Descriptor, ENGINE_META_KEY } from '../compaction/Descriptor.ts';
import { RetentionEngine } from '../journal/RetentionEngine.ts';
import type { ApplyReport, ConversionPlan, TierStatus } from '../core/types.ts';
import ErrorManager from '../errors/ErrorManager.ts';
import { Aggregation } from '../metric/Aggregation.ts';
import { isScanOp } from '../journal/scan/plan.ts';
import { TableDef } from './TableDef.ts';
import { RollupManager } from './RollupManager.ts';
import { Maintenance, DEFAULT_MAINTENANCE_INTERVAL_MS } from './Maintenance.ts';
import { TieredQuery } from './TieredQuery.ts';

export type { RollupOneReport } from './RollupManager.ts';

ErrorManager.registerMany('Table', [
  { short: 'TBL_SCAN_AGG', description: 'Table: scan — agg/groupBy in tier mode: use aggregate()' },
  { short: 'TBL_WHERE_OP', description: 'where — unknown operator', rules: { op: 'string' } },
  { short: 'TBL_NAME_EMPTY', description: 'Table: name — non-empty string' },
  { short: 'TBL_NAME_SLASH', description: 'Table: name must not contain "/" (tiers are created as <name>/r<res>)' },
  { short: 'TBL_DEF_REQUIRED', description: 'Table: def is required ({ columns: { … } })' },
  { short: 'TBL_NAME_MISMATCH', description: 'Table: name does not match def.name', rules: { name: 'string', defName: 'string' } },
  { short: 'TBL_COLUMNS_EMPTY', description: 'Table: def.columns — non-empty schema { field: type }' },
  { short: 'TBL_KEY_EMPTY', description: 'Table: def.key: non-empty array of key fields', rules: { kind: 'string' } },
  { short: 'TBL_KEY_NOT_IN_SCHEMA', description: 'Table: key not in schema', rules: { kind: 'string', field: 'string' } },
  { short: 'TBL_AGG_FIELD', description: 'Table: agg — field not found in columns', rules: { field: 'string' } },
  { short: 'TBL_AGG_FN', description: 'Table: agg — fn min|max|sum|avg|count', rules: { field: 'string', fn: 'string' } },
  { short: 'TBL_DIMS_FIELD', description: 'Table: dims — field not found in columns', rules: { field: 'string' } },
  { short: 'TBL_MAINT_MIN_INTERVAL', description: 'Table: maintenanceMinIntervalMs — a number >= 0' },
  { short: 'TBL_AGG_NEED_FIELDS', description: 'Table: non-ts fields are required for aggregation', rules: { kind: 'string' } },
  { short: 'TBL_ROLLUP_NEED_FIELDS', description: 'Table: schema must contain at least one non-ts column for rollup' },
  { short: 'TBL_JOURNAL_INDEX', description: 'Table: no journal', rules: { index: 'number' } },
  { short: 'TBL_NOT_OPEN', description: 'Table: not open (close() was called)' },
  { short: 'TBL_TAIL_COUNT', description: 'Table: tail — count >= 0' },
  { short: 'TBL_TL_INTERVAL', description: 'Table: timeline — interval: a number in ms > 0 or a string like "15m"' },
  { short: 'TBL_AGG_EXPRS', description: 'Table: aggregate() — exprs: non-empty array { field, fn }' },
  { short: 'TBL_AGG_FIELD_EMPTY', description: 'Table: aggregate() — expr.field: non-empty field name' },
  { short: 'TBL_AGG_EXPR_FN', description: 'Table: aggregate() — expr.fn: min|max|sum|avg|count', rules: { fn: 'string' } },
  { short: 'TBL_PCTL_LEVEL', description: 'Table: percentile() — level: a number in (0, 1)', rules: { level: 'string' } },
  { short: 'TBL_NO_STORAGE', description: 'Table: def.storage is not set (no storage retention tiers)' },
]);

// Minimal structural storage interface — avoids a circular import with Store.
export interface TableStore {
  readonly baseDir: string;
  openJournals: Map<string, Journal>;
  _openJournal(
    name: string,
    schema: Schema,
    metadata?: Metadata,
    opts?: OpenJournalOptions,
  ): Journal;
  _closeJournal(name: string): void;
}

/** Parses a retention string '5s:1d,15s:1w' into tiers (fine → coarse). */
export const parseRetention = TableDef.parseRetention;

export class Table {
  readonly name: string;
  readonly store: TableStore;
  readonly def: AnyTableDef;
  readonly schema: Schema;
  readonly kind: 'log' | 'upsert' | 'summing' | 'collapsing';
  /** null — single journal, no retention. */
  readonly tiers: ResolutionTier[] | null;
  readonly agg: Record<string, AggFn>;
  readonly dims: string[];

  private readonly nowProvider: () => number;
  private readonly journalNames: string[];
  private readonly journals: Journal[];
  private readonly rollupManager: RollupManager;
  /** null — single journal, no retention. */
  private readonly tiered: TieredQuery | null;
  /** null — single journal, no retention. */
  private readonly maintenance: Maintenance | null;
  private readonly engines: RetentionEngine[];

  readonly autoRollup: boolean;
  readonly autoPurge: boolean;
  readonly maintenanceMinIntervalMs: number;

  constructor(store: TableStore, name: string, def: AnyTableDef) {
    if (typeof name !== 'string' || name.length === 0) {
      throw ErrorManager.make('TBL_NAME_EMPTY');
    }
    if (name.includes('/')) {
      throw ErrorManager.make('TBL_NAME_SLASH');
    }
    if (!def || typeof def !== 'object') {
      throw ErrorManager.make('TBL_DEF_REQUIRED');
    }
    if (def.name !== undefined && def.name !== name) {
      throw ErrorManager.make('TBL_NAME_MISMATCH', { name, defName: String(def.name) });
    }
    const columns = def.columns;
    if (!columns || typeof columns !== 'object' || Object.keys(columns).length === 0) {
      throw ErrorManager.make('TBL_COLUMNS_EMPTY');
    }
    this.store = store;
    this.name = name;
    this.def = def;

    const schema: Schema = { ...columns };
    if (!schema['ts']) schema['ts'] = 'delta';
    this.schema = schema;

    this.kind = def.kind ?? 'log';
    if (this.kind !== 'log') {
      const key = (def as { key?: string[] }).key;
      if (!Array.isArray(key) || key.length === 0 || key.some(f => typeof f !== 'string' || f.length === 0)) {
        throw ErrorManager.make('TBL_KEY_EMPTY', { kind: this.kind });
      }
      for (const f of key) {
        if (!(f in schema)) throw ErrorManager.make('TBL_KEY_NOT_IN_SCHEMA', { kind: this.kind, field: f });
      }
    }

    let agg = def.agg;
    if (!agg || Object.keys(agg).length === 0) {
      agg = Table._defaultAgg(this.kind, schema, def);
    }
    for (const [f, fn] of Object.entries(agg)) {
      if (!(f in schema)) throw ErrorManager.make('TBL_AGG_FIELD', { field: f });
      if (!Aggregation.isAggFn(fn)) {
        throw ErrorManager.make('TBL_AGG_FN', { field: f, fn: String(fn) });
      }
    }
    this.agg = agg;

    if (def.dims && def.dims.length > 0) {
      for (const f of def.dims) {
        if (!(f in schema)) throw ErrorManager.make('TBL_DIMS_FIELD', { field: f });
      }
      this.dims = def.dims.slice();
    } else {
      this.dims = Object.keys(schema).filter(f => f !== 'ts' && !(f in agg));
    }

    this.tiers = def.tiers && def.tiers.length > 0
      ? (() => { TableDef.validateTiers(def.tiers!); return def.tiers!.slice(); })()
      : def.retention
        ? TableDef.parseRetention(def.retention)
        : null;

    this.nowProvider = def.nowProvider ?? Date.now;

    this.autoRollup = def.autoRollup ?? true;
    this.autoPurge = def.autoPurge ?? true;
    const minInterval = def.maintenanceMinIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    if (minInterval < 0 || !Number.isFinite(minInterval)) {
      throw ErrorManager.make('TBL_MAINT_MIN_INTERVAL');
    }
    this.maintenanceMinIntervalMs = minInterval;

    let descriptor: Descriptor | null = null;
    if (this.kind !== 'log') {
      const d = def as {
        key: string[];
        version?: string;
        sum?: string[];
        sign?: string;
      };
      const baseKey = d.key.filter(f => f !== 'ts');
      // Tier mode: time is part of the key — compact must not collapse different buckets.
      const key = this.tiers ? ['ts', ...baseKey] : d.key;
      descriptor = new Descriptor({
        kind: this.kind,
        key,
        version: d.version,
        sum: d.sum,
        sign: d.sign,
      });
    }

    const opts: OpenJournalOptions = {};
    if (def.rowsPerSegment !== undefined) opts.rowsPerSegment = def.rowsPerSegment;
    Object.assign(opts, def.opts ?? {});
    // Rollup rows may carry null — agg fields in tier mode are written as 'auto'.
    const tierSchema = this.tiers ? Table._tierSchema(schema, this.agg) : schema;

    let cpPath = '';
    if (this.tiers) {
      this.journalNames = this.tiers.map(t => `${name}/r${t.resMs}`);
      this.journals = this.tiers.map((t, i) =>
        store._openJournal(
          this.journalNames[i],
          tierSchema,
          {
            table: name,
            tier: i,
            resMs: t.resMs,
            ttlMs: t.ttlMs,
            formatVersion: 3,
            ...(descriptor ? { [ENGINE_META_KEY]: descriptor.toMeta() } : {}),
          },
          opts,
        ),
      );
      cpPath = path.join(store.baseDir, 'journals', name, '_rollup.json');
    } else {
      this.journalNames = [name];
      this.journals = [
        store._openJournal(
          name,
          schema,
          { formatVersion: 3, ...(descriptor ? { [ENGINE_META_KEY]: descriptor.toMeta() } : {}) },
          opts,
        ),
      ];
    }

    this.rollupManager = new RollupManager({
      journals: this.journals,
      tiers: this.tiers,
      agg: this.agg,
      dims: this.dims,
      cpPath,
      nowProvider: this.nowProvider,
    });
    this.tiered = this.tiers ? new TieredQuery(this.journals, this.tiers) : null;
    this.maintenance = this.tiers
      ? new Maintenance({
        name: this.name,
        journals: this.journals,
        tiers: this.tiers,
        autoRollup: this.autoRollup,
        autoPurge: this.autoPurge,
        minIntervalMs: this.maintenanceMinIntervalMs,
        nowProvider: this.nowProvider,
        rollup: (now: number) => { this.rollupManager.rollup(now); },
      })
      : null;

    this.engines = def.storage
      ? this.journals.map(j => new RetentionEngine(j.store, () => j.journalPath(), def.storage?.tiers))
      : [];
  }

  private static _tierSchema(schema: Schema, agg: Record<string, AggFn>): Schema {
    const out = { ...schema };
    for (const f of Object.keys(agg)) out[f] = 'auto';
    return out;
  }

  private static _defaultAgg(
    kind: string,
    schema: Schema,
    def: AnyTableDef,
  ): Record<string, AggFn> {
    if (kind === 'summing' || kind === 'collapsing') {
      const d = def as { sum?: string[]; sign?: string };
      const out: Record<string, AggFn> = {};
      if (typeof d.sign === 'string' && d.sign.length > 0) out[d.sign] = 'sum';
      if (Array.isArray(d.sum)) {
        for (const f of d.sum) out[f] = 'sum';
      }
      if (Object.keys(out).length > 0) return out;
      const first = Object.keys(schema).find(f => f !== 'ts');
      if (first) return { [first]: 'sum' };
      throw ErrorManager.make('TBL_AGG_NEED_FIELDS', { kind });
    }
    const first = Object.keys(schema).find(f => f !== 'ts');
    if (!first) {
      throw ErrorManager.make('TBL_ROLLUP_NEED_FIELDS');
    }
    return { [first]: 'avg' };
  }

  static validateTiers(tiers: ResolutionTier[]): void {
    TableDef.validateTiers(tiers);
  }

  now(): number {
    return this.nowProvider();
  }

  get isOpen(): boolean {
    return this.journals.every(j => j.isOpen);
  }

  /** Journal name of a tier (debug helper). */
  journalName(i: number): string {
    if (i < 0 || i >= this.journals.length) throw ErrorManager.make('TBL_JOURNAL_INDEX', { index: i });
    return this.journalNames[i];
  }

  journal(i: number): Journal {
    if (i < 0 || i >= this.journals.length) throw ErrorManager.make('TBL_JOURNAL_INDEX', { index: i });
    return this.journals[i];
  }

  append(row: Row): void {
    this._assertOpen();
    this.journals[0].append(row);
    if (this.maintenance) this.maintenance.maybeMaintain();
  }

  flush(): void {
    this._assertOpen();
    for (const j of this.journals) j.flush();
  }

  close(): void {
    for (const n of this.journalNames) {
      if (this.store.openJournals.has(n)) this.store._closeJournal(n);
    }
  }

  private _assertOpen(): void {
    if (!this.isOpen) throw ErrorManager.make('TBL_NOT_OPEN');
  }

  /**
   * Read [start, end] (inclusive), by ts ↑.
   * Tier mode: split the range by age into per-tier windows; the finest tier is
   * the source over the whole range (moved data is already purged from it — no dups).
   */
  query(start: number | string, end: number | string): Row[] {
    this._assertOpen();
    const [startTs, endTs] = Interval.period(start, end, this.now());

    if (!this.tiered) {
      return this.journals[0].scan({ start: startTs, end: endTs });
    }
    return this.tiered.query(startTs, endTs, this.now());
  }

  allRows(): Row[] {
    this._assertOpen();
    if (!this.tiered) return this.journals[0].allRows();
    const rows = this.query(0, this.now());
    rows.sort(TieredQuery.tsCmp);
    return rows;
  }

  tail(count: number): Row[] {
    this._assertOpen();
    if (count < 0) throw ErrorManager.make('TBL_TAIL_COUNT');
    if (!this.tiered) return this.journals[0].tail(count);
    return this.allRows().slice(-count);
  }

  scan(opts: ScanOptions): Row[] {
    this._assertOpen();
    if (!this.tiered) return this.journals[0].scan(opts);

    const now = this.now();
    const [start, end] = Interval.period(opts.start ?? 0, opts.end ?? now, now);
    if (opts.agg || opts.groupBy) {
      throw ErrorManager.make('TBL_SCAN_AGG');
    }
    // where/select/limit pushed down to each tier journal, tiers merged by ts.
    // The journal applies `where` before projection, so no Table-level re-filter
    // (it would drop rows whose where-field is not in select). Validate ops here
    // to keep the tiered-mode error contract (TBL_WHERE_OP) unchanged.
    if (opts.where && opts.where.length > 0) {
      for (const w of opts.where) {
        if (!isScanOp(w.op)) throw ErrorManager.make('TBL_WHERE_OP', { op: String(w.op) });
      }
    }
    let rows = this.tiered.scan(start, end, now, opts);
    // Sort before offset/limit — same order of operations as Journal.scan.
    if (opts.order === 'desc') {
      rows.sort((a, b) => TieredQuery.tsCmp(b, a));
    }
    return Table._applyScanOptions(rows, opts);
  }

  private static _applyScanOptions(rows: Row[], opts: ScanOptions): Row[] {
    let out = rows;
    const select = opts.select;
    if (select && select.length > 0) {
      out = out.map(r => {
        const o: Row = {};
        for (const f of select) o[f] = r[f] ?? null;
        return o;
      });
    }
    if (opts.offset) out = out.slice(opts.offset);
    if (opts.limit !== undefined && opts.limit >= 0) out = out.slice(0, opts.limit);
    return out;
  }

  /** Dense buckets [start, end] (one per interval) with row counters. */
  timeline(
    interval: number | string,
    start: number | string,
    end: number | string,
  ): TimelineBucket[] {
    this._assertOpen();
    const int = typeof interval === 'number' ? interval : Interval.parseInterval(interval);
    if (!Number.isFinite(int) || int <= 0) {
      throw ErrorManager.make('TBL_TL_INTERVAL');
    }
    const [startTs, endTs] = Interval.period(start, end, this.now());

    if (!this.tiered) {
      return this.journals[0].timeline(int, [startTs, endTs]);
    }
    return this.tiered.timeline(int, startTs, endTs, this.now());
  }

  aggregate(
    start: number | string,
    end: number | string,
    exprs: AggregateExpr[],
  ): Record<string, number | null> {
    if (!Array.isArray(exprs) || exprs.length === 0) {
      throw ErrorManager.make('TBL_AGG_EXPRS');
    }
    for (const e of exprs) {
      if (!e || typeof e.field !== 'string' || e.field.length === 0) {
        throw ErrorManager.make('TBL_AGG_FIELD_EMPTY');
      }
      if (!Aggregation.isAggFn(e.fn)) {
        throw ErrorManager.make('TBL_AGG_EXPR_FN', { fn: String(e.fn) });
      }
    }
    const rows = this.query(start, end);
    const fields = [...new Set(exprs.map(e => e.field))];
    const values: Record<string, number[]> = {};
    for (const f of fields) values[f] = [];
    for (const r of rows) {
      for (const f of fields) {
        const v = r[f];
        if (typeof v === 'number' && Number.isFinite(v)) values[f].push(v);
      }
    }
    const out: Record<string, number | null> = {};
    for (const e of exprs) {
      out[`${e.field}_${e.fn}`] =
        values[e.field].length === 0
          ? e.fn === 'count' ? 0 : null
          : Rollup.applyAgg(e.fn, values[e.field]);
    }
    return out;
  }

  /** Percentiles of `value` in [start, end] (linear interpolation). */
  percentile(
    start: number | string,
    end: number | string,
    levels: number | number[],
  ): Record<string, number | null> {
    const lv = Array.isArray(levels) ? levels.slice() : [levels];
    for (const q of lv) {
      if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0 || q >= 1) {
        throw ErrorManager.make('TBL_PCTL_LEVEL', { level: String(q) });
      }
    }
    const rows = this.query(start, end);
    const vals: number[] = [];
    for (const r of rows) {
      const v = r.value;
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const out: Record<string, number | null> = {};
    for (const q of lv) {
      out[Percentile.key(q)] = vals.length === 0 ? null : Percentile.of(vals, q);
    }
    return out;
  }

  rollup(now?: number): RollupReport {
    this._assertOpen();
    return this.rollupManager.rollup(now);
  }

  /** Rollup into one target tier (by resolution res). Tier mode only. */
  rollupOne(cfgOrNow: RollupConfig | number, now?: number) {
    this._assertOpen();
    return this.rollupManager.rollupOne(cfgOrNow, now);
  }

  /** Delete rows up to the bound (inclusive) from all journals. */
  purge(until: number | string): PurgeResult {
    this._assertOpen();
    let removedRows = 0;
    let removedSegments = 0;
    let rewrittenSegments = 0;
    for (const j of this.journals) {
      const r = j.purge(until);
      removedRows += r.removedRows;
      removedSegments += r.removedSegments;
      rewrittenSegments += r.rewrittenSegments;
    }
    return { removedRows, removedSegments, rewrittenSegments };
  }

  /** Clears the table completely (all tiers). Unlike purge, also removes rows without ts. */
  truncate(): TruncateResult {
    this._assertOpen();
    let removedRows = 0;
    for (const j of this.journals) removedRows += j.stats().totalRows;

    for (const j of this.journals) j.clear();

    // Reset rollup checkpoints — otherwise new rows with ts below the previous max would be skipped.
    this.rollupManager.reset();

    return { removedRows };
  }

  compact(): CompactResult {
    this._assertOpen();
    let mergedSegments = 0;
    let logicalRows = 0;
    let physicalBefore = 0;
    let physicalAfter = 0;
    let collapsedRows = 0;
    for (const j of this.journals) {
      const r = j.compact();
      mergedSegments += r.mergedSegments;
      logicalRows += r.logicalRows;
      physicalBefore += r.physicalBefore;
      physicalAfter += r.physicalAfter;
      collapsedRows += r.collapsedRows;
    }
    return { mergedSegments, logicalRows, physicalBefore, physicalAfter, collapsedRows };
  }

  static applyAgg(fn: AggFn, vals: number[]): number {
    return Rollup.applyAgg(fn, vals);
  }

  get hasStorage(): boolean {
    return this.engines.length > 0;
  }

  storageStatus(now?: number): TierStatus[] {
    this._assertOpen();
    if (!this.hasStorage) throw ErrorManager.make('TBL_NO_STORAGE');
    return this.engines[0].status(now);
  }

  storagePlan(now?: number): ConversionPlan[] {
    this._assertOpen();
    if (!this.hasStorage) throw ErrorManager.make('TBL_NO_STORAGE');
    let out: ConversionPlan[] = [];
    for (const e of this.engines) out = out.concat(e.plan(now));
    return out;
  }

  storageApply(now?: number): ApplyReport {
    this._assertOpen();
    if (!this.hasStorage) throw ErrorManager.make('TBL_NO_STORAGE');
    let reencoded = 0;
    let merged = 0;
    let skipped = 0;
    let beforeSegments = 0;
    let afterSegments = 0;
    let beforeBytes = 0;
    let afterBytes = 0;
    for (const e of this.engines) {
      const r = e.apply(now);
      reencoded += r.reencoded;
      merged += r.merged;
      skipped += r.skipped;
      if (beforeSegments === 0) beforeSegments = r.beforeSegments;
      afterSegments = r.afterSegments;
      if (beforeBytes === 0) beforeBytes = r.beforeBytes;
      afterBytes = r.afterBytes;
    }
    return { reencoded, merged, skipped, beforeSegments, afterSegments, beforeBytes, afterBytes };
  }

  storageCompactTier(tierId: string, now?: number) {
    this._assertOpen();
    if (!this.hasStorage) throw ErrorManager.make('TBL_NO_STORAGE');
    let mergedGroups = 0;
    let beforeSegments = 0;
    let afterSegments = 0;
    for (const e of this.engines) {
      const r = e.compactTier(tierId, now);
      mergedGroups += r.mergedGroups;
      if (beforeSegments === 0) beforeSegments = r.beforeSegments;
      afterSegments = r.afterSegments;
    }
    return { mergedGroups, beforeSegments, afterSegments };
  }

  stats(): TableTierStat[] {
    this._assertOpen();
    return this.journals.map((j, i) => {
      const st = j.stats();
      // st.timeRange already spans all segments (meta-based, no file loads);
      // the per-segment loop is only needed for the byte total.
      let bytes = 0;
      for (const id of j.closedSegmentIds()) {
        bytes += j.closedSegmentInfo(id)?.bytes ?? 0;
      }
      const minTs = st.timeRange ? st.timeRange[0] : null;
      const maxTs = st.timeRange ? st.timeRange[1] : null;
      const t = this.tiers ? this.tiers[i] : null;
      return {
        tier: i,
        resMs: t ? t.resMs : 0,
        ttlMs: t ? t.ttlMs : 0,
        rows: st.totalRows,
        bytes,
        minTs,
        maxTs,
      };
    });
  }
}
