// ============================================================
// store.ts — Хранилище журналов с кэшем и ленивой загрузкой
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { Journal } from './journal.ts';
import { Segment } from './segment.ts';
import { LRUCache } from './cache.ts';
import { decodeSegment } from './codec.ts';
import type {
  Metadata,
  OpenJournalOptions,
  Schema,
  StoreOptions,
  StoreStats,
} from './types.ts';

export class Store {
  readonly baseDir: string;
  private readonly journalsDir: string;
  readonly maxCacheSize: number;
  readonly defaultRowsPerSegment: number;

  /** открытые журналы по имени */
  openJournals = new Map<string, Journal>();

  /** ключ «journal:segmentId» → Segment (LRU) */
  segmentCache: LRUCache<string, Segment>;

  constructor(baseDir: string, opts: StoreOptions = {}) {
    this.baseDir = baseDir;
    this.journalsDir = path.join(baseDir, 'journals');
    this.maxCacheSize = opts.maxCacheSize ?? 20;
    this.defaultRowsPerSegment = opts.defaultRowsPerSegment ?? 100;
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
      maxCachedSegments: opts.maxCachedSegments ?? this.maxCacheSize
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
        .filter(f => f.endsWith('.json'))
        .sort();

      if (files.length === 0) return null;

      const firstFile = path.join(journalPath, files[0]);
      const data = decodeSegment(fs.readFileSync(firstFile));

      return {
        name,
        segmentCount: files.length,
        ...data.metadata
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

    const segPath = path.join(this.journalsDir, journalName, `${segmentId}.json`);
    try {
      const data = decodeSegment(fs.readFileSync(segPath));
      const seg = Segment.deserialize(data);
      this.segmentCache.set(cacheKey, seg);
      return seg;
    } catch {
      return null;
    }
  }

  listSegments(journalName: string): string[] {
    const journalPath = path.join(this.journalsDir, journalName);
    try {
      const files = fs.readdirSync(journalPath)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => f.replace(/\.json$/, ''));
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
