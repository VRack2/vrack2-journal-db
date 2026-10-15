/*
 * Journal — append-only event log. Closed segments load lazily from disk and are
 * LRU-cached; the active segment lives in memory until flush.
 * Durability: WAL (batched, drained on flush/close/exit, replayed after a crash),
 * a single-owner lockfile (stale PIDs auto-reclaimed), and a per-segment .meta
 * sidecar (minTs/maxTs/counts) so time-range queries skip non-overlapping files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Segment } from './Segment.ts';
import type { Column } from './columns/Column.ts';
import { LRUCache } from './LRUCache.ts';
import { Percentile } from './Percentile.ts';
import { SegmentFileV2 } from './SegmentFileV2.ts';
import { SegmentFileV3 } from './SegmentFileV3.ts';
import { SegmentFile } from './SegmentFile.ts';
import { Compression } from './Compression.ts';
import { Interval } from './Interval.ts';
import { RetentionEngine } from './RetentionEngine.ts';
import ErrorManager from './errors/ErrorManager.ts';

ErrorManager.registerMany('Journal', [
  { short: 'JRN_OPT_COMPACT_MIN', description: 'compactMinSegments must be an integer >= 2' },
  { short: 'JRN_OPT_WAL_BATCH', description: 'walBatchSize must be an integer >= 1' },
  { short: 'JRN_OPT_LOCK', description: "lock must be 'pid' or 'off'" },
  { short: 'JRN_OPT_FORMAT', description: "format must be 'v2' or 'v3'" },
  { short: 'JRN_OPT_COMPRESSION', description: "compression must be 'gzip' or 'zstd'" },
  { short: 'JRN_ALREADY_OPEN', description: 'Journal already open', rules: { name: 'string' } },
  { short: 'JRN_NOT_OPEN', description: 'Journal not open. Call open() first.' },
  { short: 'JRN_MERGE_EMPTY', description: 'mergeClosedSegments: empty list' },
  { short: 'JRN_TL_INTERVAL', description: 'timeline(): interval must be a number (ms) or string like "1h/30m"' },
  { short: 'JRN_TL_INTERVAL_POS', description: 'timeline(): interval must be > 0 (ms)' },
  { short: 'JRN_TL_PERIOD', description: 'timeline(): period must be [start, end] (ms) or string like "now-7d:now"' },
  { short: 'JRN_AGG_EXPRS', description: 'aggregate(): exprs must be a non-empty array of { field, fn }' },
  { short: 'JRN_AGG_FIELD', description: 'aggregate(): expr.field must be a non-empty string' },
  { short: 'JRN_AGG_FN', description: 'aggregate(): expr.fn must be min|max|sum|avg|count', rules: { fn: 'string' } },
  { short: 'JRN_PCTL_FIELD', description: 'percentile(): field must be a non-empty string' },
  { short: 'JRN_PCTL_LEVEL', description: 'percentile(): level must be a number in (0, 1)', rules: { level: 'string' } },
  { short: 'JRN_DS_FIELD', description: 'downsample(): field must be a non-empty string' },
  { short: 'JRN_DS_FNS', description: 'downsample(): fns must be a non-empty array of min|max|sum|avg|count' },
  { short: 'JRN_DS_FN', description: 'downsample(): fn must be min|max|sum|avg|count', rules: { fn: 'string' } },
  { short: 'JRN_DS_BUCKET', description: 'downsample(): bucketMs must be a number (ms) or string like "15m/1h"' },
  { short: 'JRN_DS_BUCKET_POS', description: 'downsample(): bucketMs must be > 0 (ms)' },
  { short: 'JRN_SCAN_RANGE', description: 'scan(): start must be <= end' },
  { short: 'JRN_SCAN_WHERE_FIELD', description: 'scan(): where[].field must be a non-empty string' },
  { short: 'JRN_SCAN_WHERE_OP', description: 'scan(): where[].op must be a valid operator', rules: { op: 'string', allowed: 'string' } },
  { short: 'JRN_SCAN_WHERE_IN', description: 'scan(): where[].value for in/nin must be an array' },
  { short: 'JRN_SCAN_AGG_FIELD', description: 'scan(): agg field must be a non-empty string' },
  { short: 'JRN_SCAN_AGG_FNS', description: 'scan(): agg field must have a non-empty array of functions' },
  { short: 'JRN_SCAN_AGG_FN', description: 'scan(): agg field function must be min|max|sum|avg|count', rules: { fn: 'string' } },
  { short: 'JRN_SCAN_GROUPBY_AGG', description: 'scan(): groupBy requires agg' },
  { short: 'JRN_SCAN_GROUPBY', description: 'scan(): groupBy must be a non-empty string' },
  { short: 'JRN_SCAN_SELECT', description: 'scan(): select must be a non-empty list of fields' },
  { short: 'JRN_SCAN_SELECT_FIELD', description: 'scan(): select[].field must be a non-empty string' },
  { short: 'JRN_SCAN_ORDER', description: "scan(): order must be 'asc' or 'desc'" },
  { short: 'JRN_SCAN_LIMIT', description: 'scan(): limit must be an integer >= 0' },
  { short: 'JRN_SCAN_OFFSET', description: 'scan(): offset must be an integer >= 0' },
  { short: 'JRN_SEG_UNKNOWN', description: 'Unknown segment', rules: { id: 'string' } },
  { short: 'JRN_SEG_READ', description: 'Failed to read segment', rules: { file: 'string', message: 'string' } },
  { short: 'JRN_LOCKED', description: "Journal locked by process. If no other owners exist, open with { lock: 'off' } or delete .lock", rules: { pid: 'number', lockPath: 'string' } },
]);

import { ENGINE_META_KEY, Descriptor } from './compaction/Descriptor.ts';
import { Log } from './compaction/Log.ts';
import { Upsert } from './compaction/Upsert.ts';
import { Summing } from './compaction/Summing.ts';
import { Collapsing } from './compaction/Collapsing.ts';
import type { Engine } from './compaction/Engine.ts';

/** kind → engine class; the single dispatch point by kind. */
function makeEngine(desc: Descriptor): Engine {
  switch (desc.kind) {
    case 'log': return new Log(desc);
    case 'upsert': return new Upsert(desc);
    case 'summing': return new Summing(desc);
    case 'collapsing': return new Collapsing(desc);
  }
}

import type {
  AggregateExpr, AggFn, ColumnSummary, CompactResult, CompressionMode,
  DownsampleBucket, JournalOptions, JournalStats, JsonValue, LockMode,
  Metadata, PurgeResult, RetentionTier, Row, ScanOp, ScanOptions,
  Schema, SegmentFormat, TimelineBucket,
} from './types.ts';

const LOCK_FILE = '.lock';
const WAL_FILE = 'wal.log';
const META_SUFFIX = '.meta';
const SEG_V3_EXT = '.seg';
const SEG_V2_EXT = '.json';

const isSegmentFile = (f: string): boolean => f.endsWith(SEG_V3_EXT) || f.endsWith(SEG_V2_EXT);
const idFromFile = (f: string): string =>
  f.endsWith(SEG_V3_EXT) ? f.slice(0, -SEG_V3_EXT.length) :
  f.endsWith(SEG_V2_EXT) ? f.slice(0, -SEG_V2_EXT.length) : f;

/** Default rows per segment before flush. Deliberately large: fewer files/unlinks on SSD. */
export const DEFAULT_ROWS_PER_SEGMENT = 10_000;
const DEFAULT_WAL_BATCH_ROWS = 512;
const WAL_FLUSH_BYTES = 1_000_000;
export const DEFAULT_COMPACT_MIN_SEGMENTS = 4;

