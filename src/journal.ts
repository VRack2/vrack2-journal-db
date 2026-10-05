// ============================================================
// journal.ts — Журнал событий
// Закрытые сегменты грузятся с диска лениво (по требованию),
// кэшируются в LRU. Активный сегмент живёт в памяти до flush.
//
// Надёжность:
//  - WAL (wal.log): строки пишутся в WAL пачками (walBatchSize), буфер
//    гарантированно сбрасывается на диск при flush/close/выходе процесса,
//    при открытии после краха восстанавливается;
//  - lockfile (.lock): один владелец журнала, устаревшие блокировки
//    (мёртвый PID) забираются автоматически;
//  - файлы сегментов v2: gzip + CRC32 (см. codec.ts); рядом лежит маленький
//    сайдкар <файл>.meta с minTs/maxTs/счётчиками — позволяет пропускать
//    чужие по времени файлы при query/stats без их разжатия.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { Segment } from './segment.ts';
import { LRUCache } from './cache.ts';
import { encodeSegment } from './codec.ts';
import { encodeV3, readSegment } from './v3.ts';
import { Interval } from './interval.ts';
import type {
  AggregateExpr,
  AggFn,
  ColumnSummary,
  CompactResult,
  CompressionMode,
  DownsampleBucket,
  JournalOptions,
  JournalStats,
  LockMode,
  Metadata,
  PurgeResult,
  Row,
  Schema,
  SegmentFormat,
  TimelineBucket,
} from './types.ts';

const LOCK_FILE = '.lock';
const WAL_FILE = 'wal.log';
const META_SUFFIX = '.meta';

// Расширения файлов сегментов: v1/v2 → .json, v3 → .seg. Чтение прозрачное
// (по магическим байтам), расширение — только для записи и индекса.
const SEG_V3_EXT = '.seg';
const SEG_V2_EXT = '.json';
const isSegmentFile = (f: string): boolean =>
  f.endsWith(SEG_V3_EXT) || f.endsWith(SEG_V2_EXT);
const idFromFile = (f: string): string =>
  f.endsWith(SEG_V3_EXT) ? f.slice(0, -SEG_V3_EXT.length)
  : f.endsWith(SEG_V2_EXT) ? f.slice(0, -SEG_V2_EXT.length)
  : f;

/**
 * Сколько строк набирается в один сегмент до flush'а на диск (по умолчанию).
 * Крупный дефолт осознанно: меньше файлов/unlink на SSD (меньше износа и
 * метаданных, записи постраничные и последовательные), а «пересекающий»
 * сегмент при purge/compact остаётся перекодируемым за разумное время.
 * Для чёткого контроля числа файлов сегментов (тесты, дедупликация)
 * передавайте меньшее `rowsPerSegment` явно.
 */
export const DEFAULT_ROWS_PER_SEGMENT = 10_000;

/** Пачка WAL по умолчанию: сколько строк копится в памяти перед записью на диск. */
const DEFAULT_WAL_BATCH_ROWS = 512;
/** ...или сколько байтов накоплено (защита от больших строк). */
const WAL_FLUSH_BYTES = 1_000_000;

/**
 * Число (мс) или строка «языка интервалов» (VRackDB-совместимо, см. Interval)
 * вида 'now-1d'/'now'/'1700000000000' → миллисекунды. Числа проходят как есть.
 */
function resolveTs(value: number | string, label: string): number {
  if (typeof value === 'string') {
    return Interval.partOfPeriod(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`Journal: ${label} — число (мс) или строка вида now-1d/now`);
  }
  return value;
}

// --------------------------------------------------
// Сброс WAL-буферов всех открытых журналов при выходе процесса:
// «крах» через process.exit(), uncaught exception, SIGINT/SIGTERM —
// строки из буфера всё равно дописываются в wal.log.
// (SIGKILL/kill -9 не перехватывается никем — это ограничение любой WAL.)
// --------------------------------------------------
const activeJournals = new Set<Journal>();
let shutdownHooksInstalled = false;

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;

  const drainAll = (): void => {
    for (const j of [...activeJournals]) {
      try {
        j._walDrain();
      } catch {
        // на пути к завершению — без вариантов, пропускаем
      }
    }
  };

  process.on('exit', drainAll);
  const rekill = (sig: NodeJS.Signals): void => {
    drainAll();
    process.kill(process.pid, sig); // listener уже сработал один раз → default action завершит процесс
  };
  process.once('SIGINT', () => rekill('SIGINT'));
  process.once('SIGTERM', () => rekill('SIGTERM'));
}

/** min/max ts + счётчики сегмента — из сайдкар'а .meta, без загрузки файла. */
interface SegmentMeta {
  minTs: number | null;
  maxTs: number | null;
  rowCount: number;
  physicalRowCount: number;
  /** Сколько строк несёт числовой ts. `null` — неизвестно (старый .meta). */
  tsCount: number | null;
  /** Саммари числовых колонок. `null` — нет в .meta (старый файл). */
  summaries: Record<string, ColumnSummary> | null;
}

// --------------------------------------------------
// Агрегации (Фаза 1) — min/max/sum/avg/count по диапазону
// --------------------------------------------------

/** Накопитель агрегата: min/max/sum/count по числовым значениям поля. */
interface AggAcc {
  min: number;
  max: number;
  sum: number;
  count: number;
}

const newAcc = (): AggAcc => ({ min: Infinity, max: -Infinity, sum: 0, count: 0 });

/** Прибавляет одно числовое значение к накопителю. */
function addValue(acc: AggAcc, v: number): void {
  if (v < acc.min) acc.min = v;
  if (v > acc.max) acc.max = v;
  acc.sum += v;
  acc.count++;
}

