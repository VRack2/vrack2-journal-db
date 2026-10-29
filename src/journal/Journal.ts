/*
 * Journal — append-only event log. Closed segments load lazily from disk and
 * are LRU-cached; the active segment lives in memory until flush.
 * Durability: WAL (batched, drained on flush/close/exit, replayed after a
 * crash), a single-owner lockfile (stale PIDs auto-reclaimed), and a
 * per-segment .meta sidecar (minTs/maxTs/counts) so time-range queries skip
 * non-overlapping files.
 *
 * The class is a thin composition root: it owns the collaborators from the
 * journal/ module and delegates to them.
 *   SegmentEncoder — on-disk format: binary container, compression, codecs
 *   SegmentStore   — closed-segment registry (index, .meta, LRU cache, persist)
 *   JournalWriter  — active segment + write-ahead log + flush/rollback
 *   JournalReader  — query/scan/timeline/aggregation over the segments
 *   AutoCompactor  — background bounded auto-compaction
 *   JournalLock    — single-owner lockfile (pid liveness, stale reclaim)
 *   RetentionEngine — tiered retention (depends on the store, not the Journal)
 */

import fs from 'node:fs';
import path from 'node:path';
import { Compression } from '../core/Compression.ts';
import { Interval } from '../core/Interval.ts';
import { Segment } from '../format/Segment.ts';
import { RetentionEngine } from './RetentionEngine.ts';
import ErrorManager from '../errors/ErrorManager.ts';
import { CLUSTER_META_KEY, ENGINE_META_KEY, Descriptor, parseClusterKey } from '../compaction/Descriptor.ts';
import { Cluster } from '../compaction/Cluster.ts';
import { makeEngine } from './engineFactory.ts';
import {
  DEFAULT_CLUSTER_ROWS_PER_PASS,
  DEFAULT_COMPACT_MIN_SEGMENTS,
  DEFAULT_ROWS_PER_SEGMENT,
  DEFAULT_WAL_BATCH_ROWS,
  LOCK_FILE,
  idFromFile,
  isSegmentFile,
} from './constants.ts';
import './errors.ts';
import { SegmentEncoder } from './SegmentEncoder.ts';
import { SegmentStore } from './SegmentStore.ts';
import { JournalWriter } from './JournalWriter.ts';
import { JournalReader } from './JournalReader.ts';
import { AutoCompactor } from './AutoCompactor.ts';
import { JournalLock } from './JournalLock.ts';
import { Purge } from './Purge.ts';
import { Shutdown } from './Shutdown.ts';
import type {
  AggregateExpr, AggFn, ClusterReport, CompactResult, CompressionMode,
  DownsampleBucket, JournalOptions, JournalStats, LockMode, WalMode,
  Metadata, PurgeResult, RetentionTier, Row, ScanOptions,
  Schema, TimelineBucket,
} from '../core/types.ts';

// Back-compat re-exports (these historically lived in Journal.ts).
export { DEFAULT_COMPACT_MIN_SEGMENTS, DEFAULT_ROWS_PER_SEGMENT, idFromFile, isSegmentFile } from './constants.ts';

export class Journal {
  readonly baseDir: string;
  private readonly journalsDir: string;
  readonly rowsPerSegment: number;
  readonly maxCachedSegments: number;
  readonly autoCompact: boolean;
  readonly compactMinSegments: number;

  name: string | null = null;
  schema: Schema | null = null;
  metadata: Metadata | null = null;

  /** Closed-segment registry (index, .meta sidecars, LRU cache, persist). */
  readonly store: SegmentStore;
  /** Active segment + write-ahead log + flush/rollback. */
  readonly writer: JournalWriter;
  /** All read paths (query/scan/timeline/aggregation). */
  readonly reader: JournalReader;
  /** Background bounded auto-compaction. */
  readonly compactor: AutoCompactor;

  /** The active in-memory segment (null between open and the first append). */
  get activeSegment(): Segment | null { return this.writer.activeSegment; }

  /** Segment ID counter (owned by the store). */
  get segmentCounter(): number { return this.store.counter; }

  isOpen = false;

  /** WAL batch: rows buffered in memory before disk write. */
  readonly walBatchSize: number;

  /** WAL strategy ('on' | 'off'): off = no per-row WAL (see JournalOptions.wal). */
  readonly walMode: WalMode;

  /** Single-owner lock strategy ('pid' | 'off'). */
  readonly lockMode: LockMode;

  /** Blob compression ('gzip' | 'zstd'). */
  readonly compression: CompressionMode;

