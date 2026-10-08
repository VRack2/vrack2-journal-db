// ============================================================
// store.ts — Хранилище журналов с кэшем и ленивой загрузкой
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { Journal, DEFAULT_ROWS_PER_SEGMENT, DEFAULT_COMPACT_MIN_SEGMENTS } from './journal.ts';
import type { Segment } from './segment.ts';
import { LRUCache } from './cache.ts';
import { readSegment, defaultCompression } from './v3.ts';
import { Table, openTable as createTable } from './table.ts';
import type {
  CompressionMode,
  LockMode,
  Metadata,
  OpenJournalOptions,
  Schema,
  SegmentFormat,
  StoreOptions,
  StoreStats,
  TableConfig,
} from './types.ts';
import { ENGINE_META_KEY, descriptorToMeta, engineDescriptorOf } from './engines/index.ts';
import type { AnyTableDef, EngineKind, TableDescription, TableRuntime } from './engines/index.ts';

const MANIFEST_FILE = '_store.json';
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
  readonly autoCompact: boolean;
  readonly compactMinSegments: number;

  /** открытые журналы по имени */
  openJournals = new Map<string, Journal>();

  /** открытые таблицы (мультитирные, Фаза 4) по имени */
  openTables = new Map<string, Table>();

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
    // zstd по умолчанию при Node >= 23.8 (Фаза 5); явный opts.compression — выше.
    this.compression = opts.compression ?? defaultCompression();
    this.codecs = opts.codecs && typeof opts.codecs === 'object' ? { ...opts.codecs } : {};
    this.autoCompact = opts.autoCompact ?? true;
    this.compactMinSegments = opts.compactMinSegments ?? DEFAULT_COMPACT_MIN_SEGMENTS;
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
      codecs: opts.codecs ?? this.codecs,
      autoCompact: opts.autoCompact ?? this.autoCompact,
      compactMinSegments: opts.compactMinSegments ?? this.compactMinSegments
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
    // Сначала таблицы (закрывают свои тиры-журналы), потом прочие журналы.
    for (const name of [...this.openTables.keys()]) {
      this.closeTable(name);
    }
    for (const name of [...this.openJournals.keys()]) {
      this.closeJournal(name);
    }
  }

  // --------------------------------------------------
  // Таблицы (мультитирные, Фаза 4) — GraphiteMergeTree
  // --------------------------------------------------

  /**
   * Открыть таблицу-метрик (несколько тиров разрешения, каждый — журнал
   * `<name>/r<res>`). Повторный вызов с тем же именем вернёт открытую таблицу.
   *
   * @example
   * const t = store.openTable('cpu', {
   *   retention: '5s:1d,15s:1w,1m:1mon',
   *   agg: { value: 'avg' },
   *   schema: { ts: 'delta', value: 'auto', host: 'dictionary' },
   * });
   * t.append({ ts: Date.now(), value: 42.3, host: 'web-1' });
   * t.query('now-30d', 'now');
   */
  openTable(name: string, config: TableConfig = {}): Table {
    const existing = this.openTables.get(name);
    if (existing) return existing;
    const t = createTable(this, name, config);
    this.openTables.set(name, t);
    return t;
  }

  /** Закрыть таблицу (и все её тиры-журналы). */
  closeTable(name: string): void {
    const t = this.openTables.get(name);
    if (!t) {
      throw new Error(`Table not found: ${name}`);
    }
    t.close();
    this.openTables.delete(name);
  }

  // --------------------------------------------------
  // Таблицы с движком (Phase 1): create/describe/tables/engineOf
  // --------------------------------------------------

  /**
   * Создать таблицу по описанию (define*Table) с нужным движком:
   * открывает журнал, записывает движок в его metadata и добавляет таблицу в
   * манифест `_store.json` (единственный самодостаточный артефакт — его можно
   * отдать коллеге/AI-агенту). Идемпотентно: повторный вызов для открытого
   * журнала возвращает его.
   */
  create(def: AnyTableDef): Journal {
    const desc = engineDescriptorOf(def);
    const metadata: Metadata = { [ENGINE_META_KEY]: descriptorToMeta(desc) };
    if (def.desc) {
      (metadata as Record<string, unknown>).desc = def.desc;
    }
    const journal = this.openJournal(def.name, def.columns, metadata, {
      rowsPerSegment: def.rowsPerSegment,
    });
    this._upsertManifest(def);
    return journal;
  }

  /**
   * Читаемое описание всех таблиц-движков: определение (из манифеста) +
   * рантайм-статистика (строки/сегменты/размер с диска). Для AI-агентов и
   * людей — «кто что делает» одним вызовом.
   */
  describe(): TableDescription[] {
    const manifest = this._readManifest();
    const out: TableDescription[] = [];
    for (const def of Object.values(manifest.tables)) {
      out.push({ ...def, ...this._tableRuntimeStats(def.name) } as TableDescription);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Имена таблиц-движков (из манифеста `_store.json`). */
  tables(): string[] {
    return Object.keys(this._readManifest().tables).sort();
  }

  /** Движок таблицы (из манифеста); undefined, если таблица не описана там. */
  engineOf(name: string): EngineKind | undefined {
    const def = this._readManifest().tables[name];
    return def ? def.kind : undefined;
  }

  // --------------------------------------------------
  // Манифест `_store.json` — самодостаточный артефакт хранилища
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
    const p = this._manifestPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, p);
  }

  /** Рантайм-статистика каталога журнала: строки, сегменты, размер (байт). */
  private _tableRuntimeStats(name: string): TableRuntime {
    const dir = path.join(this.journalsDir, name);
    let rows = 0;
    let bytes = 0;
    let segments = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!isSegmentFile(f)) continue;
        const full = path.join(dir, f);
        bytes += fs.statSync(full).size;
        segments++;
        try {
          rows += readSegment(fs.readFileSync(full)).rowCount; // v1/v2/v3
        } catch {
          // повреждённый/нечитаемый сегмент — не ломаем статистику
        }
      }
    } catch {
      // каталог отсутствует — статистика нулевая
    }
    return { rows, segments, sizeBytes: bytes };
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