/** Склеивает сегментное саммари в накопитель (fast-path без чтения данных). */
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

export class Journal {
  readonly baseDir: string;
  private readonly journalsDir: string;
  readonly rowsPerSegment: number;
  readonly maxCachedSegments: number;

  name: string | null = null;
  schema: Schema | null = null;
  metadata: Metadata | null = null;
  activeSegment: Segment | null = null;

  /** id сегмента → имя файла на диске */
  private segmentIndex = new Map<string, string>();

  /** Уникальный суффикс ID сегментов: два открытых инстанса (lock:'off')
   *  в одной миллисекунде не должны получить одинаковый ID и перезаписать файл. */
  private readonly _idNonce = Math.random().toString(16).slice(2, 8);

  /** id сегмента → объект Segment (LRU) */
  private _segmentCache: LRUCache<string, Segment>;

  segmentCounter = 0;
  isOpen = false;

  /** Пачка WAL: сколько строк копится в памяти перед записью на диск. */
  readonly walBatchSize: number;

  /** Стратегия блокировки одним владельцем ('pid' | 'off'). */
  readonly lockMode: LockMode;

  /** Формат файлов сегментов при записи ('v2' | 'v3'); чтение — прозрачное. */
  readonly format: SegmentFormat;
  /** Сжатие блобов в v3 ('gzip' | 'zstd'); игнорируется в v2. */
  readonly compression: CompressionMode;
  /** Явные числовые кодек'и v3: поле → имя кодека. Пустое — авто-выбор. */
  readonly codecs: Record<string, string>;

  /** Буфер WAL (сериализованные строки) — пишется одной append'ом. */
  private _walBuf: string[] = [];
  private _walBufBytes = 0;

  /** id сегмента → min/max ts + счётчики из сайдкар'а .meta (без загрузки файла). */
  private segmentMeta = new Map<string, SegmentMeta>();

  constructor(baseDir: string, opts: JournalOptions = {}) {
    this.baseDir = baseDir;
    this.journalsDir = path.join(baseDir, 'journals');
    this.rowsPerSegment = opts.rowsPerSegment ?? DEFAULT_ROWS_PER_SEGMENT;
    this.maxCachedSegments = opts.maxCachedSegments ?? 32;
    const batch = opts.walBatchSize ?? DEFAULT_WAL_BATCH_ROWS;
    if (!Number.isInteger(batch) || batch < 1) {
      throw new RangeError('Journal: walBatchSize должно быть целым числом >= 1');
    }
    this.walBatchSize = batch;

    const lock = opts.lock ?? 'pid';
    if (lock !== 'pid' && lock !== 'off') {
      throw new RangeError("Journal: lock должно быть 'pid' или 'off'");
    }
    this.lockMode = lock;

    const format = opts.format ?? 'v2';
    if (format !== 'v2' && format !== 'v3') {
      throw new RangeError("Journal: format должно быть 'v2' или 'v3'");
    }
    this.format = format;

    const compression = opts.compression ?? 'gzip';
    if (compression !== 'gzip' && compression !== 'zstd') {
      throw new RangeError("Journal: compression должно быть 'gzip' или 'zstd'");
    }
    this.compression = compression;

    this.codecs = opts.codecs && typeof opts.codecs === 'object' ? { ...opts.codecs } : {};
    this._segmentCache = new LRUCache<string, Segment>(this.maxCachedSegments);
  }

  /** Расширение файла сегмента при записи: v3 → .seg, v2 → .json. */
  private _segExt(): string {
    return this.format === 'v3' ? SEG_V3_EXT : SEG_V2_EXT;
  }

  /** Кодирует сегмент в буфер файла (v2: gzip+JSON, v3: бинарные блобы). */
  private _encodeSegment(segment: Segment): Buffer {
    return this.format === 'v3'
      ? encodeV3(segment, { compression: this.compression, codecs: this.codecs })
      : encodeSegment(segment.serialize());
  }

  // --------------------------------------------------
  // Открытие / закрытие
  // --------------------------------------------------

