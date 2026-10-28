// Store.ts — Table storage: catalog, journal cache, lazy loading
//
// The only public entry points to tables:
//   store.create(def) → Table   // create a table (or return the open one)
//   store.open(name)  → Table   // reopen from the _store.json manifest
//
// Journals are internal machinery: Table opens N journals
// (one per tier) via store._openJournal(). The
// `_store.json` manifest is a self-contained storage artifact: it can be
// handed to a colleague/an AI agent. Old journals (not listed in the manifest)
// are reopened with a fallback schema from a segment (log table).

import fs from 'node:fs';
import path from 'node:path';
import { Journal, DEFAULT_ROWS_PER_SEGMENT, DEFAULT_COMPACT_MIN_SEGMENTS, isSegmentFile, idFromFile } from '../journal/Journal.ts';
import { META_SUFFIX, SEG_V3_EXT } from '../journal/constants.ts';
import { SegmentMeta } from '../journal/SegmentMeta.ts';
import type { Segment } from '../format/Segment.ts';
import { LRUCache } from '../core/LRUCache.ts';
import { SegmentFile } from '../format/SegmentFile.ts';
import { Compression } from '../core/Compression.ts';
import { AtomicJson } from '../core/AtomicJson.ts';
import { Table } from '../table/Table.ts';
import type {
  CompressionMode,
  LockMode,
  Metadata,
  OpenJournalOptions,
  Schema,
  StoreOptions,
  StoreStats,
  WalMode,
} from '../core/types.ts';
import { ENGINE_META_KEY } from '../compaction/Descriptor.ts';
import { engineDescriptorOf } from '../compaction/define.ts';
import type { AnyTableDef, LogTableDef, TableDescription, TableRuntime } from '../compaction/define.ts';
import type { EngineKind } from '../compaction/types.ts';
import ErrorManager from '../errors/ErrorManager.ts';

const MANIFEST_FILE = '_store.json';

ErrorManager.registerMany('Store', [
  { short: 'STO_LOCK', description: "Store: lock must be 'pid' or 'off'", rules: { lock: 'string' } },
  { short: 'STO_JOURNAL_NOT_FOUND', description: 'Store: journal not found in the open session', rules: { name: 'string' } },
  { short: 'STO_TABLE_NOT_FOUND', description: 'Store: table not found (not in the manifest and no segments on disk)', rules: { name: 'string' } },
]);

export class Store {
  readonly baseDir: string;
  private readonly journalsDir: string;
  readonly maxCacheSize: number;
  readonly defaultRowsPerSegment: number;
  readonly lockMode: LockMode;
  /** Default WAL strategy for journals (validated by the Journal constructor). */
  readonly walMode: WalMode;
  readonly compression: CompressionMode;
  readonly codecs: Record<string, string>;
  readonly autoCompact: boolean;
  readonly compactMinSegments: number;

  /** Open journals by name (internal; used by Table and tests). */
  openJournals = new Map<string, Journal>();

  /** Open tables by name (internal registry; closeAll() closes them). */
  openTables = new Map<string, Table>();

  /** Key "journal:segmentId" → Segment (LRU). */
  segmentCache: LRUCache<string, Segment>;

  constructor(baseDir: string, opts: StoreOptions = {}) {
    this.baseDir = baseDir;
    this.journalsDir = path.join(baseDir, 'journals');
    this.maxCacheSize = opts.maxCacheSize ?? 20;
    this.defaultRowsPerSegment = opts.defaultRowsPerSegment ?? DEFAULT_ROWS_PER_SEGMENT;
    const lock = opts.lock ?? 'pid';
    if (lock !== 'pid' && lock !== 'off') {
      throw ErrorManager.make('STO_LOCK', { lock: String(lock) });
    }
    this.lockMode = lock;
    this.walMode = opts.wal ?? 'off';
    // zstd by default on Node >= 23.8; an explicit opts.compression wins.
    this.compression = opts.compression ?? Compression.default();
    this.codecs = opts.codecs && typeof opts.codecs === 'object' ? { ...opts.codecs } : {};
    this.autoCompact = opts.autoCompact ?? true;
    this.compactMinSegments = opts.compactMinSegments ?? DEFAULT_COMPACT_MIN_SEGMENTS;
    this.segmentCache = new LRUCache<string, Segment>(this.maxCacheSize);
  }

  /** Storage directory (absolute). */
  path(): string {
    return this.baseDir;
  }