  /** Explicit numeric codecs: field → codec name. Empty = auto-select. */
  readonly codecs: Record<string, string>;

  /** Retention tiers (Phase 4); null = defaults (see RetentionEngine.defaultTiers()). */
  private retentionTiers: RetentionTier[] | null = null;

  /** Lazy retention engine (see getter retention). */
  private retentionEngine: RetentionEngine | null = null;

  /** Row-level purge before a timestamp (see journal/Purge.ts). */
  private readonly purgeOp: Purge;

  private readonly encoder: SegmentEncoder;

  constructor(baseDir: string, opts: JournalOptions = {}) {
    this.baseDir = baseDir;
    this.journalsDir = path.join(baseDir, 'journals');
    this.rowsPerSegment = opts.rowsPerSegment ?? DEFAULT_ROWS_PER_SEGMENT;
    this.maxCachedSegments = opts.maxCachedSegments ?? 32;
    this.autoCompact = opts.autoCompact ?? true;
    const minSeg = opts.compactMinSegments ?? DEFAULT_COMPACT_MIN_SEGMENTS;
    if (!Number.isInteger(minSeg) || minSeg < 2) throw ErrorManager.make('JRN_OPT_COMPACT_MIN');
    this.compactMinSegments = minSeg;
    const batch = opts.walBatchSize ?? DEFAULT_WAL_BATCH_ROWS;
    if (!Number.isInteger(batch) || batch < 1) throw ErrorManager.make('JRN_OPT_WAL_BATCH');
    this.walBatchSize = batch;

    const wal = opts.wal ?? 'off';
    if (wal !== 'on' && wal !== 'off') throw ErrorManager.make('JRN_OPT_WAL');
    this.walMode = wal;

    const lock = opts.lock ?? 'pid';
    if (lock !== 'pid' && lock !== 'off') throw ErrorManager.make('JRN_OPT_LOCK');
    this.lockMode = lock;

    const compression = opts.compression ?? Compression.default();
    if (compression !== 'gzip' && compression !== 'zstd') throw ErrorManager.make('JRN_OPT_COMPRESSION');
    this.compression = compression;

    this.codecs = opts.codecs && typeof opts.codecs === 'object' ? { ...opts.codecs } : {};
    this.retentionTiers = Array.isArray(opts.retention) && opts.retention.length > 0 ? opts.retention.slice() : null;
    this.encoder = new SegmentEncoder(this.compression, this.codecs);

    this.store = new SegmentStore(
      () => this.journalPath(),
      this.encoder,
      this.maxCachedSegments,
      (id) => new Segment(id, this.schema!, { ...(this.metadata ?? {}) }),
    );
    this.writer = new JournalWriter(
      () => this.journalPath(),
      (id) => new Segment(id, this.schema!, { ...(this.metadata ?? {}) }),
      () => this.store.newId(),
      this.rowsPerSegment,
      batch,
      this.walMode,
      (seg) => this.store.persist(seg),
    );
    this.reader = new JournalReader(
      this.store,
      () => this.writer.activeSegment,
      () => this.schema,
    );
    this.purgeOp = new Purge(this.store, this.writer, () => this.schema!, () => this.metadata);
    this.compactor = new AutoCompactor(this.store, {
      minSegments: this.compactMinSegments,
      fallbackRows: this.rowsPerSegment,
      shouldRun: () => this.isOpen && this.autoCompact,
      mergeBatch: (ids) => { this.compactBatch(ids); },
    });
  }

  get retention(): RetentionEngine {
    if (!this.retentionEngine) {
      this.retentionEngine = new RetentionEngine(
        this.store, () => this.journalPath(), this.retentionTiers ?? undefined,
        undefined, () => this.clusterKey,
      );
    }
    return this.retentionEngine;
  }

  open(name: string, schema: Schema, metadata: Metadata = {}): void {
    if (this.isOpen) throw ErrorManager.make('JRN_ALREADY_OPEN', { name: this.name });

    this.name = name;
    this.schema = schema;
    this.metadata = metadata;

    const journalPath = this.journalPath();
    fs.mkdirSync(journalPath, { recursive: true });
    JournalLock.acquire(this._lockPath(), this.lockMode);

    try {
      this.store.scanDir(journalPath);
      const walLines = this.writer.wal.readLines();
      if (walLines.length > 0) this.store.repairMissingMeta();
      this.writer.seedWalSeq(this.store.maxWalSeq());
      this.writer.createActiveSegment();
      this.isOpen = true;
      Shutdown.track(this);
      if (walLines.length > 0) this.writer.replay(walLines, this.store.maxWalSeq());
    } catch (e) {
      JournalLock.release(this._lockPath(), this.lockMode);
      throw e;
    }
  }

