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
 *   SegmentEncoder — on-disk format: v2/v3, compression, codecs
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
import { ENGINE_META_KEY, Descriptor } from '../compaction/Descriptor.ts';
import { makeEngine } from './engineFactory.ts';
import {
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
import { trackJournal, untrackJournal } from './shutdown.ts';
import { detectSegmentFormat } from './segmentFormat.ts';
import type {
  AggregateExpr, AggFn, CompactResult, CompressionMode,
  DownsampleBucket, JournalOptions, JournalStats, LockMode,
  Metadata, PurgeResult, RetentionTier, Row, ScanOptions,
  Schema, SegmentFormat, TimelineBucket,
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

  /** Single-owner lock strategy ('pid' | 'off'). */
  readonly lockMode: LockMode;

  /** Segment file format on write ('v2' | 'v3'); reads are transparent. */
  readonly format: SegmentFormat;

  /** Blob compression in v3 ('gzip' | 'zstd'); ignored in v2. */
  readonly compression: CompressionMode;

  /** Explicit v3 numeric codecs: field → codec name. Empty = auto-select. */
  readonly codecs: Record<string, string>;

  /** Retention tiers (Phase 4); null = defaults (see RetentionEngine.defaultTiers()). */
  private retentionTiers: RetentionTier[] | null = null;

  /** Lazy retention engine (see getter retention). */
  private retentionEngine: RetentionEngine | null = null;

  /** One-time v2→v3 migration done for this open. */
  private _v3Migrated = false;

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

    const lock = opts.lock ?? 'pid';
    if (lock !== 'pid' && lock !== 'off') throw ErrorManager.make('JRN_OPT_LOCK');
    this.lockMode = lock;

    const format = opts.format ?? 'v2';
    if (format !== 'v2' && format !== 'v3') throw ErrorManager.make('JRN_OPT_FORMAT');
    this.format = format;

    const compression = opts.compression ?? Compression.default();
    if (compression !== 'gzip' && compression !== 'zstd') throw ErrorManager.make('JRN_OPT_COMPRESSION');
    this.compression = compression;

    this.codecs = opts.codecs && typeof opts.codecs === 'object' ? { ...opts.codecs } : {};
    this.retentionTiers = Array.isArray(opts.retention) && opts.retention.length > 0 ? opts.retention.slice() : null;
    this.encoder = new SegmentEncoder(this.format, this.compression, this.codecs);

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
      (seg) => this.store.persist(seg),
    );
    this.reader = new JournalReader(
      this.store,
      () => this.writer.activeSegment,
      () => this.schema,
    );
    this.compactor = new AutoCompactor(this.store, {
      minSegments: this.compactMinSegments,
      fallbackRows: this.rowsPerSegment,
      shouldRun: () => this.isOpen && this.autoCompact,
      mergeBatch: (ids) => { this.compactBatch(ids); },
    });
  }

  get retention(): RetentionEngine {
    if (!this.retentionEngine) {
      this.retentionEngine = new RetentionEngine(this.store, () => this.journalPath(), this.retentionTiers ?? undefined);
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
      this.writer.createActiveSegment();
      this.isOpen = true;
      trackJournal(this);
      const walLines = this.writer.wal.readLines();
      if (walLines.length > 0) this.writer.replay(walLines);
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
    untrackJournal(this);
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
    // Migrate any legacy v2 segments first, even when there is nothing to
    // merge: compacting a lone old segment is exactly how it gets re-encoded
    // to v3 (test-migration relies on this).
    this._ensureV3();
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
  compactBatch(ids: string[]): CompactResult {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    this._ensureV3();
    const engineDesc = Descriptor.fromMeta((this.metadata as Record<string, unknown>)[ENGINE_META_KEY]);
    const transform = engineDesc
      ? (rows: Row[]) => makeEngine(engineDesc).merge(rows)
      : (rows: Row[]) => rows;
    const { merged, logicalRows, physicalBefore, keptRows } = this.store.merge(ids, transform);
    return {
      mergedSegments: ids.length,
      logicalRows,
      physicalBefore,
      physicalAfter: merged.physicalRowCount,
      collapsedRows: logicalRows - keptRows
    };
  }

  private _ensureV3(): void {
    if (!this._v3Migrated) {
      this.migrateToV3();
      this._v3Migrated = true;
    }
  }

  migrateToV3(): { migrated: number; logicalRows: number } {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    if (this.format !== 'v3') return { migrated: 0, logicalRows: 0 };

    let migrated = 0;
    let logicalRows = 0;
    for (const id of this.store.sortedIds()) {
      const file = this.store.fileOf(id);
      if (!file || detectSegmentFormat(path.join(this.journalPath(), file)) === 'v3') continue;
      this.store.reencode(id, (seg) => this.encoder.encode(seg));
      migrated++;
      const seg = this.store.cached(id);
      if (seg) logicalRows += seg.rowCount;
    }
    return { migrated, logicalRows };
  }

  purge(beforeTs: number | string): PurgeResult {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const before = Interval.resolve(beforeTs);

    if (this.activeSegment) {
      this.writer.drain();
      if (this.activeSegment.rowCount > 0) this.flush();
      else this.writer.truncateWAL();
    }

    let removedRows = 0;
    let removedSegments = 0;
    let rewrittenSegments = 0;

    for (const id of [...this.store.sortedIds()]) {
      const meta = this.store.metaOf(id);
      const minTs = meta?.minTs ?? null;
      const maxTs = meta?.maxTs ?? null;
      const rowCount = meta?.rowCount ?? null;
      const tsCount = meta?.tsCount ?? null;

      if (maxTs !== null && maxTs < before && rowCount !== null && tsCount !== null && tsCount === rowCount) {
        removedRows += rowCount;
        this.store.drop(id);
        removedSegments++;
        continue;
      }
      if (minTs !== null && minTs >= before) continue;

      const seg = this.store.loadClosed(id);
      const kept: Row[] = [];
      for (let i = 0; i < seg.rowCount; i++) {
        const row = seg.getRow(i);
        const ts = row.ts;
        if (typeof ts !== 'number' || ts >= before) kept.push(row);
      }
      const dropped = seg.rowCount - kept.length;
      if (dropped === 0) continue;

      removedRows += dropped;
      const fresh = new Segment(seg.id, this.schema!, this.metadata ?? {});
      for (const row of kept) fresh.append(row);
      this.store.persist(fresh, undefined, this.store.fileOf(id) ?? null);
      rewrittenSegments++;
    }

    this.writer.createActiveSegment();
    return { removedRows, removedSegments, rewrittenSegments };
  }

  // --- Retention (Phase 4): helpers over the segment store ---

  closedSegmentIds(): string[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.store.sortedIds();
  }

  getClosedSegment(id: string): Segment {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.store.loadClosed(id);
  }

  closedSegmentFile(id: string): string | null {
    return this.store.fileOf(id);
  }

  closedSegmentInfo(id: string): { minTs: number | null; maxTs: number | null; rowCount: number | null; physicalRowCount: number | null; bytes: number | null } | null {
    return this.store.info(id);
  }

  newSegmentId(): string {
    return this.store.newId();
  }

  reencodeClosedSegment(id: string, encode: (seg: Segment) => Buffer): string {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this.store.reencode(id, encode);
  }

  mergeClosedSegments(ids: string[], encode: (seg: Segment) => Buffer): string {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const sorted = [...new Set(ids)];
    if (sorted.length === 0) throw ErrorManager.make('JRN_MERGE_EMPTY');
    return this.store.merge(sorted, (rows) => rows, encode, this.encoder.ext()).id;
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
  _walDrain(): void {
    this.writer.drain();
  }

  // --- Single-owner journal locking ---

  private _lockPath(): string {
    return path.join(this.journalPath(), LOCK_FILE);
  }
}