  open(name: string, schema: Schema, metadata: Metadata = {}): void {
    if (this.isOpen) {
      throw new Error(`Journal already open: ${this.name}`);
    }

    this.name = name;
    this.schema = schema;
    this.metadata = metadata;

    const journalPath = this.journalPath();
    fs.mkdirSync(journalPath, { recursive: true });

    this._acquireLock();

    try {
      // Индексируем файлы сегментов на диске (без парсинга — данные
      // будут загружены лениво при первом обращении). v1/v2 → .json, v3 → .seg
      const files = fs.readdirSync(journalPath)
        .filter(isSegmentFile)
        .sort();

      this.segmentIndex.clear();
      this.segmentMeta.clear();
      for (const file of files) {
        const id = idFromFile(file);
        this.segmentIndex.set(id, file);
        // Сайдкар с min/max ts + счётчиками: позволяет query()/stats()
        // пропускать чужие по времени файлы вообще без их загрузки.
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
        } catch {
          // .meta нет (старые файлы) или повреждён — границы узнаем при загрузке
        }
      }
      this.segmentCounter = files.length;

      this._createNewActiveSegment();
      this.isOpen = true;
      activeJournals.add(this);
      installShutdownHooks();
      this._replayWAL(); // восстановление несфлашенных строк после краха
    } catch (e) {
      this._releaseLock();
      throw e;
    }
  }

  close(): void {
    if (!this.isOpen) {
      throw new Error('Journal not open');
    }
    // Сначала WAL целиком на диске: если активных строк нет (flush — no-op),
    // они всё равно переживут закрытие и будут проиграны при следующем open.
    this._walDrain();
    this.flush();
    this.activeSegment = null;
    this.isOpen = false;
    activeJournals.delete(this);
    this._releaseLock();
  }

  // --------------------------------------------------
  // Запись
  // --------------------------------------------------

  append(row: Row): void {
    if (!this.isOpen || !this.activeSegment) {
      throw new Error('Journal not open. Call open() first.');
    }

    // WAL: строка копится в буфере и уходит на диск пачкой (одним системным
    // вызовом). Буфер гарантированно сбрасывается при flush/close/выходе
    // процесса — см. installShutdownHooks().
    const line = JSON.stringify(row) + '\n';
    this._walBuf.push(line);
    this._walBufBytes += line.length;
    if (this._walBuf.length >= this.walBatchSize || this._walBufBytes >= WAL_FLUSH_BYTES) {
      this._walDrain();
    }

    const seg = this.activeSegment;
    seg.append(row);

    if (seg.rowCount >= this.rowsPerSegment) {
      this.flush();
    }
  }

  flush(): void {
    const segment = this.activeSegment;
    if (!segment || segment.rowCount === 0) {
      return;
    }

    // Порядок важен: сначала WAL целиком на диске, потом файл сегмента,
    // и только затем трим — в любой точке краха строки не теряются.
    this._walDrain();

    const fileName = `${segment.id}${this._segExt()}`;
    const filePath = path.join(this.journalPath(), fileName);
    const tmpPath = `${filePath}.tmp`;

    // Атомарная запись: сначала во временный файл, затем rename.
    // v2: gzip + CRC32 (см. codec.ts); v3: бинарные блобы (см. v3.ts).
    fs.writeFileSync(tmpPath, this._encodeSegment(segment));
    fs.renameSync(tmpPath, filePath);

    this._writeMeta(segment, fileName);
    this.segmentIndex.set(segment.id, fileName);
    this._segmentCache.set(segment.id, segment);
    this._createNewActiveSegment();
    this._truncateWAL(); // все строки сегмента теперь на диске
  }

  /**
   * Полностью очищает журнал: все записи удаляются из памяти и с диска —
   * файлы сегментов, их сайдкар'ы .meta, wal.log (включая строки в WAL-буфере)
   * и остатки .tmp от прерванной записи. Блокировка (.lock) сохраняется.
   * Журнал остаётся открытым: сразу можно продолжать append() — это чистый журнал.
   */
  clear(): void {
    if (!this.isOpen) {
      throw new Error('Journal not open. Call open() first.');
    }

    const dir = this.journalPath();
    for (const f of fs.readdirSync(dir)) {
      if (f === LOCK_FILE) continue;
      // Сегменты, их .meta, wal.log и .tmp-остатки — всё удаляем
      if (
        isSegmentFile(f) ||
        f.endsWith(`${META_SUFFIX}`) ||
        f.endsWith('.tmp') ||
        f === WAL_FILE
      ) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }

    // Сброс в-memory состояния (старые объекты уйдут по GC)
    this.segmentIndex.clear();
    this._segmentCache.clear();
    this.segmentMeta.clear();
    this._walBuf = [];
    this._walBufBytes = 0;
    this.activeSegment = null;

    this._createNewActiveSegment(); // чистый активный сегмент — можно сразу писать
  }

  // --------------------------------------------------
  // Компактизация
  // --------------------------------------------------

  /**
   * Сливает все закрытые сегменты в один. Дедупликация применяется
   * повторно уже на границах бывших сегментов, а auto-колонки
   * перекодируются на объединённых данных (сэмпл может пересечь порог).
   */
  compact(): CompactResult {
    if (!this.isOpen) {
      throw new Error('Journal not open. Call open() first.');
    }

    const ids = this._sortedClosedIds();
    if (ids.length < 2) {
      return { mergedSegments: 0, logicalRows: 0, physicalBefore: 0, physicalAfter: 0 };
    }

    let logicalRows = 0;
    let physicalBefore = 0;
    const rows: Row[] = [];
    for (const id of ids) {
      const seg = this._loadClosedSegment(id);
      for (let i = 0; i < seg.rowCount; i++) {
        rows.push(seg.getRow(i));
      }
      logicalRows += seg.rowCount;
      physicalBefore += seg.physicalRowCount;
    }

    const merged = new Segment(
      `seg_${Date.now()}_${this.segmentCounter++}_${this._idNonce}`,
      this.schema!,
      { ...(this.metadata ?? {}) }
    );
    for (const row of rows) {
      merged.append(row);
    }

    // Атомарная запись слитого сегмента + его сайдкар с границами
    const fileName = `${merged.id}${this._segExt()}`;
    const filePath = path.join(this.journalPath(), fileName);
    fs.writeFileSync(`${filePath}.tmp`, this._encodeSegment(merged));
    fs.renameSync(`${filePath}.tmp`, filePath);
    this._writeMeta(merged, fileName);

    // Убираем старые сегменты с диска (и их сайдкар'ы), из индекса и кэша
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

    return {
      mergedSegments: ids.length,
      logicalRows,
      physicalBefore,
      physicalAfter: merged.physicalRowCount
    };
  }

  /**
   * Удаляет строки старше границы: остаются строки с ts >= beforeTs.
   * Строки без ts никогда не удаляются. Сегменты, целиком старше границы,
   * удаляются по сайдкар'у .meta без чтения файла; сегмент, пересекающий
   * границу, перекодируется без старых строк (атомарно). Активный сегмент
   * сначала дописывается на диск, WAL обрезается — после purge() reopen
   * не вернёт удалённые строки. Журнал остаётся открытым и пригодным к записи.
   *
   * `beforeTs` — число (мс) или строка «языка интервалов» (VRackDB):
   * `purge('now-30d')` = удалить всё старше 30 дней назад.
   */
  purge(beforeTs: number | string): PurgeResult {
    if (!this.isOpen) {
      throw new Error('Journal not open. Call open() first.');
    }
    // Граница: число (мс) или строка вида 'now-1d' (удалить всё старше N дней назад)
    const before = resolveTs(beforeTs, 'purge(beforeTs)');

    // Активный сегмент — на диск, WAL — срезан: дальше всё единообразно
    if (this.activeSegment) {
      this._walDrain();
      if (this.activeSegment.rowCount > 0) {
        this.flush();
      } else {
        this._truncateWAL();
      }
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

      // Целиком старше границы — удаляем без чтения данных.
      // Безопасно только если знаем, что строк без ts НЕТ: иначе fast-path
      // удалил бы и их (строки без ts не удаляются никогда).
      if (
        maxTs !== null && maxTs < before &&
        rowCount !== null && tsCount !== null && tsCount === rowCount
      ) {
        removedRows += rowCount;
        this._dropClosedSegment(id);
        removedSegments++;
        continue;
      }
      // Целиком новее границы — не трогаем
      if (minTs !== null && minTs >= before) {
        continue;
      }

      // Пересекает границу (или границы/состав неизвестны) — перекодируем
      const seg = this._loadClosedSegment(id);
      const kept: Row[] = [];
      for (let i = 0; i < seg.rowCount; i++) {
        const row = seg.getRow(i);
        const ts = row.ts;
        if (typeof ts !== 'number' || ts >= before) kept.push(row);
      }
      const dropped = seg.rowCount - kept.length;
      if (dropped === 0) continue; // старых строк нет — файл остаётся как есть

      removedRows += dropped;
      const fresh = new Segment(seg.id, this.schema!, this.metadata ?? {});
      for (const row of kept) fresh.append(row);

      const oldFile = this.segmentIndex.get(id)!;
      const fileName = `${id}${this._segExt()}`; // текущий формат журнала
      const filePath = path.join(this.journalPath(), fileName);
      fs.writeFileSync(`${filePath}.tmp`, this._encodeSegment(fresh));
      fs.renameSync(`${filePath}.tmp`, filePath); // атомарно — краш не оставит «половину»
      if (oldFile !== fileName) {
        fs.rmSync(path.join(this.journalPath(), oldFile), { force: true }); // старый файл (другое расширение)
      }
      this._writeMeta(fresh, fileName);
      this._segmentCache.set(id, fresh);
      this.segmentIndex.set(id, fileName);
      rewrittenSegments++;
    }

    // Свободный активный сегмент — журнал открыт и готов к записи
    this._createNewActiveSegment();

    return { removedRows, removedSegments, rewrittenSegments };
  }

  /** Убирает закрытый сегмент: файл, сайдкар, индекс, кэш, метаданные. */
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

  /**
   * Таймлайн: разбивает период [start, end] на бакеты шириной `interval` (мс)
   * и считает в каждом, сколько строк с ts в [start_бакета, end_бакета).
   * `hasData` = count > 0. Строки без ts не попадают в таймлайн.
   *
   * `interval` — число (мс) или строка вида '1h'/'30m' (VRackDB-совместимо, см. Interval).
   * `period` — [start, end] в мс или строка вида 'now-7d:now'.
   *
   * Дёшево: сегмент, не пересекающий период, не читается (решение по min/max
   * из сайдкар'а .meta). Читаются только сегменты, пересекающие хотя бы один
   * бакет — и то один раз (кэш), строки бинуются в бакет по ts.
   */
  timeline(interval: number | string, period: [number, number] | string): TimelineBucket[] {
    if (!this.isOpen) {
      throw new Error('Journal not open. Call open() first.');
    }

    // Интервал: число (мс) или строка вида '1h'/'30m' (VRackDB-совместимо)
    let int: number;
    if (typeof interval === 'string') {
      int = Interval.parseInterval(interval);
    } else if (typeof interval !== 'number' || !Number.isFinite(interval)) {
      throw new RangeError('Journal: timeline() — interval: число (мс) или строка вида 1h/30m');
    } else {
      int = interval;
    }
    if (int <= 0) {
      throw new RangeError('Journal: timeline() — interval должно быть > 0 (мс)');
    }

    // Период: [start, end] в мс или строка вида 'now-7d:now'
    let start: number;
    let end: number;
    if (typeof period === 'string') {
      [start, end] = Interval.period(period);
    } else if (!Array.isArray(period) || period.length < 2) {
      throw new RangeError('Journal: timeline() — период: [start, end] (мс) или строка вида now-7d:now');
    } else {
      [start, end] = period;
    }
    if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end)) {
      throw new RangeError('Journal: timeline() — период: [число, число] (мс)');
    }
    if (end < start) {
      throw new RangeError('Journal: timeline() — период: start должен быть <= end');
    }
    if (end === start) return [];

    const n = Math.ceil((end - start) / int);
    const counts = new Array<number>(n).fill(0);

    /** ts из [start, end) → индекс бакета; иначе игнорируем. */
    const bin = (ts: number): void => {
      if (ts < start || ts >= end) return;
      counts[Math.floor((ts - start) / int)]++;
    };

    // Закрытые сегменты: по .meta пропускаем те, что точно вне периода
    for (const id of this._sortedClosedIds()) {
      const meta = this.segmentMeta.get(id);
      if (meta && meta.minTs !== null && meta.maxTs !== null) {
        if (meta.maxTs < start || meta.minTs >= end) continue; // не пересекает период
      }
      const seg = this._loadClosedSegment(id);
      for (let i = 0; i < seg.rowCount; i++) {
        const ts = seg.get('ts', i);
        if (typeof ts === 'number') bin(ts);
      }
    }

    // Активный сегмент — уже в памяти
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
      buckets[i] = {
        start: bStart,
        end: Math.min(bStart + int, end), // последний бакет = period.end
        count: counts[i],
        hasData: counts[i] > 0
      };
    }
    return buckets;
  }

  // --------------------------------------------------
  // Агрегации (Фаза 1)
  // --------------------------------------------------

  /**
   * Агрегация по диапазону [startTs, endTs] (включительно с обеих сторон) —
   * без материализации строк. Для сегментов, целиком лежащих в диапазоне,
   * значения берутся из сегментных саммари (сайдкар .meta) без чтения данных;
   * только граничные сегменты сканируются — и то только запрошенные колонки.
   *
   * ```ts
   * j.aggregate('now-1h', 'now', [
   *   { field: 'value', fn: 'avg' },
   *   { field: 'value', fn: 'min' },
   *   { field: 'value', fn: 'max' },
   *   { field: 'value', fn: 'count' },
   * ]);
   * // → { avg: 42.3, min: 1.0, max: 99.9, count: 7184 }
   * ```
   *
   * Семантика: все функции работают по числовым (конечным) значениям поля;
   * null/не-числа пропускаются. `count` — количество числовых значений
   * (0, если их нет); `min/max/sum/avg` — null, если числовых значений нет.
   * Строки без числового ts не участвуют.
   * Ключ результата — имя функции; если одна функция запрошена по нескольким
   * полям, ключи различаются: `поле__fn`.
   */
  aggregate(
    startTs: number | string,
    endTs: number | string,
    exprs: AggregateExpr[],
  ): Record<string, number | null> {
    if (!this.isOpen) {
      throw new Error('Journal not open. Call open() first.');
    }
    if (!Array.isArray(exprs) || exprs.length === 0) {
      throw new RangeError('Journal: aggregate() — exprs: непустой массив { field, fn }');
    }
    for (const e of exprs) {
      if (!e || typeof e.field !== 'string' || e.field.length === 0) {
        throw new RangeError('Journal: aggregate() — expr.field: непустое имя поля');
      }
      if (!isAggFn(e.fn)) {
        throw new RangeError(`Journal: aggregate() — expr.fn: min|max|sum|avg|count (получено ${String(e.fn)})`);
      }
    }

    const start = resolveTs(startTs, 'aggregate(startTs)');
    const end = resolveTs(endTs, 'aggregate(endTs)');
    if (end < start) {
      throw new RangeError('Journal: aggregate() — startTs должен быть <= endTs');
    }

    const fields: string[] = [...new Set(exprs.map(e => e.field))];
    const accs: Record<string, AggAcc> = {};
    for (const f of fields) accs[f] = newAcc();

    // Закрытые сегменты
    for (const id of this._sortedClosedIds()) {
      const meta = this.segmentMeta.get(id);
      const minTs = meta?.minTs ?? null;
      const maxTs = meta?.maxTs ?? null;
      const summaries = meta?.summaries ?? null;

      // Вне диапазона — не читаем вообще
      if (minTs !== null && maxTs !== null && (maxTs < start || minTs > end)) {
        continue;
      }

      // Целиком в диапазоне + есть саммари → fast-path без чтения данных
      if (minTs !== null && maxTs !== null && minTs >= start && maxTs <= end && summaries) {
        let slow: string[] = [];
        for (const f of fields) {
          const s = summaries[f];
          if (s) addSummary(accs[f], s);
          else slow.push(f);
        }
        if (slow.length > 0) {
          this._scanAggregate(this._loadClosedSegment(id), start, end, slow, accs);
        }
        continue;
      }

      // Граничный / нет .meta / нет саммари — скан запрошенных колонок
      const seg = this._loadClosedSegment(id);
      this._scanAggregate(seg, start, end, fields, accs);
    }

    // Активный сегмент — в памяти
    const active = this.activeSegment;
    if (active && active.rowCount > 0) {
      this._aggregateActive(active, start, end, fields, accs);
    }

    return this._buildResult(exprs, accs);
  }

  /**
   * Даунсэмплинг [startTs, endTs) (конец не включительно, как в timeline())
   * на бакеты шириной `bucketMs` (выровнены по эпохе через roundTime) +
   * агрегаты `field` в каждом бакете. Расширение timeline(): там только count,
   * здесь — min/max/sum/avg/count.
   *
   * ```ts
   * j.downsample('now-1d', 'now', '15m', 'value', ['avg', 'min', 'max']);
   * // → [{ start, end, count, hasData, avg, min, max }, …]  (96 бакетов)
   * ```
   *
   * Сегмент, не пересекающий период, не читается (решение по .meta).
   */
  downsample(
    startTs: number | string,
    endTs: number | string,
    bucketMs: number | string,
    field: string,
    fns: AggFn[],
  ): DownsampleBucket[] {
    if (!this.isOpen) {
      throw new Error('Journal not open. Call open() first.');
    }
    if (typeof field !== 'string' || field.length === 0) {
      throw new RangeError('Journal: downsample() — field: непустое имя поля');
    }
    if (!Array.isArray(fns) || fns.length === 0) {
      throw new RangeError('Journal: downsample() — fns: непустой массив min|max|sum|avg|count');
    }
    for (const fn of fns) {
      if (!isAggFn(fn)) {
        throw new RangeError(`Journal: downsample() — fn: min|max|sum|avg|count (получено ${String(fn)})`);
      }
    }

    let bucket: number;
    if (typeof bucketMs === 'string') {
      bucket = Interval.parseInterval(bucketMs);
    } else if (typeof bucketMs !== 'number' || !Number.isFinite(bucketMs)) {
      throw new RangeError('Journal: downsample() — bucketMs: число (мс) или строка вида 15m/1h');
    } else {
      bucket = bucketMs;
    }
    if (bucket <= 0) {
      throw new RangeError('Journal: downsample() — bucketMs должно быть > 0 (мс)');
    }

    const start = resolveTs(startTs, 'downsample(startTs)');
    const end = resolveTs(endTs, 'downsample(endTs)');
    if (end < start) {
      throw new RangeError('Journal: downsample() — startTs должен быть <= endTs');
    }
    if (end === start) return [];

    // Бакеты выровнены по эпохе (roundTime) — границы детерминированы,
    // что нужно для идемпотентного rollup (Фаза 4).
    const first = Interval.roundTime(start, bucket); // <= start, кратен bucket
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
      if (seg.minTs !== null && seg.maxTs !== null && (seg.maxTs < start || seg.minTs >= end)) {
        return; // не пересекает период
      }
      for (let i = 0; i < seg.rowCount; i++) {
        const ts = seg.get('ts', i);
        if (typeof ts !== 'number' || ts < start || ts >= end) continue;
        const v = seg.get(field, i);
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        addValue(accs[bin(ts)], v);
      }
    };

    for (const id of this._sortedClosedIds()) {
      // Пропускаем по .meta без чтения файла
      const meta = this.segmentMeta.get(id);
      if (meta && meta.minTs !== null && meta.maxTs !== null &&
        (meta.maxTs < start || meta.minTs >= end)) {
        continue;
      }
      processSegment(this._loadClosedSegment(id));
    }

    const active = this.activeSegment;
    if (active && active.rowCount > 0) processSegment(active);

    const buckets: DownsampleBucket[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const acc = accs[i];
      const bStart = first + i * bucket;
      const bucketObj: Record<string, unknown> = {
        start: Math.max(bStart, start),
        end: Math.min(bStart + bucket, end),
        count: acc.count,
        hasData: acc.count > 0
      };
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

  // --------------------------------------------------
  // Чтение
  // --------------------------------------------------

  getTimeRange(): [number, number] | null {
    let min = Infinity;
    let max = -Infinity;
    const consider = (minTs: number | null, maxTs: number | null): void => {
      if (minTs !== null && minTs < min) min = minTs;
      if (maxTs !== null && maxTs > max) max = maxTs;
    };

    // Если для всех закрытых сегментов есть .meta — считаем без единой загрузки файлов
    const ids = [...this.segmentIndex.keys()];
    if (ids.length === 0 || ids.every(id => this.segmentMeta.has(id))) {
      for (const id of ids) {
        const m = this.segmentMeta.get(id)!;
        consider(m.minTs, m.maxTs);
      }
      const active = this.activeSegment;
      if (active && active.rowCount > 0) consider(active.minTs, active.maxTs);
    } else {
      // Есть сегменты без .meta — грузим их (и кэшируем границы при этом)
      for (const seg of this.allSegments()) {
        consider(seg.minTs, seg.maxTs);
      }
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
    // Границы: число (мс) или строка «языка интервалов» (VRackDB): 'now-7d', 'now'
    const start = resolveTs(startTime, 'query(startTime)');
    const end = resolveTs(endTime, 'query(endTime)');
    const results: Row[] = [];

    for (const id of this._sortedClosedIds()) {
      // Границы из сайдкар'а .meta: сегмент вне диапазона не читается вообще
      const meta = this.segmentMeta.get(id);
      if (meta && meta.minTs !== null && meta.maxTs !== null) {
        if (meta.maxTs < start || meta.minTs > end) continue;
      }

      const seg = this._loadClosedSegment(id);
      if (seg.minTs !== null && seg.maxTs !== null) {
        // Повторная проверка на данных (сайдкар мог отсутствовать/устаревать)
        if (seg.maxTs < start || seg.minTs > end) continue;
      }

      for (let i = 0; i < seg.rowCount; i++) {
        const ts = seg.get('ts', i);
        if (typeof ts === 'number' && ts >= start && ts <= end) {
          results.push(this._normalizeRow(seg.getRow(i)));
        }
      }
    }

    // Активный сегмент — в памяти, обрабатываем последним (как раньше)
    const active = this.activeSegment;
    if (active && active.rowCount > 0) {
      for (let i = 0; i < active.rowCount; i++) {
        const ts = active.get('ts', i);
        if (typeof ts === 'number' && ts >= start && ts <= end) {
          results.push(this._normalizeRow(active.getRow(i)));
        }
      }
    }

    return results;
  }

  allRows(): Row[] {
    const results: Row[] = [];
    for (const seg of this.allSegments()) {
      for (let i = 0; i < seg.rowCount; i++) {
        results.push(this._normalizeRow(seg.getRow(i)));
      }
    }
    return results;
  }

  /**
   * Последние `count` строк журнала в хронологическом порядке (старые → новые).
   * Сегменты обходятся от новых к старым и загружаются лениво — как только
   * собрано достаточно строк, более старые сегменты не читаются вообще.
   */
  tail(count: number): Row[] {
    if (!this.isOpen) {
      throw new Error('Journal not open. Call open() first.');
    }
    if (count <= 0) return [];

    const takeFromSegment = (seg: Segment, n: number): Row[] => {
      const rows: Row[] = [];
      for (let i = seg.rowCount - n; i < seg.rowCount; i++) {
        rows.push(this._normalizeRow(seg.getRow(i)));
      }
      return rows; // старые → новые внутри сегмента
    };

    let result: Row[] = [];

    // Активный сегмент — самые свежие строки, уже в памяти
    const active = this.activeSegment;
    if (active && active.rowCount > 0) {
      result = takeFromSegment(active, Math.min(count, active.rowCount));
    }

    // Закрытые сегменты — от новых к старым, по требованию из кэша или с диска.
    // Как только собрано достаточно строк — стоп, более старые файлы не читаются.
    if (result.length < count) {
      for (const id of this._sortedClosedIds().reverse()) {
        if (result.length >= count) break;
        const seg = this._loadClosedSegment(id);
        const chunk = takeFromSegment(seg, Math.min(count - result.length, seg.rowCount));
        result = [...chunk, ...result]; // более старые строки — перед новыми
      }
    }

    return result;
  }

  /**
   * Срез логических строк с пагинацией и порядком — «limit/offset» по журналу.
   * Строки идут в порядке записи (хронологии):
   *   - order='asc'  — старые → новые, offset считается от самых старых;
   *   - order='desc' — новые → старые, offset считается от самых свежих.
   * Сегменты, целиком лежащие до нужного окна, не читаются с диска: они
   * пропускаются по счётчикам строк из сайдкар'ов .meta (или кэша).
   */
  page(limit: number, offset = 0, order: 'asc' | 'desc' = 'asc'): Row[] {
    if (!this.isOpen) {
      throw new Error('Journal not open. Call open() first.');
    }
    if (!Number.isInteger(limit) || limit < 1) return [];
    let skip = Number.isInteger(offset) && offset > 0 ? offset : 0;

    const result: Row[] = [];
    const closedIds = this._sortedClosedIds(); // старые → новые

    /** Забирает строки из сегмента, пропуская `skip` с нужного края. */
    const takeFrom = (seg: Segment): void => {
      if (result.length >= limit) return;
      const r = seg.rowCount;
      if (r === 0) return;
      if (skip >= r) {
        skip -= r; // весь сегмент до окна — пропускаем целиком
        return;
      }
      const k = Math.min(limit - result.length, r - skip);
      if (order === 'asc') {
        for (let i = skip; i < skip + k; i++) {
          result.push(this._normalizeRow(seg.getRow(i)));
        }
      } else {
        // свежие → старые, начиная сразу после пропущенных `skip` с конца сегмента
        const startIdx = r - 1 - skip;
        for (let i = 0; i < k; i++) {
          result.push(this._normalizeRow(seg.getRow(startIdx - i)));
        }
      }
      skip = 0;
    };

    if (order === 'asc') {
      for (const id of closedIds) {
        const meta = this.segmentMeta.get(id);
        if (meta && skip >= meta.rowCount) {
          skip -= meta.rowCount; // сегмент не загружаем вообще
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
          skip -= meta.rowCount; // сегмент не загружаем вообще
          continue;
        }
        takeFrom(this._loadClosedSegment(id));
      }
    }

    return result;
  }

  /** Поля текущей схемы, которых нет в старом сегменте → null */
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

  // Обновляет метаданные журнала и активного сегмента.
  // Уже записанные на диск сегменты хранят снимок метаданных
  // на момент своей записи (сегменты неизменяемы).
  updateMetadata(newMetadata: Metadata): void {
    this.metadata = { ...this.metadata, ...newMetadata };
    if (this.activeSegment) {
      this.activeSegment.metadata = { ...this.metadata };
    }
  }

  stats(): JournalStats {
    const ids = [...this.segmentIndex.keys()];
    let segmentCount = ids.length;
    let totalRows = 0;
    let totalPhysical = 0;

    // Если для всех сегментов есть .meta — считаем без загрузки файлов
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

  // --------------------------------------------------
  // Внутренние методы
  // --------------------------------------------------

  journalPath(): string {
    return path.join(this.journalsDir, this.name!);
  }

  private _createNewActiveSegment(): void {
    const id = `seg_${Date.now()}_${this.segmentCounter++}_${this._idNonce}`;
    this.activeSegment = new Segment(id, this.schema!, this.metadata ?? {});
  }

  /** Ленивая загрузка закрытого сегмента из кэша или с диска (v1/v2). */
  private _loadClosedSegment(id: string): Segment {
    const cached = this._segmentCache.get(id);
    if (cached) return cached;

    const fileName = this.segmentIndex.get(id);
    if (!fileName) {
      throw new Error(`Неизвестный сегмент: ${id}`);
    }

    let seg: Segment;
    try {
      const buf = fs.readFileSync(path.join(this.journalPath(), fileName));
      // Прозрачное чтение: v1 (JSON) / v2 (gzip+JSON) / v3 (бинарные блобы)
      seg = readSegment(buf);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Не удалось прочитать сегмент ${fileName}: ${message}`);
    }
    // Кэшируем границы: для старых файлов без .meta это единственный способ,
    // и дальше query()/stats() смогут работать по этим данным.
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
    // Хронологический порядок (см. _sortedClosedIds) — порядок строк в
    // allRows()/allSegments() должен совпадать с порядком записи.
    return this._sortedClosedIds().map(id => this._loadClosedSegment(id));
  }

  allSegments(): Segment[] {
    const segments = this._loadAllClosed();
    if (this.activeSegment && this.activeSegment.rowCount > 0) {
      segments.push(this.activeSegment);
    }
    return segments;
  }

  // --------------------------------------------------
  // Агрегации — внутренние
  // --------------------------------------------------

  /**
   * Скан сегмента по запрошенным колонкам с фильтром ts в [start, end]
   * (включительно). Числовые значения прибавляются в накопители.
   */
  private _scanAggregate(
    seg: Segment,
    start: number,
    end: number,
    fields: string[],
    accs: Record<string, AggAcc>,
  ): void {
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

  /** Активный сегмент: fast-path по своим саммари, иначе скан. */
  private _aggregateActive(
    seg: Segment,
    start: number,
    end: number,
    fields: string[],
    accs: Record<string, AggAcc>,
  ): void {
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

  /** Накопители → результат: ключ = fn (или поле__fn при конфликте), пустые → null. */
  private _buildResult(
    exprs: AggregateExpr[],
    accs: Record<string, AggAcc>,
  ): Record<string, number | null> {
    // fn → множество полей, использующих его (для различения ключей)
    const fnFields = new Map<AggFn, Set<string>>();
    for (const e of exprs) {
      let s = fnFields.get(e.fn);
      if (!s) { s = new Set(); fnFields.set(e.fn, s); }
      s.add(e.field);
    }
    const keyFor = (field: string, fn: AggFn): string =>
      fnFields.get(fn)!.size > 1 ? `${field}__${fn}` : fn;

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
      result[keyFor(e.field, e.fn)] = value;
    }
    return result;
  }

  /** Сайдкар <файл>.meta — min/max ts + счётчики для query()/stats() без загрузки файла. */
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
    fs.renameSync(`${metaPath}.tmp`, metaPath); // атомарно — «сироты» не остаются
  }

  /**
   * id закрытых сегментов в хронологическом порядке.
   * Формат id: `seg_<tsMs>_<counter>_<nonce>` (nonce — случайный хекс,
   * защита от коллизий между инстансами). Порядок определяется парой
   * (tsMs, counter) — порядком создания; nonce — лишь финальный
   * детерминированный тай-брейкер для id, созданных в одну миллисекунду.
   * (Сортировка «по последнему числовому суффиксу» не работает: суффикс —
   * это nonce, и при буквах в нём regex не срабатывает.)
   */
  private _sortedClosedIds(): string[] {
    const key = (id: string): [number, number, string] => {
      const m = id.match(/^seg_(\d+)_(\d+)_(.+)$/);
      return m ? [Number(m[1]), Number(m[2]), m[3]] : [0, 0, id];
    };
    return [...this.segmentIndex.keys()].sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
    });
  }

  // --------------------------------------------------
  // WAL — восстановление несфлашенных строк после краха
  // --------------------------------------------------

  private _walPath(): string {
    return path.join(this.journalPath(), WAL_FILE);
  }

  /** Сбрасывает накопленные строки WAL на диск одним append'ом. Идемпотентен, если буфер пуст. */
  _walDrain(): void {
    if (this._walBuf.length === 0) return;
    const chunk = this._walBuf.join('');
    // Буфер очищаем до записи: при сбое I/O строки считаются потерянными,
    // но не дублируются повторной записью поверх уже наполовину дописанного.
    this._walBuf = [];
    this._walBufBytes = 0;
    fs.appendFileSync(this._walPath(), chunk, 'utf-8');
  }

  private _truncateWAL(): void {
    fs.rmSync(this._walPath(), { force: true });
  }

  /** Проигрывает строки из WAL в активный сегмент. */
  private _replayWAL(): void {
    let content: string;
    try {
      content = fs.readFileSync(this._walPath(), 'utf-8');
    } catch {
      return; // WAL нет — обычное открытие
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
    if (seg.rowCount >= this.rowsPerSegment) {
      // flush() усечёт WAL — безопасно: строки уже прочитаны в память
      this.flush();
    }
  }

  // --------------------------------------------------
  // Блокировка журнала одним владельцем
  // --------------------------------------------------

  private _lockPath(): string {
    return path.join(this.journalPath(), LOCK_FILE);
  }

  /** Захватывает блокировку; устаревшую (мёртвый PID) забирает себе. */
  private _acquireLock(): void {
    if (this.lockMode === 'off') return; // координация владельцев — на стороне приложения
    const lockPath = this._lockPath();
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    // Блокировка существует — проверяем живость владельца
    let holderPid = -1;
    try {
      const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: number };
      if (typeof info.pid === 'number') holderPid = info.pid;
    } catch {
      // Повреждённый lockfile — считаем устаревшим
    }

    if (this._pidAlive(holderPid)) {
      throw new Error(
        `Журнал заблокирован процессом ${holderPid} (${lockPath}). ` +
        'Если других владельцев действительно нет (например, умер worker_threads), ' +
        "откройте журнал с { lock: 'off' } или удалите .lock"
      );
    }

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  }

  private _releaseLock(): void {
    if (this.lockMode === 'off') return; // блокировки не было — снимать нечего
    try {
      const info = JSON.parse(fs.readFileSync(this._lockPath(), 'utf-8')) as { pid?: number };
      if (info.pid === process.pid) {
        fs.rmSync(this._lockPath(), { force: true });
      }
    } catch {
      // Блокировки уже нет — делать нечего
    }
  }

  private _pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM — процесс существует, но не наш
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
