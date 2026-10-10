// ============================================================
// Store.ts — Хранилище таблиц: каталог, кэш журналов, ленивая загрузка
//
// Единственные публичные входы в таблицы:
//   store.create(def) → Table   // создать (или вернуть открытую) таблицу
//   store.open(name)  → Table   // переоткрыть по манифесту _store.json
//
// Журналы — внутренняя механика: Table открывает N журналов
// (по одному на тир) через store._openJournal(). Манифест
// `_store.json` — самодостаточный артефакт хранилища: его можно
// отдать коллеге/AI-агенту. Старые журналы (без записи в манифесте)
// переоткрываются с fallback-схемой из сегмента (log-таблица).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { Journal, DEFAULT_ROWS_PER_SEGMENT, DEFAULT_COMPACT_MIN_SEGMENTS } from './Journal.ts';
import type { Segment } from './Segment.ts';
import { LRUCache } from './LRUCache.ts';
import { SegmentFile } from './SegmentFile.ts';
import { Compression } from './Compression.ts';
import { ColumnFactory } from './columns/ColumnFactory.ts';
import { Table } from './Table.ts';
import type {
  ColumnType,
  CompressionMode,
  LockMode,
  Metadata,
  OpenJournalOptions,
  Schema,
  SegmentFormat,
  StoreOptions,
  StoreStats,
} from './types.ts';
import { ENGINE_META_KEY } from './compaction/Descriptor.ts';
import { engineDescriptorOf } from './compaction/define.ts';
import type { AnyTableDef, LogTableDef, TableDescription, TableRuntime } from './compaction/define.ts';
import type { EngineKind } from './compaction/types.ts';

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

  /** Открытые журналы по имени (внутреннее; используется Table и тестами). */
  openJournals = new Map<string, Journal>();

  /** Открытые таблицы по имени (внутренний реестр; closeAll() закрывает их). */
  openTables = new Map<string, Table>();

  /** Ключ «journal:segmentId» → Segment (LRU). */
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
    // zstd по умолчанию при Node >= 23.8; явный opts.compression — выше.
    this.compression = opts.compression ?? Compression.default();
    this.codecs = opts.codecs && typeof opts.codecs === 'object' ? { ...opts.codecs } : {};
    this.autoCompact = opts.autoCompact ?? true;
    this.compactMinSegments = opts.compactMinSegments ?? DEFAULT_COMPACT_MIN_SEGMENTS;
    this.segmentCache = new LRUCache<string, Segment>(this.maxCacheSize);
  }

  /** Каталог хранилища (абсолютный). */
  path(): string {
    return this.baseDir;
  }

  /** Создать каталог журнала (no-op при повторном вызове). */
  init(): void {
    fs.mkdirSync(this.journalsDir, { recursive: true });
  }

  // --------------------------------------------------
  // Журналы — внутренняя механика (Table, тесты)
  // --------------------------------------------------

  /** Открыть журнал (кэшировать по имени). Внутреннее — используйте create/open. */
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

  /** Закрыть журнал. Внутреннее. */
  _closeJournal(name: string): void {
    const journal = this.openJournals.get(name);
    if (!journal) {
      throw new Error(`Journal not found: ${name}`);
    }
    journal.close();
    this.openJournals.delete(name);
  }

  /** Закрыть все таблицы (и их тиры-журналы), затем прочие журналы. */
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
  // Таблицы — единственные публичные входы
  // --------------------------------------------------

  /**
   * Создать таблицу по описанию (define*Table): движок (def.kind) +
   * опциональные retention-тиры. Идемпотентно: открытая таблица с тем же
   * именем возвращается. Описывается в манифест `_store.json`.
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
   * Переоткрыть таблицу по имени (из манифеста `_store.json`).
   * Без записи в манифесте — fallback: log-таблица со схемой из сегмента.
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
   * Читаемое описание всех таблиц: определение (из манифеста) +
   * рантайм-статистика (строки/сегменты/размер с диска).
   */
  describe(): TableDescription[] {
    const manifest = this._readManifest();
    const out: TableDescription[] = [];
    for (const def of Object.values(manifest.tables)) {
      out.push({ ...def, ...this._tableRuntimeStats(def.name) } as TableDescription);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Имена таблиц (из манифеста `_store.json`). */
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

  /**
   * Fallback-описание для журнала без записи в манифесте (старые данные):
   * log-таблица со схемой, восстановленной из первого сегмента.
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
      throw new RangeError(`Store: таблица "${name}" не найдена (нет манифеста и сегментов)`);
    }
    const seg = SegmentFile.read(fs.readFileSync(path.join(dir, files[0])));
    const columns: Schema = {};
    for (const [f, col] of Object.entries(seg.columns)) {
      columns[f] = this._typeOfColumn(col);
    }
    return { kind: 'log', name, columns };
  }

  private _typeOfColumn(col: unknown): ColumnType {
    for (const [t, C] of Object.entries(ColumnFactory.types)) {
      if (col instanceof C) return t as ColumnType;
    }
    return 'auto';
  }

  /** Рантайм-статистика каталогов журнала (включая тиры `<name>/r*`). */
  private _tableRuntimeStats(name: string): TableRuntime {
    let rows = 0;
    let bytes = 0;
    let segments = 0;
    const dirs = new Set<string>([path.join(this.journalsDir, name)]);
    // тиры таблицы: <name>/r* (каталог верхнего уровня с подкаталогами)
    try {
      const tableDir = path.join(this.journalsDir, name);
      for (const d of fs.readdirSync(tableDir, { withFileTypes: true })) {
        if (d.isDirectory() && d.name.startsWith('r')) {
          dirs.add(path.join(tableDir, d.name));
        }
      }
    } catch {
      // верхнего каталога нет — смотрим только <name>
    }
    for (const dir of dirs) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!isSegmentFile(f)) continue;
          const full = path.join(dir, f);
          bytes += fs.statSync(full).size;
          segments++;
          try {
            rows += SegmentFile.read(fs.readFileSync(full)).rowCount;
          } catch {
            // повреждённый/нечитаемый сегмент — не ломаем статистику
          }
        }
      } catch {
        // каталог отсутствует — статистика нулевая
      }
    }
    return { rows, segments, sizeBytes: bytes };
  }

  // --------------------------------------------------
  // Интроспекция журналов
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
        const seg = SegmentFile.read(fs.readFileSync(segPath));
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

// Реэкспорт — чтобы Store мог быть использован в типах Table без циклического импорта.
export { ENGINE_META_KEY };
