// ============================================================
// store.ts — Хранилище журналов с кэшем и ленивой загрузкой
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { Journal, DEFAULT_ROWS_PER_SEGMENT } from './journal.ts';
import type { Segment } from './segment.ts';
import { LRUCache } from './cache.ts';
import { readSegment } from './v3.ts';
import type {
  CompressionMode,
  LockMode,
  Metadata,
  OpenJournalOptions,
  Schema,
  SegmentFormat,
  StoreOptions,
  StoreStats,
} from './types.ts';

const isSegmentFile = (f: string): boolean => f.endsWith('.seg') || f.endsWith('.json');
const idFromFile = (f: string): string =>
  f.endsWith('.seg') ? f.slice(0, -4) : f.endsWith('.json') ? f.slice(0, -5) : f;

export class Store {
  readonly baseDir: string;
  private readonly journalsDir: string;
  readonly maxCacheSize: number;
  readonly defaultRowsPerSegment: number;
  readonly lockMode: LockMode;
  readonly format: SegmentFormat;
  readonly compression: CompressionMode;
  readonly codecs: Record<string, string>;

  /** открытые журналы по имени */
  openJournals = new Map<string, Journal>();

  /** ключ «journal:segmentId» → Segment (LRU) */
  segmentCache: LRUCache<string, Segment>;

  constructor(baseDir: string, opts: StoreOptions = {}) {
    this.baseDir = baseDir;
    this.journalsDir = path.join(baseDir, 'journals');
    this.maxCacheSize = opts.maxCacheSize ?? 20;
    this.defaultRowsPerSegment = opts.defaultRowsPerSegment ?? DEFAULT_ROWS_PER_SEGMENT;
    const lock = opts.lock ?? 'pid';
    if (lock !== 'pid' && lock !== 'off') {
      throw new RangeError("Store: lock должно быть 'pid' или 'off'");
    }
    this.lockMode = lock;
    this.format = opts.format ?? 'v2';
    this.compression = opts.compression ?? 'gzip';
    this.codecs = opts.codecs && typeof opts.codecs === 'object' ? { ...opts.codecs } : {};
    this.segmentCache = new LRUCache<string, Segment>(this.maxCacheSize);
  }

  init(): void {
    fs.mkdirSync(this.journalsDir, { recursive: true });
  }

  // --------------------------------------------------
  // Управление журналами
  // --------------------------------------------------

  openJournal(name: string, schema: Schema, metadata: Metadata = {}, opts: OpenJournalOptions = {}): Journal {
    const existing = this.openJournals.get(name);
    if (existing) {
      return existing;
    }

    const journal = new Journal(this.baseDir, {
      rowsPerSegment: opts.rowsPerSegment ?? this.defaultRowsPerSegment,
      maxCachedSegments: opts.maxCachedSegments ?? this.maxCacheSize,
      lock: opts.lock ?? this.lockMode,
      format: opts.format ?? this.format,
      compression: opts.compression ?? this.compression,
      codecs: opts.codecs ?? this.codecs
    });

    journal.open(name, schema, metadata);
    this.openJournals.set(name, journal);

    return journal;
  }

  closeJournal(name: string): void {
    const journal = this.openJournals.get(name);
    if (!journal) {
      throw new Error(`Journal not found: ${name}`);
    }

    journal.close();
    this.openJournals.delete(name);
  }

  closeAll(): void {
    for (const name of [...this.openJournals.keys()]) {
      this.closeJournal(name);
    }
  }

  listJournals(): string[] {
    try {
      const items = fs.readdirSync(this.journalsDir, { withFileTypes: true });
      return items
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return [];
    }
  }

  getJournalMetadata(name: string): (Metadata & { name: string; segmentCount: number }) | null {
    const journalPath = path.join(this.journalsDir, name);
    try {
      const files = fs.readdirSync(journalPath)
        .filter(isSegmentFile)
        .sort();

      if (files.length === 0) return null;

      const firstFile = path.join(journalPath, files[0]);
      const seg = readSegment(fs.readFileSync(firstFile)); // v1/v2/v3

      return {
        name,
        segmentCount: files.length,
        ...seg.metadata
      };
    } catch {
      return null;
    }
  }

  // --------------------------------------------------
  // Ленивая загрузка сегментов
  // --------------------------------------------------

  loadSegment(journalName: string, segmentId: string): Segment | null {
    const cacheKey = `${journalName}:${segmentId}`;

    if (this.segmentCache.has(cacheKey)) {
      return this.segmentCache.get(cacheKey)!;
    }

    // Файл может быть .seg (v3) или .json (v1/v2) — пробуем оба
    const dir = path.join(this.journalsDir, journalName);
    for (const ext of ['.seg', '.json']) {
      const segPath = path.join(dir, `${segmentId}${ext}`);
      if (!fs.existsSync(segPath)) continue;
      try {
        const seg = readSegment(fs.readFileSync(segPath)); // v1/v2/v3
        this.segmentCache.set(cacheKey, seg);
        return seg;
      } catch {
        return null;
      }
    }
    return null;
  }

  listSegments(journalName: string): string[] {
    const journalPath = path.join(this.journalsDir, journalName);
    try {
      const files = fs.readdirSync(journalPath)
        .filter(isSegmentFile)
        .sort()
        .map(idFromFile);
      return files;
    } catch {
      return [];
    }
  }

  // --------------------------------------------------
  // Кэш сегментов (LRUCache)
  // --------------------------------------------------

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