  close(): void {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    this.writer.drain();
    this.flush();
    this.writer.end();
    this.isOpen = false;
    this.compactor.reset();
    Shutdown.untrack(this);
    JournalLock.release(this._lockPath(), this.lockMode);
  }

  // --- Writing ---

  append(row: Row): void {
    if (!this.isOpen || !this.activeSegment) throw ErrorManager.make('JRN_NOT_OPEN');

    const flushed = this.writer.append(row);
    if (flushed) {
      // store.index holds exactly the closed segments — count without sorting.
      if (this.autoCompact && this.store.size >= this.compactMinSegments) {
        // Do NOT merge the whole table here: run one bounded pass (memory-safe)
        // and let it self-chain in the background. See AutoCompactor.tick().
        this.compactor.tick();
      }
    }
  }

  flush(): void {
    this.writer.flush();
  }

  clear(): void {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    this.store.clearDir();
    this.writer.reset();
  }

  // --- Compaction ---

  compact(): CompactResult {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const ids = this.store.sortedIds();
    if (ids.length < 2) return { mergedSegments: 0, logicalRows: 0, physicalBefore: 0, physicalAfter: 0, collapsedRows: 0 };
    // Explicit call = "merge everything now". Keeps the synchronous, whole-table
    // contract the tests rely on. The automatic path uses bounded AutoCompactor
    // passes instead so it never holds the entire table in memory at once.
    return this.compactBatch(ids);
  }

  /**
   * Merges exactly the given closed segment ids (>= 2) into one new segment.
   * The unit of work for both the explicit compact() and the bounded automatic
   * passes; callers bound the id set to keep peak memory proportional to the
   * batch, not to the whole table.
   */
  private mergeTransform(cluster: string[] | null): (rows: Row[]) => Row[] {
    const engineDesc = Descriptor.fromMeta((this.metadata as Record<string, unknown>)[ENGINE_META_KEY]);
    const engineMerge = engineDesc
      ? (rows: Row[]) => makeEngine(engineDesc).merge(rows)
      : (rows: Row[]) => rows;
    // Clustered tables: the engine merge runs first (identity for log), then
    // rows are ordered by the cluster key so the new segment stores same-
    // dimension rows adjacently.
    return cluster ? (rows: Row[]) => Cluster.sort(engineMerge(rows), cluster) : engineMerge;
  }

  compactBatch(ids: string[]): CompactResult {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const cluster = this.clusterKey;
    const { merged, logicalRows, physicalBefore, keptRows }
      = this.store.merge(ids, this.mergeTransform(cluster), undefined, undefined, cluster);
    return {
      mergedSegments: ids.length,
      logicalRows,
      physicalBefore,
      physicalAfter: merged.physicalRowCount,
      collapsedRows: logicalRows - keptRows
    };
  }

  purge(beforeTs: number | string): PurgeResult {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.purgeOp.run(Interval.resolve(beforeTs));
  }

  /**
   * Cluster-compacts closed segments: merges ts-neighbor batches (bounded by
   * a row budget, like AutoCompactor passes) into new segments whose rows are
   * ordered by the journal's cluster key (dimension fields, then ts ↑).
   * Segments outside [start, end] are left untouched; the segment order by
   * minTs is preserved because batches are taken from sortedIds().
   */
  clusterCompact(start?: number, end?: number): ClusterReport {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const cluster = this.clusterKey;
    if (!cluster) throw ErrorManager.make('JRN_NO_CLUSTER');

    const from = typeof start === 'number' ? start : Number.NEGATIVE_INFINITY;
    const to = typeof end === 'number' ? end : Number.POSITIVE_INFINITY;
    const candidates: string[] = [];
    for (const id of this.store.sortedIds()) {
      const m = this.store.metaOf(id);
      // No sidecar or a ts-less segment: can't prove it's outside the window → include.
      if (m && m.minTs !== null && m.maxTs !== null && (m.maxTs < from || m.minTs > to)) continue;
      candidates.push(id);
    }

    const transform = this.mergeTransform(cluster);

    const report: ClusterReport = { mergedSegments: 0, windows: 0, rows: 0 };
    if (candidates.length < 2) return report;

    // ts-neighbor batches from sortedIds with a row budget (memory bound).
    let batch: string[] = [];
    let rows = 0;
    const batches: string[][] = [];
    for (const id of candidates) {
      batch.push(id);
      rows += this.store.metaOf(id)?.rowCount ?? this.rowsPerSegment;
      if (batch.length >= 2 && rows >= DEFAULT_CLUSTER_ROWS_PER_PASS) {
        batches.push(batch);
        batch = [];
        rows = 0;
      }
    }
    if (batch.length > 0) {
      if (batch.length === 1 && batches.length > 0) {
        batches[batches.length - 1].push(batch[0]);
      } else if (batch.length >= 2) {
        batches.push(batch);
      }
    }

    for (const ids of batches) {
      const { logicalRows } = this.store.merge(ids, transform, undefined, undefined, cluster);
      report.mergedSegments += ids.length;
      report.windows++;
      report.rows += logicalRows;
    }
    return report;
  }