  /** Create the journals directory (no-op on repeated call); remove orphaned tmp files from crashed processes. */
  init(): void {
    fs.mkdirSync(this.journalsDir, { recursive: true });
    const dir = path.dirname(this._manifestPath());
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(MANIFEST_FILE + '.tmp.')) {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
      }
    } catch {}
  }

  // --------------------------------------------------
  // Journals — internal machinery (Table, tests)
  // --------------------------------------------------

  /** Open a journal (cached by name). Internal — use create/open. */
  _openJournal(
    name: string,
    schema: Schema,
    metadata: Metadata = {},
    opts: OpenJournalOptions = {},
  ): Journal {
    const existing = this.openJournals.get(name);
    if (existing) {
      return existing;
    }

    const journal = new Journal(this.baseDir, {
      rowsPerSegment: opts.rowsPerSegment ?? this.defaultRowsPerSegment,
      maxCachedSegments: opts.maxCachedSegments ?? this.maxCacheSize,
      lock: opts.lock ?? this.lockMode,
      wal: opts.wal ?? this.walMode,
      compression: opts.compression ?? this.compression,
      codecs: opts.codecs ?? this.codecs,
      autoCompact: opts.autoCompact ?? this.autoCompact,
      compactMinSegments: opts.compactMinSegments ?? this.compactMinSegments
    });

    journal.open(name, schema, metadata);
    this.openJournals.set(name, journal);

    return journal;
  }

  /** Close a journal. Internal. */
  _closeJournal(name: string): void {
    const journal = this.openJournals.get(name);
    if (!journal) {
      throw ErrorManager.make('STO_JOURNAL_NOT_FOUND', { name });
    }
    journal.close();
    this.openJournals.delete(name);
  }

  /** Close all tables (and their tier journals), then the other journals. */
  closeAll(): void {
    for (const [name, t] of [...this.openTables]) {
      t.close();
      this.openTables.delete(name);
    }
    for (const name of [...this.openJournals.keys()]) {
      this._closeJournal(name);
    }
  }

  // --------------------------------------------------
  // Tables — the only public entry points
  // --------------------------------------------------

  /**
    * Create a table from a description (define*Table): engine (def.kind) +
    * optional retention tiers. Idempotent: an open table with the same
    * name is returned. Described in the `_store.json` manifest.
   */
  create(def: AnyTableDef): Table {
    const existing = this.openTables.get(def.name);
    if (existing) {
      return existing;
    }
    const t = new Table(this, def.name, def);
    this.openTables.set(def.name, t);
    this._upsertManifest(def);
    return t;
  }

  /**
    * Reopen a table by name (from the `_store.json` manifest).
    * Not in the manifest — fallback: a log table with the schema from a segment.
   */
  open(name: string): Table {
    const existing = this.openTables.get(name);
    if (existing) {
      return existing;
    }
    const def = this._readManifest().tables[name] ?? this._defFromDisk(name);
    const t = new Table(this, name, def);
    this.openTables.set(name, t);
    return t;
  }

  /**
    * A readable description of all tables: definition (from the manifest) +
    * runtime stats (rows/segments/size from disk).
   */
  describe(): TableDescription[] {
    const manifest = this._readManifest();
    const out: TableDescription[] = [];
    for (const def of Object.values(manifest.tables)) {
      out.push({ ...def, ...this._tableRuntimeStats(def.name) } as TableDescription);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Table names (from the `_store.json` manifest). */
  tables(): string[] {
    return Object.keys(this._readManifest().tables).sort();
  }

  /** Table engine (from the manifest); undefined if the table is not described there. */
  engineOf(name: string): EngineKind | undefined {
    const def = this._readManifest().tables[name];
    return def ? def.kind : undefined;
  }

  // --------------------------------------------------
  // Manifest `_store.json` — a self-contained storage artifact
  // --------------------------------------------------

  private _manifestPath(): string {
    return path.join(this.baseDir, MANIFEST_FILE);
  }

  private _readManifest(): { version: number; tables: Record<string, AnyTableDef> } {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._manifestPath(), 'utf8')) as {
        version?: number;
        tables?: Record<string, AnyTableDef>;
      };
      return { version: parsed.version ?? 1, tables: parsed.tables ?? {} };
    } catch {
      return { version: 1, tables: {} };
    }
  }

  private _upsertManifest(def: AnyTableDef): void {
    const manifest = this._readManifest();
    manifest.version = 1;
    manifest.tables[def.name] = def;
    AtomicJson.write(this._manifestPath(), manifest, { mkdir: true, uniqueTmp: true, pretty: true });
  }

  /** Internal: rewrite an existing table's description in the manifest (Table.setCluster). */
  _updateDef(def: AnyTableDef): void {
    this._upsertManifest(def);
  }

  /**
    * Fallback description for a journal not in the manifest (old data):
    * a log table with the schema recovered from the first segment.
   */
  private _defFromDisk(name: string): LogTableDef {
    const dir = path.join(this.journalsDir, name);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(isSegmentFile).sort();
    } catch {
      files = [];
    }
    if (files.length === 0) {
      throw ErrorManager.make('STO_TABLE_NOT_FOUND', { name });
    }
    const seg = SegmentFile.read(fs.readFileSync(path.join(dir, files[0])));
    // Segment.schema carries the declared column types (the segment header
    // stores it) — no runtime class sniffing needed.
    return { kind: 'log', name, columns: { ...seg.schema } };
  }

  /** Runtime stats of the journal directories (including tiers `<name>/r*`). */
  private _tableRuntimeStats(name: string): TableRuntime {
    let rows = 0;
    let bytes = 0;
    let segments = 0;
    const dirs = new Set<string>([path.join(this.journalsDir, name)]);
    // table tiers: <name>/r* (top-level directory with subdirectories)
    try {
      const tableDir = path.join(this.journalsDir, name);
      for (const d of fs.readdirSync(tableDir, { withFileTypes: true })) {
        if (d.isDirectory() && d.name.startsWith('r')) {
          dirs.add(path.join(tableDir, d.name));
        }
      }
    } catch {
      // no top-level directory — look at <name> only
    }
    for (const dir of dirs) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!isSegmentFile(f)) continue;
          const full = path.join(dir, f);
          bytes += fs.statSync(full).size;
          segments++;
          rows += this._segmentRowCount(full);
        }
      } catch {
        // directory missing — stats are zero
      }
    }
    return { rows, segments, sizeBytes: bytes };
  }

  /**
   * Row count of a closed segment straight from its .meta sidecar; decodes the
   * segment file only when the sidecar is missing or corrupt.
   */
  private _segmentRowCount(segPath: string): number {
    try {
      const m = SegmentMeta.parse(JSON.parse(fs.readFileSync(`${segPath}${META_SUFFIX}`, 'utf-8')));
      if (m) return m.rowCount;
    } catch { /* no .meta — fall back to decoding the segment */ }
    try {
      return SegmentFile.read(fs.readFileSync(segPath)).rowCount;
    } catch {
      // corrupt/unreadable segment — do not break the stats
      return 0;
    }
  }

  // --------------------------------------------------
  // Journal introspection
  // --------------------------------------------------

  listJournals(): string[] {
    try {
      const items = fs.readdirSync(this.journalsDir, { withFileTypes: true });
      return items.filter(d => d.isDirectory()).map(d => d.name);
    } catch {
      return [];
    }
  }

  getJournalMetadata(name: string): (Metadata & { name: string; segmentCount: number }) | null {
    const journalPath = path.join(this.journalsDir, name);
    try {
      const files = fs.readdirSync(journalPath).filter(isSegmentFile).sort();
      if (files.length === 0) return null;
      const seg = SegmentFile.read(fs.readFileSync(path.join(journalPath, files[0])));
      return { name, segmentCount: files.length, ...seg.metadata };
    } catch {
      return null;
    }
  }

  // --------------------------------------------------
  // Lazy segment loading
  // --------------------------------------------------

  loadSegment(journalName: string, segmentId: string): Segment | null {
    const cacheKey = `${journalName}:${segmentId}`;
    const cached = this.segmentCache.get(cacheKey);
    if (cached) return cached;
    const segPath = path.join(this.journalsDir, journalName, `${segmentId}${SEG_V3_EXT}`);
    if (!fs.existsSync(segPath)) return null;
    try {
      const seg = SegmentFile.read(fs.readFileSync(segPath));
      this.segmentCache.set(cacheKey, seg);
      return seg;
    } catch {
      return null;
    }
  }

  listSegments(journalName: string): string[] {
    const journalPath = path.join(this.journalsDir, journalName);
    try {
      return fs.readdirSync(journalPath).filter(isSegmentFile).sort().map(idFromFile);
    } catch {
      return [];
    }
  }

  clearCache(): void {
    this.segmentCache.clear();
  }

  stats(): StoreStats {
    const journalNames = this.listJournals();
    let totalSegments = 0;
    for (const name of journalNames) {
      totalSegments += this.listSegments(name).length;
    }
    return {
      baseDir: this.baseDir,
      journalCount: journalNames.length,
      openJournalCount: this.openJournals.size,
      totalSegments,
      cacheSize: this.segmentCache.size,
      cacheMaxSize: this.maxCacheSize,
      journals: journalNames
    };
  }
}