const activeJournals = new Set<Journal>();
let shutdownHooksInstalled = false;

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;

  const drainAll = (): void => {
    for (const j of [...activeJournals]) {
      try { j._walDrain(); } catch { /* exiting anyway */ }
    }
  };

  process.on('exit', drainAll);
  const rekill = (sig: NodeJS.Signals): void => {
    drainAll();
    process.kill(process.pid, sig);
  };
  process.once('SIGINT', () => rekill('SIGINT'));
  process.once('SIGTERM', () => rekill('SIGTERM'));
}

interface SegmentMeta {
  minTs: number | null;
  maxTs: number | null;
  rowCount: number;
  physicalRowCount: number;
  tsCount: number | null;
  summaries: Record<string, ColumnSummary> | null;
}

interface AggAcc {
  min: number;
  max: number;
  sum: number;
  count: number;
}

const newAcc = (): AggAcc => ({ min: Infinity, max: -Infinity, sum: 0, count: 0 });

function addValue(acc: AggAcc, v: number): void {
  if (v < acc.min) acc.min = v;
  if (v > acc.max) acc.max = v;
  acc.sum += v;
  acc.count++;
}

function addSummary(acc: AggAcc, s: ColumnSummary): void {
  if (s.count === 0) return;
  if (s.min < acc.min) acc.min = s.min;
  if (s.max > acc.max) acc.max = s.max;
  acc.sum += s.sum;
  acc.count += s.count;
}

const AGG_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count']);
function isAggFn(fn: unknown): fn is AggFn {
  return typeof fn === 'string' && AGG_FNS.has(fn);
}

function aggValue(acc: AggAcc, fn: AggFn): number | null {
  switch (fn) {
    case 'count': return acc.count;
    case 'sum':   return acc.count > 0 ? acc.sum : null;
    case 'min':   return acc.count > 0 ? acc.min : null;
    case 'max':   return acc.count > 0 ? acc.max : null;
    case 'avg':   return acc.count > 0 ? acc.sum / acc.count : null;
  }
}

const SCAN_OPS: readonly ScanOp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin', 'isNull', 'isNotNull'];
const SCAN_OP_SET: ReadonlySet<string> = new Set(SCAN_OPS);
function isScanOp(op: unknown): op is ScanOp {
  return typeof op === 'string' && SCAN_OP_SET.has(op);
}

function keyOf(v: JsonValue): string {
  switch (typeof v) {
    case 'string':  return 's' + v;
    case 'number':  return 'n' + v;
    case 'boolean': return 'b' + v;
  }
  if (v === null || v === undefined) return '\u0000n';
  return 'j' + JSON.stringify(v);
}

function whereOne(value: JsonValue, op: ScanOp, target: JsonValue): boolean {
  switch (op) {
    case 'eq':        return value === target;
    case 'ne':        return value !== target;
    case 'lt':        return typeof value === 'number' && typeof target === 'number' && value < target;
    case 'le':        return typeof value === 'number' && typeof target === 'number' && value <= target;
    case 'gt':        return typeof value === 'number' && typeof target === 'number' && value > target;
    case 'ge':        return typeof value === 'number' && typeof target === 'number' && value >= target;
    case 'in':        return Array.isArray(target) && target.includes(value);
    case 'nin':       return Array.isArray(target) && !target.includes(value);
    case 'isNull':    return value === null || value === undefined;
    case 'isNotNull': return value !== null && value !== undefined;
  }
  return false;
}