  // --- Retention (Phase 4): helpers over the segment store ---

  closedSegmentIds(): string[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.store.sortedIds();
  }

  closedSegmentInfo(id: string): { minTs: number | null; maxTs: number | null; rowCount: number | null; physicalRowCount: number | null; bytes: number | null } | null {
    return this.store.info(id);
  }

  // --- Time-series reads (Phase 1) ---

  timeline(interval: number | string, period: [number, number] | string): TimelineBucket[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.reader.timeline(interval, period);
  }

  aggregate(startTs: number | string, endTs: number | string, exprs: AggregateExpr[]): Record<string, number | null> {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.reader.aggregate(startTs, endTs, exprs);
  }

  percentile(startTs: number | string, endTs: number | string, field: string, levels: number | number[]): Record<string, number | null> {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.reader.percentile(startTs, endTs, field, levels);
  }

  downsample(startTs: number | string, endTs: number | string, bucketMs: number | string, field: string, fns: AggFn[]): DownsampleBucket[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.reader.downsample(startTs, endTs, bucketMs, field, fns);
  }

  // --- Vectorized scan (Phase 3) ---

  scan(opts: ScanOptions): Row[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.reader.scan(opts);
  }

  // --- Row reads ---

  getTimeRange(): [number, number] | null {
    return this.reader.timeRange();
  }

  getMarks(): number[] {
    return this.reader.getMarks();
  }

  query(startTime: number | string, endTime: number | string): Row[] {
    return this.reader.query(startTime, endTime);
  }

  allRows(): Row[] {
    return this.reader.allRows();
  }

  tail(count: number): Row[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.reader.tail(count);
  }

  page(limit: number, offset = 0, order: 'asc' | 'desc' = 'asc'): Row[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.reader.page(limit, offset, order);
  }

  getMetadata(): Metadata {
    return { ...this.metadata };
  }

  /** The journal's cluster key (dimension fields), or null when not clustered. */
  get clusterKey(): string[] | null {
    return parseClusterKey((this.metadata as Record<string, unknown>)[CLUSTER_META_KEY]);
  }

  updateMetadata(newMetadata: Metadata): void {
    this.metadata = { ...this.metadata, ...newMetadata };
    if (this.activeSegment) this.activeSegment.metadata = { ...this.metadata };
  }

  stats(): JournalStats {
    const ids = this.store.sortedIds();
    let segmentCount = ids.length;
    let totalRows = 0;
    let totalPhysical = 0;
    for (const id of ids) {
      const m = this.store.metaOf(id);
      totalRows += m?.rowCount ?? 0;
      totalPhysical += m?.physicalRowCount ?? m?.rowCount ?? 0;
    }

    const active = this.activeSegment;
    if (active && active.rowCount > 0) {
      segmentCount++;
      totalRows += active.rowCount;
      totalPhysical += active.physicalRowCount || active.rowCount;
    }

    return {
      name: this.name,
      isOpen: this.isOpen,
      segmentCount,
      totalRows,
      totalPhysicalRows: totalPhysical,
      dedupRatio: totalRows > 0 ? (totalPhysical / totalRows).toFixed(3) : 'N/A',
      timeRange: this.getTimeRange()
    };
  }

  // --- Internals ---

  journalPath(): string {
    return path.join(this.journalsDir, this.name!);
  }

  /** Drain the WAL buffer to disk (called from the process exit hook). */
  walDrain(): void {
    this.writer.drain();
  }

  // --- Single-owner journal locking ---

  private _lockPath(): string {
    return path.join(this.journalPath(), LOCK_FILE);
  }
}