interface ScanPlan {
  start: number | null;
  end: number | null;
  where: { field: string; op: ScanOp; value: JsonValue }[];
  hasTsFilter: boolean;
  groupBy: string[];
  agg: boolean;
  aggSpec: { field: string; fns: AggFn[] }[];
  aggKeys: string[];
  select: string[];
  order: 1 | -1;
  limit: number | null;
  offset: number;
  sortKey: string;
}

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
  activeSegment: Segment | null = null;

  /** Segment ID → disk file name */
  private segmentIndex = new Map<string, string>();

  /** Unique segment ID suffix: prevents two open instances (lock:'off') in the same ms from overwriting a file. */
  private readonly _idNonce = Math.random().toString(16).slice(2, 8);

  /** Segment ID → Segment object (LRU) */
  private _segmentCache: LRUCache<string, Segment>;

  segmentCounter = 0;
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

  /** WAL buffer (serialized strings) — written in a single append. */
  private _walBuf: string[] = [];
  private _walBufBytes = 0;

  /** segment id → min/max ts + counts from the .meta sidecar (no file load). */
  private segmentMeta = new Map<string, SegmentMeta>();

  // --- Automatic compaction (background, self-limiting, no client involvement) ---
  // append() only *arms* a pass; the work runs in bounded batches off the hot
  // path so the heap never holds the whole table at once.
  private _compactArmed = false;   // a pass is scheduled (de-duplicates scheduling)
  private _compacting = false;     // a pass is running (reentrancy guard)
  private _v3Migrated = false;     // one-time v2→v3 migration done for this open
  /** Adaptive rows-per-pass budget (the point-2 memory bound). */
  private _compactRowsPerPass = 200_000;
  /** Target wall-time for one pass; drives _adapt(). */
  private readonly _passTimeBudgetMs = 25;
  private readonly _minRowsPerPass = 20_000;
  private readonly _maxRowsPerPass = 500_000;

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
    this._segmentCache = new LRUCache<string, Segment>(this.maxCachedSegments);
  }

  get retention(): RetentionEngine {
    if (!this.retentionEngine) {
      this.retentionEngine = new RetentionEngine(this, this.retentionTiers ?? undefined);
    }
    return this.retentionEngine;
  }

  private _segExt(): string {
    return this.format === 'v3' ? SEG_V3_EXT : SEG_V2_EXT;
  }

  private _encodeSegment(segment: Segment): Buffer {
    return this.format === 'v3'
      ? SegmentFileV3.encode(segment, { compression: this.compression, codecs: this.codecs })
      : SegmentFileV2.encode(segment.serialize());
  }

  open(name: string, schema: Schema, metadata: Metadata = {}): void {
    if (this.isOpen) throw ErrorManager.make('JRN_ALREADY_OPEN', { name: this.name });

    this.name = name;
    this.schema = schema;
    this.metadata = metadata;

    const journalPath = this.journalPath();
    fs.mkdirSync(journalPath, { recursive: true });
    this._acquireLock();

    try {
      const files = fs.readdirSync(journalPath).filter(isSegmentFile).sort();
      this.segmentIndex.clear();
      this.segmentMeta.clear();
      for (const file of files) {
        const id = idFromFile(file);
        this.segmentIndex.set(id, file);
        try {
          const metaPath = path.join(journalPath, `${file}${META_SUFFIX}`);
          const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SegmentMeta;
          if (typeof m.rowCount === 'number') {
            this.segmentMeta.set(id, {
              minTs: typeof m.minTs === 'number' ? m.minTs : null,
              maxTs: typeof m.maxTs === 'number' ? m.maxTs : null,
              rowCount: m.rowCount,
              physicalRowCount: typeof m.physicalRowCount === 'number' ? m.physicalRowCount : m.rowCount,
              tsCount: typeof m.tsCount === 'number' ? m.tsCount : null,
              summaries: (m.summaries && typeof m.summaries === 'object') ? m.summaries : null
            });
          }
        } catch { /* no .meta or corrupt */ }
      }
      this.segmentCounter = files.length;
      this._createNewActiveSegment();
      this.isOpen = true;
      activeJournals.add(this);
      installShutdownHooks();
      this._replayWAL();
    } catch (e) {
      this._releaseLock();
      throw e;
    }
  }

  close(): void {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    this._walDrain();
    this.flush();
    this.activeSegment = null;
    this.isOpen = false;
    this._compactArmed = false;
    this._compacting = false;
    activeJournals.delete(this);
    this._releaseLock();
  }

  // --- Writing ---

  append(row: Row): void {
    if (!this.isOpen || !this.activeSegment) throw ErrorManager.make('JRN_NOT_OPEN');

    const line = JSON.stringify(row) + '\n';
    this._walBuf.push(line);
    this._walBufBytes += line.length;
    let drained = false;
    if (this._walBuf.length >= this.walBatchSize || this._walBufBytes >= WAL_FLUSH_BYTES) {
      this._walDrain();
      drained = true;
    }

    const seg = this.activeSegment;
    try {
      seg.append(row);
    } catch (e) {
      if (drained) this._walRollbackLine(line);
      else {
        this._walBuf.pop();
        this._walBufBytes -= line.length;
      }
      throw e;
    }

    if (seg.rowCount >= this.rowsPerSegment) {
      this.flush();
      if (this.autoCompact && this._sortedClosedIds().length >= this.compactMinSegments) {
        // Do NOT merge the whole table here: run one bounded pass (memory-safe)
        // and let it self-chain in the background. See _tickAutoCompact().
        this._tickAutoCompact();
      }
    }
  }

  flush(): void {
    const segment = this.activeSegment;
    if (!segment || segment.rowCount === 0) return;

    this._walDrain();
    const fileName = `${segment.id}${this._segExt()}`;
    const filePath = path.join(this.journalPath(), fileName);
    const tmpPath = `${filePath}.tmp`;

    fs.writeFileSync(tmpPath, this._encodeSegment(segment));
    fs.renameSync(tmpPath, filePath);
    this._writeMeta(segment, fileName);
    this.segmentIndex.set(segment.id, fileName);
    this._segmentCache.set(segment.id, segment);
    this._createNewActiveSegment();
    this._truncateWAL();
  }

  clear(): void {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const dir = this.journalPath();
    for (const f of fs.readdirSync(dir)) {
      if (f === LOCK_FILE) continue;
      if (isSegmentFile(f) || f.endsWith(META_SUFFIX) || f.endsWith('.tmp') || f === WAL_FILE) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }
    this.segmentIndex.clear();
    this._segmentCache.clear();
    this.segmentMeta.clear();
    this._walBuf = [];
    this._walBufBytes = 0;
    this.activeSegment = null;
    this._createNewActiveSegment();
  }

  // --- Compaction ---

  compact(): CompactResult {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    // Migrate any legacy v2 segments first, even when there is nothing to
    // merge: compacting a lone old segment is exactly how it gets re-encoded
    // to v3 (test-migration relies on this).
    if (!this._v3Migrated) {
      this.migrateToV3();
      this._v3Migrated = true;
    }
    const ids = this._sortedClosedIds();
    if (ids.length < 2) return { mergedSegments: 0, logicalRows: 0, physicalBefore: 0, physicalAfter: 0, collapsedRows: 0 };
    // Explicit call = "merge everything now". Keeps the synchronous, whole-table
    // contract the tests rely on. The automatic path uses bounded _compactBatch
    // passes instead so it never holds the entire table in memory at once.
    return this._compactBatch(ids);
  }

  /**
   * Merges exactly the given closed segment ids (>= 2) into one new segment.
   * The unit of work for both the explicit compact() and the bounded automatic
   * passes; callers bound the id set to keep peak memory proportional to the
   * batch, not to the whole table.
   */
  private _compactBatch(ids: string[]): CompactResult {
    if (!this._v3Migrated) {
      this.migrateToV3();
      this._v3Migrated = true;
    }

    let logicalRows = 0;
    let physicalBefore = 0;
    const rows: Row[] = [];
    for (const id of ids) {
      const seg = this._loadClosedSegment(id);
      for (let i = 0; i < seg.rowCount; i++) rows.push(seg.getRow(i));
      logicalRows += seg.rowCount;
      physicalBefore += seg.physicalRowCount;
    }

    const engineDesc = Descriptor.fromMeta((this.metadata as Record<string, unknown>)[ENGINE_META_KEY]);
    const kept = engineDesc ? makeEngine(engineDesc).merge(rows) : rows;
    const collapsedRows = rows.length - kept.length;

    const merged = new Segment(`seg_${Date.now()}_${this.segmentCounter++}_${this._idNonce}`, this.schema!, { ...(this.metadata ?? {}) });
    for (const row of kept) merged.append(row);

    const fileName = `${merged.id}${this._segExt()}`;
    const filePath = path.join(this.journalPath(), fileName);
    fs.writeFileSync(`${filePath}.tmp`, this._encodeSegment(merged));
    fs.renameSync(`${filePath}.tmp`, filePath);
    this._writeMeta(merged, fileName);

    for (const id of ids) {
      const oldFile = this.segmentIndex.get(id);
      if (oldFile) {
        fs.unlinkSync(path.join(this.journalPath(), oldFile));
        fs.rmSync(path.join(this.journalPath(), `${oldFile}${META_SUFFIX}`), { force: true });
      }
      this.segmentIndex.delete(id);
      this._segmentCache.delete(id);
      this.segmentMeta.delete(id);
    }

    this.segmentIndex.set(merged.id, fileName);
    this._segmentCache.set(merged.id, merged);

    return { mergedSegments: ids.length, logicalRows, physicalBefore, physicalAfter: merged.physicalRowCount, collapsedRows };
  }

  // --------------------------------------------------
  // Automatic compaction (background, bounded, self-adaptive)
  // --------------------------------------------------

  /**
   * Runs ONE bounded compaction pass, then self-chains while compaction debt
   * remains. This is the automatic path (triggered by append(), by a cold
   * reopen, and by the shared maintenance driver). It is memory-safe: a single
   * pass materializes at most `_compactRowsPerPass` rows, never the whole table.
   *
   * Public (underscore) so the module-level driver and append() can call it,
   * like _walDrain(). No-op when closed: / disabled / no debt / already busy.
   */
  _tickAutoCompact(): void {
    if (!this.isOpen || !this.autoCompact) return;
    if (this._compactArmed || this._compacting) return;
    if (this._sortedClosedIds().length < this.compactMinSegments) return;

    this._compactArmed = true;
    this._compacting = true;
    let dt = 0;
    try {
      const closed = this._sortedClosedIds();
      if (closed.length >= 2) {
        const batch = this._pickBatch(closed, this._compactRowsPerPass);
        const t0 = Date.now();
        this._compactBatch(batch);
        dt = Date.now() - t0;
      }
    } finally {
      this._compactArmed = false;
      this._compacting = false;
    }

    this._adapt(dt);

    // Drain the remaining debt in the background, yielding to the event loop
    // (and the GC) between passes so the writer is never blocked on a
    // full-table merge.
    if (
      this.isOpen &&
      this.autoCompact &&
      this._sortedClosedIds().length >= this.compactMinSegments
    ) {
      setImmediate(() => this._tickAutoCompact());
    }
  }

  /**
   * Chooses the oldest closed segments up to `budgetRows` (point-2 memory
   * bound). Always returns at least 2 ids (a merge needs >= 2) and never more
   * than the budget, so peak memory tracks the budget, not the table size.
   */
  private _pickBatch(closed: string[], budgetRows: number): string[] {
    if (closed.length < 2) return closed;
    let rows = 0;
    const out: string[] = [];
    for (const id of closed) {
      out.push(id);
      rows += this.segmentMeta.get(id)?.rowCount ?? this.rowsPerSegment;
      if (out.length >= 2 && rows >= budgetRows) break;
    }
    return out;
  }

  /**
   * Adapts the rows-per-pass budget to the machine's load (point 3). A pass
   * that took too long shrinks the next batch (more frequent, smaller, gentler
   * on the writer); one that was fast grows it (fewer passes, less churn).
   */
  private _adapt(dt: number): void {
    if (dt <= 0) return;
    if (dt >= this._passTimeBudgetMs) {
      this._compactRowsPerPass = Math.max(this._minRowsPerPass, this._compactRowsPerPass >> 1);
    } else if (dt <= this._passTimeBudgetMs / 4) {
      this._compactRowsPerPass = Math.min(this._maxRowsPerPass, Math.floor(this._compactRowsPerPass * 1.5));
    }
  }

  private _detectSegFormat(file: string): 'v1' | 'v2' | 'v3' {
    let buf: Buffer;
    try {
      const fd = fs.openSync(path.join(this.journalPath(), file), 'r');
      try {
        buf = Buffer.alloc(5);
        if (fs.readSync(fd, buf, 0, 5, 0) < 5) return 'v1';
      } finally { fs.closeSync(fd); }
    } catch { return 'v1'; }
    if (buf.subarray(0, 4).toString('ascii') === 'JSDB') return buf[4] === 3 ? 'v3' : 'v2';
    return 'v1';
  }

  migrateToV3(): { migrated: number; logicalRows: number } {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    if (this.format !== 'v3') return { migrated: 0, logicalRows: 0 };

    const encode = (s: Segment) => SegmentFileV3.encode(s, { compression: this.compression, codecs: this.codecs });
    let migrated = 0;
    let logicalRows = 0;
    for (const id of this._sortedClosedIds()) {
      const file = this.segmentIndex.get(id);
      if (!file || this._detectSegFormat(file) === 'v3') continue;
      this.reencodeClosedSegment(id, encode);
      migrated++;
      const seg = this._segmentCache.get(id);
      if (seg) logicalRows += seg.rowCount;
    }
    return { migrated, logicalRows };
  }

  purge(beforeTs: number | string): PurgeResult {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const before = Interval.resolve(beforeTs);

    if (this.activeSegment) {
      this._walDrain();
      if (this.activeSegment.rowCount > 0) this.flush();
      else this._truncateWAL();
    }

    let removedRows = 0;
    let removedSegments = 0;
    let rewrittenSegments = 0;

    for (const id of [...this._sortedClosedIds()]) {
      const meta = this.segmentMeta.get(id);
      const minTs = meta?.minTs ?? null;
      const maxTs = meta?.maxTs ?? null;
      const rowCount = meta?.rowCount ?? null;
      const tsCount = meta?.tsCount ?? null;

      if (maxTs !== null && maxTs < before && rowCount !== null && tsCount !== null && tsCount === rowCount) {
        removedRows += rowCount;
        this._dropClosedSegment(id);
        removedSegments++;
        continue;
      }
      if (minTs !== null && minTs >= before) continue;

      const seg = this._loadClosedSegment(id);
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

      const oldFile = this.segmentIndex.get(id)!;
      const fileName = `${id}${this._segExt()}`;
      const filePath = path.join(this.journalPath(), fileName);
      fs.writeFileSync(`${filePath}.tmp`, this._encodeSegment(fresh));
      fs.renameSync(`${filePath}.tmp`, filePath);
      if (oldFile !== fileName) {
        fs.rmSync(path.join(this.journalPath(), oldFile), { force: true });
        fs.rmSync(path.join(this.journalPath(), `${oldFile}${META_SUFFIX}`), { force: true });
      }
      this._writeMeta(fresh, fileName);
      this._segmentCache.set(id, fresh);
      this.segmentIndex.set(id, fileName);
      rewrittenSegments++;
    }

    this._createNewActiveSegment();
    return { removedRows, removedSegments, rewrittenSegments };
  }

  private _dropClosedSegment(id: string): void {
    const oldFile = this.segmentIndex.get(id);
    if (oldFile) {
      fs.unlinkSync(path.join(this.journalPath(), oldFile));
      fs.rmSync(path.join(this.journalPath(), `${oldFile}${META_SUFFIX}`), { force: true });
    }
    this.segmentIndex.delete(id);
    this._segmentCache.delete(id);
    this.segmentMeta.delete(id);
  }

  // --- Retention (Phase 4) ---

  closedSegmentIds(): string[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this._sortedClosedIds();
  }

  getClosedSegment(id: string): Segment {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    return this._loadClosedSegment(id);
  }

  closedSegmentFile(id: string): string | null {
    return this.segmentIndex.get(id) ?? null;
  }

  closedSegmentInfo(id: string): { minTs: number | null; maxTs: number | null; rowCount: number | null; physicalRowCount: number | null; bytes: number | null } | null {
    const file = this.segmentIndex.get(id);
    const meta = this.segmentMeta.get(id) ?? null;
    if (!file && !meta) return null;
    let bytes: number | null = null;
    if (file) {
      try { bytes = fs.statSync(path.join(this.journalPath(), file)).size; } catch { bytes = null; }
    }
    return { minTs: meta?.minTs ?? null, maxTs: meta?.maxTs ?? null, rowCount: meta?.rowCount ?? null, physicalRowCount: meta?.physicalRowCount ?? null, bytes };
  }

  newSegmentId(): string {
    return `seg_${Date.now()}_${this.segmentCounter++}_${this._idNonce}`;
  }

  reencodeClosedSegment(id: string, encode: (seg: Segment) => Buffer): string {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const seg = this._loadClosedSegment(id);
    const fileName = `${id}${SEG_V3_EXT}`;
    const filePath = path.join(this.journalPath(), fileName);
    const oldFile = this.segmentIndex.get(id);
    fs.writeFileSync(`${filePath}.tmp`, encode(seg));
    fs.renameSync(`${filePath}.tmp`, filePath);
    if (oldFile && oldFile !== fileName) {
      fs.rmSync(path.join(this.journalPath(), oldFile), { force: true });
      fs.rmSync(path.join(this.journalPath(), `${oldFile}${META_SUFFIX}`), { force: true });
    }
    this._writeMeta(seg, fileName);
    this._segmentCache.set(id, seg);
    this.segmentIndex.set(id, fileName);
    return fileName;
  }

  mergeClosedSegments(ids: string[], encode: (seg: Segment) => Buffer): string {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const sorted = [...new Set(ids)];
    if (sorted.length === 0) throw ErrorManager.make('JRN_MERGE_EMPTY');
    const rows: Row[] = [];
    for (const id of sorted) {
      const seg = this._loadClosedSegment(id);
      for (let i = 0; i < seg.rowCount; i++) rows.push(seg.getRow(i));
    }
    const merged = new Segment(this.newSegmentId(), this.schema!, { ...(this.metadata ?? {}) });
    for (const row of rows) merged.append(row);
    const fileName = `${merged.id}${SEG_V3_EXT}`;
    const filePath = path.join(this.journalPath(), fileName);
    fs.writeFileSync(`${filePath}.tmp`, encode(merged));
    fs.renameSync(`${filePath}.tmp`, filePath);
    this._writeMeta(merged, fileName);
    for (const id of sorted) {
      const oldFile = this.segmentIndex.get(id);
      if (oldFile) {
        fs.unlinkSync(path.join(this.journalPath(), oldFile));
        fs.rmSync(path.join(this.journalPath(), `${oldFile}${META_SUFFIX}`), { force: true });
      }
      this.segmentIndex.delete(id);
      this._segmentCache.delete(id);
      this.segmentMeta.delete(id);
    }
    this.segmentIndex.set(merged.id, fileName);
    this._segmentCache.set(merged.id, merged);
    return merged.id;
  }

  timeline(interval: number | string, period: [number, number] | string): TimelineBucket[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');

    let int: number;
    if (typeof interval === 'string') int = Interval.parseInterval(interval);
    else if (typeof interval !== 'number' || !Number.isFinite(interval)) throw ErrorManager.make('JRN_TL_INTERVAL');
    else int = interval;
    if (int <= 0) throw ErrorManager.make('JRN_TL_INTERVAL_POS');

    let start: number;
    let end: number;
    if (typeof period === 'string') [start, end] = Interval.period(period);
    else if (!Array.isArray(period) || period.length < 2) throw ErrorManager.make('JRN_TL_PERIOD');
    else [start, end] = Interval.period(period[0], period[1]);
    if (end === start) return [];

    const n = Math.ceil((end - start) / int);
    const counts = new Array<number>(n).fill(0);

    const bin = (ts: number): void => {
      if (ts < start || ts >= end) return;
      counts[Math.floor((ts - start) / int)]++;
    };

    for (const id of this._sortedClosedIds()) {
      const meta = this.segmentMeta.get(id);
      if (meta && meta.minTs !== null && meta.maxTs !== null) {
        if (meta.maxTs < start || meta.minTs >= end) continue;
      }
      const seg = this._loadClosedSegment(id);
      for (let i = 0; i < seg.rowCount; i++) {
        const ts = seg.get('ts', i);
        if (typeof ts === 'number') bin(ts);
      }
    }

    const active = this.activeSegment;
    if (active) {
      for (let i = 0; i < active.rowCount; i++) {
        const ts = active.get('ts', i);
        if (typeof ts === 'number') bin(ts);
      }
    }

    const buckets: TimelineBucket[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const bStart = start + i * int;
      buckets[i] = { start: bStart, end: Math.min(bStart + int, end), count: counts[i], hasData: counts[i] > 0 };
    }
    return buckets;
  }

  // --- Aggregations (Phase 1) ---

  aggregate(startTs: number | string, endTs: number | string, exprs: AggregateExpr[]): Record<string, number | null> {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    if (!Array.isArray(exprs) || exprs.length === 0) throw ErrorManager.make('JRN_AGG_EXPRS');
    for (const e of exprs) {
      if (!e || typeof e.field !== 'string' || e.field.length === 0) throw ErrorManager.make('JRN_AGG_FIELD');
      if (!isAggFn(e.fn)) throw ErrorManager.make('JRN_AGG_FN', { fn: String(e.fn) });
    }

    const [start, end] = Interval.period(startTs, endTs);
    const fields: string[] = [...new Set(exprs.map(e => e.field))];
    const accs: Record<string, AggAcc> = {};
    for (const f of fields) accs[f] = newAcc();

    for (const id of this._sortedClosedIds()) {
      const meta = this.segmentMeta.get(id);
      const minTs = meta?.minTs ?? null;
      const maxTs = meta?.maxTs ?? null;
      const summaries = meta?.summaries ?? null;

      if (minTs !== null && maxTs !== null && (maxTs < start || minTs > end)) continue;

      if (minTs !== null && maxTs !== null && minTs >= start && maxTs <= end && summaries) {
        let slow: string[] = [];
        for (const f of fields) {
          const s = summaries[f];
          if (s) addSummary(accs[f], s);
          else slow.push(f);
        }
        if (slow.length > 0) this._scanAggregate(this._loadClosedSegment(id), start, end, slow, accs);
        continue;
      }

      const seg = this._loadClosedSegment(id);
      this._scanAggregate(seg, start, end, fields, accs);
    }

    const active = this.activeSegment;
    if (active && active.rowCount > 0) this._aggregateActive(active, start, end, fields, accs);

    return this._buildResult(exprs, accs);
  }

  percentile(startTs: number | string, endTs: number | string, field: string, levels: number | number[]): Record<string, number | null> {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    if (typeof field !== 'string' || field.length === 0) throw ErrorManager.make('JRN_PCTL_FIELD');
    const lv = Array.isArray(levels) ? levels.slice() : [levels];
    for (const q of lv) {
      if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0 || q >= 1) throw ErrorManager.make('JRN_PCTL_LEVEL', { level: String(q) });
    }
    const [start, end] = Interval.period(startTs, endTs);

    const rows = this.scan({ start, end, select: [field] });
    const vals: number[] = [];
    for (const r of rows) {
      const v = r[field];
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    vals.sort((a, b) => a - b);

    const out: Record<string, number | null> = {};
    for (const q of lv) out[Percentile.key(q)] = vals.length === 0 ? null : Percentile.of(vals, q);
    return out;
  }

  downsample(startTs: number | string, endTs: number | string, bucketMs: number | string, field: string, fns: AggFn[]): DownsampleBucket[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    if (typeof field !== 'string' || field.length === 0) throw ErrorManager.make('JRN_DS_FIELD');
    if (!Array.isArray(fns) || fns.length === 0) throw ErrorManager.make('JRN_DS_FNS');
    for (const fn of fns) {
      if (!isAggFn(fn)) throw ErrorManager.make('JRN_DS_FN', { fn: String(fn) });
    }

    let bucket: number;
    if (typeof bucketMs === 'string') bucket = Interval.parseInterval(bucketMs);
    else if (typeof bucketMs !== 'number' || !Number.isFinite(bucketMs)) throw ErrorManager.make('JRN_DS_BUCKET');
    else bucket = bucketMs;
    if (bucket <= 0) throw ErrorManager.make('JRN_DS_BUCKET_POS');

    const [start, end] = Interval.period(startTs, endTs);
    if (end === start) return [];

    const first = Interval.roundTime(start, bucket);
    const n = Math.max(1, Math.ceil((end - first) / bucket));
    const accs: AggAcc[] = new Array(n);
    for (let i = 0; i < n; i++) accs[i] = newAcc();

    const bin = (ts: number): number => {
      let idx = Math.floor((ts - first) / bucket);
      if (idx < 0) idx = 0;
      if (idx >= n) idx = n - 1;
      return idx;
    };

    const processSegment = (seg: Segment): void => {
      if (seg.minTs !== null && seg.maxTs !== null && (seg.maxTs < start || seg.minTs >= end)) return;
      for (let i = 0; i < seg.rowCount; i++) {
        const ts = seg.get('ts', i);
        if (typeof ts !== 'number' || ts < start || ts >= end) continue;
        const v = seg.get(field, i);
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        addValue(accs[bin(ts)], v);
      }
    };

    for (const id of this._sortedClosedIds()) {
      const meta = this.segmentMeta.get(id);
      if (meta && meta.minTs !== null && meta.maxTs !== null && (meta.maxTs < start || meta.minTs >= end)) continue;
      processSegment(this._loadClosedSegment(id));
    }

    const active = this.activeSegment;
    if (active && active.rowCount > 0) processSegment(active);

    const buckets: DownsampleBucket[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const acc = accs[i];
      const bStart = first + i * bucket;
      const bucketObj: Record<string, unknown> = { start: Math.max(bStart, start), end: Math.min(bStart + bucket, end), count: acc.count, hasData: acc.count > 0 };
      for (const fn of fns) {
        let value: number | null;
        switch (fn) {
          case 'count': value = acc.count; break;
          case 'sum':   value = acc.count > 0 ? acc.sum : null; break;
          case 'min':   value = acc.count > 0 ? acc.min : null; break;
          case 'max':   value = acc.count > 0 ? acc.max : null; break;
          case 'avg':   value = acc.count > 0 ? acc.sum / acc.count : null; break;
        }
        bucketObj[fn] = value;
      }
      buckets[i] = bucketObj as unknown as DownsampleBucket;
    }
    return buckets;
  }

  // --- Vectorized Scan (Phase 3) ---

  scan(opts: ScanOptions): Row[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    const plan = this._compileScan(opts);

    const groups = new Map<string, { row: Row; accs: Record<string, AggAcc> }>();
    let rawRows: Row[] | null = null;
    if (!plan.agg) rawRows = [];

    const rawNeed = plan.limit !== null ? plan.offset + plan.limit : Infinity;
    const canEarlyStop = !plan.agg && plan.order === 1;

    const getGroup = (key: string, row: Row): { row: Row; accs: Record<string, AggAcc> } => {
      let g = groups.get(key);
      if (!g) {
        const accs: Record<string, AggAcc> = {};
        for (const spec of plan.aggSpec) accs[spec.field] = newAcc();
        g = { row, accs };
        groups.set(key, g);
      }
      return g;
    };

    const processSegment = (seg: Segment): void => {
      if (plan.start !== null && plan.end !== null && seg.minTs !== null && seg.maxTs !== null && (seg.maxTs < plan.start || seg.minTs > plan.end)) return;

      if (plan.agg && plan.where.length === 0 && plan.groupBy.length === 0 && plan.start !== null && plan.end !== null && seg.minTs !== null && seg.maxTs !== null && seg.minTs >= plan.start && seg.maxTs <= plan.end) {
        let slow: string[] = [];
        for (const spec of plan.aggSpec) {
          const s = seg.summaries[spec.field];
          if (s && s.count > 0) {
            const acc = groups.get('')!.accs[spec.field];
            addSummary(acc, s);
          } else {
            slow.push(spec.field);
          }
        }
        if (slow.length > 0) this._scanAggregate(seg, plan.start!, plan.end!, slow, groups.get('')!.accs);
        return;
      }

      const rowMap = seg.rowMap;
      const n = seg.rowCount;
      const cols: Record<string, Column | undefined> = {};
      const fieldsNeeded = new Set<string>();
      if (plan.hasTsFilter) fieldsNeeded.add('ts');
      for (const c of plan.where) fieldsNeeded.add(c.field);
      if (plan.agg) {
        for (const a of plan.aggSpec) fieldsNeeded.add(a.field);
        for (const g of plan.groupBy) fieldsNeeded.add(g);
      } else {
        for (const f of plan.select) fieldsNeeded.add(f);
      }
      for (const f of fieldsNeeded) cols[f] = seg.columns[f];

      const tsCol = plan.hasTsFilter ? cols['ts'] : null;
      const conds = plan.where;
      const nc = conds.length;
      const start = plan.start;
      const end = plan.end;

      if (plan.agg) {
        const gb = plan.groupBy;
        const ngb = gb.length;
        const spec = plan.aggSpec;
        for (let li = 0; li < n; li++) {
          const pi = rowMap[li];
          if (tsCol) {
            const ts = tsCol.get(pi);
            if (typeof ts !== 'number') continue;
            if (start !== null && ts < start) continue;
            if (end !== null && ts > end) continue;
          }
          let pass = true;
          for (let ci = 0; ci < nc; ci++) {
            const c = conds[ci];
            const col = cols[c.field];
            const v = col ? col.get(pi) : null;
            if (!whereOne(v, c.op, c.value)) { pass = false; break; }
          }
          if (!pass) continue;

          let key: string;
          let grow: Row = {};
          if (ngb === 0) {
            key = '';
          } else if (ngb === 1) {
            const gcol = cols[gb[0]];
            const gv = gcol ? gcol.get(pi) : null;
            key = keyOf(gv);
            grow = { [gb[0]]: gv };
          } else {
            grow = {};
            let kk = '';
            for (let gi = 0; gi < ngb; gi++) {
              const gcol = cols[gb[gi]];
              const gv = gcol ? gcol.get(pi) : null;
              grow[gb[gi]] = gv;
              kk += (gi ? '\u0000' : '') + keyOf(gv);
            }
            key = kk;
          }

          const g = key === '' ? (groups.has('') ? groups.get('')! : getGroup('', {})) : getGroup(key, grow);
          for (let si = 0; si < spec.length; si++) {
            const f = spec[si].field;
            const col = cols[f];
            const v = col ? col.get(pi) : null;
            if (typeof v === 'number' && Number.isFinite(v)) addValue(g.accs[f], v);
          }
        }
      } else {
        const sel = plan.select;
        const nsel = sel.length;
        for (let li = 0; li < n; li++) {
          const pi = rowMap[li];
          if (tsCol) {
            const ts = tsCol.get(pi);
            if (typeof ts !== 'number') continue;
            if (start !== null && ts < start) continue;
            if (end !== null && ts > end) continue;
          }
          let pass = true;
          for (let ci = 0; ci < nc; ci++) {
            const c = conds[ci];
            const col = cols[c.field];
            const v = col ? col.get(pi) : null;
            if (!whereOne(v, c.op, c.value)) { pass = false; break; }
          }
          if (!pass) continue;

          const row: Row = {};
          for (let si = 0; si < nsel; si++) {
            const f = sel[si];
            const col = cols[f];
            row[f] = col ? col.get(pi) : null;
          }
          rawRows!.push(row);
          if (canEarlyStop && rawRows!.length >= rawNeed) return;
        }
      }
    };

    if (plan.agg && plan.groupBy.length === 0) getGroup('', {});

    for (const id of this._sortedClosedIds()) {
      const meta = this.segmentMeta.get(id);
      if (meta && meta.minTs !== null && meta.maxTs !== null && plan.start !== null && plan.end !== null && (meta.maxTs < plan.start || meta.minTs > plan.end)) continue;
      processSegment(this._loadClosedSegment(id));
      if (canEarlyStop && rawRows!.length >= rawNeed) break;
    }

    const active = this.activeSegment;
    if (active && active.rowCount > 0) processSegment(active);

    if (plan.agg) {
      const out: Row[] = [];
      for (const g of groups.values()) {
        const row: Row = { ...g.row };
        for (const spec of plan.aggSpec) {
          const acc = g.accs[spec.field];
          for (const fn of spec.fns) row[`${spec.field}_${fn}`] = aggValue(acc, fn);
        }
        out.push(row);
      }
      if (out.length > 1) {
        const key = plan.aggKeys[0];
        out.sort((a, b) => {
          const av = a[key], bv = b[key];
          if (av === bv) return 0;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          return (av < bv ? -1 : 1) * plan.order;
        });
      }
      const from = plan.offset;
      const to = plan.limit !== null ? from + plan.limit : out.length;
      return out.slice(from, to);
    }

    if (rawRows!.length > 1) {
      const key = plan.sortKey;
      rawRows!.sort((a, b) => {
        const av = a[key], bv = b[key];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : 1) * plan.order;
      });
    }
    const from = plan.offset;
    const to = plan.limit !== null ? from + plan.limit : rawRows!.length;
    return rawRows!.slice(from, to);
  }

  private _compileScan(opts: ScanOptions): ScanPlan {
    const start = opts.start !== undefined ? Interval.resolve(opts.start) : null;
    const end = opts.end !== undefined ? Interval.resolve(opts.end) : null;
    if (start !== null && end !== null && end < start) throw ErrorManager.make('JRN_SCAN_RANGE');

       const where: { field: string; op: ScanOp; value: JsonValue }[] = [];
    if (opts.where) {
      for (const w of opts.where) {
        if (!w || typeof w.field !== 'string' || w.field.length === 0) throw ErrorManager.make('JRN_SCAN_WHERE_FIELD');
        if (!isScanOp(w.op)) throw ErrorManager.make('JRN_SCAN_WHERE_OP', { op: String(w.op), allowed: SCAN_OPS.join('|') });
        if ((w.op === 'in' || w.op === 'nin') && !Array.isArray(w.value)) throw ErrorManager.make('JRN_SCAN_WHERE_IN');
        where.push({ field: w.field, op: w.op, value: w.value ?? null });
      }
    }

    const agg: boolean = opts.agg !== undefined && Object.keys(opts.agg).length > 0;
    const aggSpec: { field: string; fns: AggFn[] }[] = [];
    const aggKeys: string[] = [];
    if (agg) {
      for (const [field, fns] of Object.entries(opts.agg!)) {
        if (typeof field !== 'string' || field.length === 0) throw ErrorManager.make('JRN_SCAN_AGG_FIELD');
        if (!Array.isArray(fns) || fns.length === 0) throw ErrorManager.make('JRN_SCAN_AGG_FNS');
        for (const fn of fns) {
          if (!isAggFn(fn)) throw ErrorManager.make('JRN_SCAN_AGG_FN', { fn: String(fn) });
        }
        aggSpec.push({ field, fns });
        for (const fn of fns) aggKeys.push(`${field}_${fn}`);
      }
    }

    let groupBy: string[] = [];
    if (opts.groupBy !== undefined) {
      if (!agg) throw ErrorManager.make('JRN_SCAN_GROUPBY_AGG');
      const gb = Array.isArray(opts.groupBy) ? opts.groupBy : [opts.groupBy];
      for (const g of gb) {
        if (typeof g !== 'string' || g.length === 0) throw ErrorManager.make('JRN_SCAN_GROUPBY');
      }
      groupBy = gb;
    }

    let select: string[];
    if (!agg) {
      select = opts.select && opts.select.length > 0 ? [...opts.select] : (this.schema ? Object.keys(this.schema) : []);
      if (select.length === 0) throw ErrorManager.make('JRN_SCAN_SELECT');
      for (const f of select) {
        if (typeof f !== 'string' || f.length === 0) throw ErrorManager.make('JRN_SCAN_SELECT_FIELD');
      }
    } else {
      select = [];
    }

    const order = opts.order ?? (agg ? 'desc' : 'asc');
    if (order !== 'asc' && order !== 'desc') throw ErrorManager.make('JRN_SCAN_ORDER');
    const orderSign: 1 | -1 = order === 'asc' ? 1 : -1;

    let limit: number | null = null;
    if (opts.limit !== undefined) {
      if (!Number.isInteger(opts.limit) || opts.limit < 0) throw ErrorManager.make('JRN_SCAN_LIMIT');
      limit = opts.limit;
    }
    const offset = opts.offset !== undefined ? (Number.isInteger(opts.offset) && opts.offset >= 0 ? opts.offset : (() => { throw ErrorManager.make('JRN_SCAN_OFFSET'); })()) : 0;

    const hasTsFilter = start !== null || end !== null;
    const sortKey = agg ? aggKeys[0] : (select.includes('ts') ? 'ts' : select[0]);

    return { start, end, where, hasTsFilter, groupBy, agg, aggSpec, aggKeys, select, order: orderSign, limit, offset, sortKey };
  }

  // --- Reading ---

  getTimeRange(): [number, number] | null {
    let min = Infinity;
    let max = -Infinity;
    const consider = (minTs: number | null, maxTs: number | null): void => {
      if (minTs !== null && minTs < min) min = minTs;
      if (maxTs !== null && maxTs > max) max = maxTs;
    };

    const ids = [...this.segmentIndex.keys()];
    if (ids.length === 0 || ids.every(id => this.segmentMeta.has(id))) {
      for (const id of ids) {
        const m = this.segmentMeta.get(id)!;
        consider(m.minTs, m.maxTs);
      }
      const active = this.activeSegment;
      if (active && active.rowCount > 0) consider(active.minTs, active.maxTs);
    } else {
      for (const seg of this.allSegments()) consider(seg.minTs, seg.maxTs);
    }

    if (min === Infinity) return null;
    return [min, max];
  }

  getMarks(): number[] {
    const marks: number[] = [];
    for (const seg of this.allSegments()) {
      const tsCol = seg.columns['ts'];
      if (!tsCol) continue;
      for (let i = 0; i < seg.rowCount; i++) {
        const v = seg.get('ts', i);
        if (typeof v === 'number') marks.push(v);
      }
    }
    return marks.sort((a, b) => a - b);
  }

  query(startTime: number | string, endTime: number | string): Row[] {
    const [start, end] = Interval.period(startTime, endTime);
    const results: Row[] = [];

    for (const id of this._sortedClosedIds()) {
      const meta = this.segmentMeta.get(id);
      if (meta && meta.minTs !== null && meta.maxTs !== null) {
        if (meta.maxTs < start || meta.minTs > end) continue;
      }
      const seg = this._loadClosedSegment(id);
      if (seg.minTs !== null && seg.maxTs !== null) {
        if (seg.maxTs < start || seg.minTs > end) continue;
      }
      for (let i = 0; i < seg.rowCount; i++) {
        const ts = seg.get('ts', i);
        if (typeof ts === 'number' && ts >= start && ts <= end) results.push(this._normalizeRow(seg.getRow(i)));
      }
    }

    const active = this.activeSegment;
    if (active && active.rowCount > 0) {
      for (let i = 0; i < active.rowCount; i++) {
        const ts = active.get('ts', i);
        if (typeof ts === 'number' && ts >= start && ts <= end) results.push(this._normalizeRow(active.getRow(i)));
      }
    }
    return results;
  }

  allRows(): Row[] {
    const results: Row[] = [];
    for (const seg of this.allSegments()) {
      for (let i = 0; i < seg.rowCount; i++) results.push(this._normalizeRow(seg.getRow(i)));
    }
    return results;
  }

  tail(count: number): Row[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    if (count <= 0) return [];

    const takeFromSegment = (seg: Segment, n: number): Row[] => {
      const rows: Row[] = [];
      for (let i = seg.rowCount - n; i < seg.rowCount; i++) rows.push(this._normalizeRow(seg.getRow(i)));
      return rows;
    };

    let result: Row[] = [];
    const active = this.activeSegment;
    if (active && active.rowCount > 0) result = takeFromSegment(active, Math.min(count, active.rowCount));

    if (result.length < count) {
      for (const id of this._sortedClosedIds().reverse()) {
        if (result.length >= count) break;
        const seg = this._loadClosedSegment(id);
        const chunk = takeFromSegment(seg, Math.min(count - result.length, seg.rowCount));
        result = [...chunk, ...result];
      }
    }
    return result;
  }

  page(limit: number, offset = 0, order: 'asc' | 'desc' = 'asc'): Row[] {
    if (!this.isOpen) throw ErrorManager.make('JRN_NOT_OPEN');
    if (!Number.isInteger(limit) || limit < 1) return [];
    let skip = Number.isInteger(offset) && offset > 0 ? offset : 0;

    const result: Row[] = [];
    const closedIds = this._sortedClosedIds();

    const takeFrom = (seg: Segment): void => {
      if (result.length >= limit) return;
      const r = seg.rowCount;
      if (r === 0) return;
      if (skip >= r) {
        skip -= r;
        return;
      }
      const k = Math.min(limit - result.length, r - skip);
      if (order === 'asc') {
        for (let i = skip; i < skip + k; i++) result.push(this._normalizeRow(seg.getRow(i)));
      } else {
        const startIdx = r - 1 - skip;
        for (let i = 0; i < k; i++) result.push(this._normalizeRow(seg.getRow(startIdx - i)));
      }
      skip = 0;
    };

    if (order === 'asc') {
      for (const id of closedIds) {
        const meta = this.segmentMeta.get(id);
        if (meta && skip >= meta.rowCount) {
          skip -= meta.rowCount;
          continue;
        }
        takeFrom(this._loadClosedSegment(id));
      }
      if (this.activeSegment) takeFrom(this.activeSegment);
    } else {
      if (this.activeSegment) takeFrom(this.activeSegment);
      for (const id of closedIds.reverse()) {
        const meta = this.segmentMeta.get(id);
        if (meta && skip >= meta.rowCount) {
          skip -= meta.rowCount;
          continue;
        }
        takeFrom(this._loadClosedSegment(id));
      }
    }
    return result;
  }

  private _normalizeRow(row: Row): Row {
    if (!this.schema) return row;
    for (const f of Object.keys(this.schema)) {
      if (!(f in row)) row[f] = null;
    }
    return row;
  }

  getMetadata(): Metadata {
    return { ...this.metadata };
  }

  updateMetadata(newMetadata: Metadata): void {
    this.metadata = { ...this.metadata, ...newMetadata };
    if (this.activeSegment) this.activeSegment.metadata = { ...this.metadata };
  }

  stats(): JournalStats {
    const ids = [...this.segmentIndex.keys()];
    let segmentCount = ids.length;
    let totalRows = 0;
    let totalPhysical = 0;

    if (ids.every(id => this.segmentMeta.has(id))) {
      for (const id of ids) {
        const m = this.segmentMeta.get(id)!;
        totalRows += m.rowCount;
        totalPhysical += m.physicalRowCount || m.rowCount;
      }
    } else {
      for (const seg of this._loadAllClosed()) {
        totalRows += seg.rowCount;
        totalPhysical += seg.physicalRowCount || seg.rowCount;
      }
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

  // --- Internal methods ---

  journalPath(): string {
    return path.join(this.journalsDir, this.name!);
  }

  private _createNewActiveSegment(): void {
    const id = `seg_${Date.now()}_${this.segmentCounter++}_${this._idNonce}`;
    this.activeSegment = new Segment(id, this.schema!, this.metadata ?? {});
  }

  private _loadClosedSegment(id: string): Segment {
    const cached = this._segmentCache.get(id);
    if (cached) return cached;

    const fileName = this.segmentIndex.get(id);
    if (!fileName) throw ErrorManager.make('JRN_SEG_UNKNOWN', { id });

    let seg: Segment;
    try {
      const buf = fs.readFileSync(path.join(this.journalPath(), fileName));
      seg = SegmentFile.read(buf);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw ErrorManager.make('JRN_SEG_READ', { file: fileName, message: String(message) });
    }
    this.segmentMeta.set(id, {
      minTs: seg.minTs,
      maxTs: seg.maxTs,
      rowCount: seg.rowCount,
      physicalRowCount: seg.physicalRowCount || seg.rowCount,
      tsCount: seg.tsCount,
      summaries: seg.summaries
    });
    this._segmentCache.set(id, seg);
    return seg;
  }

  private _loadAllClosed(): Segment[] {
    return this._sortedClosedIds().map(id => this._loadClosedSegment(id));
  }

  allSegments(): Segment[] {
    const segments = this._loadAllClosed();
    if (this.activeSegment && this.activeSegment.rowCount > 0) segments.push(this.activeSegment);
    return segments;
  }

  // --- Aggregations (internal) ---

  private _scanAggregate(seg: Segment, start: number, end: number, fields: string[], accs: Record<string, AggAcc>): void {
    if (fields.length === 0) return;
    for (let i = 0; i < seg.rowCount; i++) {
      const ts = seg.get('ts', i);
      if (typeof ts !== 'number' || ts < start || ts > end) continue;
      for (const f of fields) {
        const v = seg.get(f, i);
        if (typeof v === 'number' && Number.isFinite(v)) addValue(accs[f], v);
      }
    }
  }

  private _aggregateActive(seg: Segment, start: number, end: number, fields: string[], accs: Record<string, AggAcc>): void {
    const minTs = seg.minTs;
    const maxTs = seg.maxTs;
    if (minTs !== null && maxTs !== null && (maxTs < start || minTs > end)) return;
    if (minTs !== null && maxTs !== null && minTs >= start && maxTs <= end) {
      let slow: string[] = [];
      for (const f of fields) {
        const s = seg.summaries[f];
        if (s) addSummary(accs[f], s);
        else slow.push(f);
      }
      if (slow.length > 0) this._scanAggregate(seg, start, end, slow, accs);
      return;
    }
    this._scanAggregate(seg, start, end, fields, accs);
  }

  private _buildResult(exprs: AggregateExpr[], accs: Record<string, AggAcc>): Record<string, number | null> {
    const result: Record<string, number | null> = {};
    for (const e of exprs) {
      const acc = accs[e.field];
      let value: number | null;
      switch (e.fn) {
        case 'count': value = acc.count; break;
        case 'sum':   value = acc.count > 0 ? acc.sum : null; break;
        case 'min':   value = acc.count > 0 ? acc.min : null; break;
        case 'max':   value = acc.count > 0 ? acc.max : null; break;
        case 'avg':   value = acc.count > 0 ? acc.sum / acc.count : null; break;
      }
      result[`${e.field}_${e.fn}`] = value;
    }
    return result;
  }

  private _writeMeta(seg: Segment, fileName: string): void {
    const meta: SegmentMeta = {
      minTs: seg.minTs,
      maxTs: seg.maxTs,
      rowCount: seg.rowCount,
      physicalRowCount: seg.physicalRowCount || seg.rowCount,
      tsCount: seg.tsCount,
      summaries: seg.summaries
    };
    this.segmentMeta.set(seg.id, meta);
    const metaPath = path.join(this.journalPath(), `${fileName}${META_SUFFIX}`);
    fs.writeFileSync(`${metaPath}.tmp`, JSON.stringify(meta));
    fs.renameSync(`${metaPath}.tmp`, metaPath);
  }

  private _sortedClosedIds(): string[] {
    const idKey = (id: string): [number, number, string] => {
      const m = id.match(/^seg_(\d+)_(\d+)_(.+)$/);
      return m ? [Number(m[1]), Number(m[2]), m[3]] : [0, 0, id];
    };
    const minTsOf = (id: string): number => {
      const m = this.segmentMeta.get(id);
      return (m && typeof m.minTs === 'number') ? m.minTs : Number.MAX_SAFE_INTEGER;
    };
    return [...this.segmentIndex.keys()].sort((a, b) => {
      const ma = minTsOf(a), mb = minTsOf(b);
      if (ma !== mb) return ma - mb;
      const ka = idKey(a), kb = idKey(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
    });
  }

  // --- WAL (recovery of unflushed rows after crash) ---

  private _walPath(): string {
    return path.join(this.journalPath(), WAL_FILE);
  }

  _walDrain(): void {
    if (this._walBuf.length === 0) return;
    const chunk = this._walBuf.join('');
    this._walBuf = [];
    this._walBufBytes = 0;
    fs.appendFileSync(this._walPath(), chunk, 'utf-8');
  }

  private _truncateWAL(): void {
    fs.rmSync(this._walPath(), { force: true });
  }

  private _walRollbackLine(line: string): void {
    try {
      const p = this._walPath();
      const size = fs.statSync(p).size;
      const bytes = Buffer.byteLength(line, 'utf-8');
      if (size >= bytes) fs.truncateSync(p, size - bytes);
    } catch { /* WAL might have already been truncated */ }
  }

  private _replayWAL(): void {
    let content: string;
    try {
      content = fs.readFileSync(this._walPath(), 'utf-8');
    } catch {
      return;
    }

    const lines = content.split('\n').filter(l => l.length > 0);
    if (lines.length === 0) {
      this._truncateWAL();
      return;
    }

    for (const line of lines) {
      const row = JSON.parse(line) as Row;
      this._appendInMemory(row);
    }
    this._truncateWAL();
  }

  private _appendInMemory(row: Row): void {
    const seg = this.activeSegment!;
    seg.append(row);
    if (seg.rowCount >= this.rowsPerSegment) this.flush();
  }

  // --- Single-owner journal locking ---

  private _lockPath(): string {
    return path.join(this.journalPath(), LOCK_FILE);
  }

  private _acquireLock(): void {
    if (this.lockMode === 'off') return;
    const lockPath = this._lockPath();
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    let holderPid = -1;
    try {
      const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: number };
      if (typeof info.pid === 'number') holderPid = info.pid;
    } catch { /* Corrupted lockfile — consider stale */ }

    if (this._pidAlive(holderPid)) throw ErrorManager.make('JRN_LOCKED', { pid: holderPid, lockPath });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  }

  private _releaseLock(): void {
    if (this.lockMode === 'off') return;
    try {
      const info = JSON.parse(fs.readFileSync(this._lockPath(), 'utf-8')) as { pid?: number };
      if (info.pid === process.pid) fs.rmSync(this._lockPath(), { force: true });
    } catch { /* Lock already gone */ }
  }

  private _pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}