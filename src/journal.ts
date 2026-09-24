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
import { decodeSegment, encodeSegment } from './codec.ts';
import type {
  CompactResult,
  JournalOptions,
  JournalStats,
  Metadata,
  Row,
  Schema,
  SerializedSegment,
} from './types.ts';

const LOCK_FILE = '.lock';
const WAL_FILE = 'wal.log';
const META_SUFFIX = '.meta';

/** Пачка WAL по умолчанию: сколько строк копится в памяти перед записью на диск. */
const DEFAULT_WAL_BATCH_ROWS = 512;
/** ...или сколько байтов накоплено (защита от больших строк). */
const WAL_FLUSH_BYTES = 1_000_000;

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

  /** id сегмента → объект Segment (LRU) */
  private _segmentCache: LRUCache<string, Segment>;

  segmentCounter = 0;
  isOpen = false;

  /** Пачка WAL: сколько строк копится в памяти перед записью на диск. */
  readonly walBatchSize: number;

  /** Буфер WAL (сериализованные строки) — пишется одной append'ом. */
  private _walBuf: string[] = [];
  private _walBufBytes = 0;

  /** id сегмента → min/max ts + счётчики из сайдкар'а .meta (без загрузки файла). */
  private segmentMeta = new Map<string, SegmentMeta>();

  constructor(baseDir: string, opts: JournalOptions = {}) {
    this.baseDir = baseDir;
    this.journalsDir = path.join(baseDir, 'journals');
    this.rowsPerSegment = opts.rowsPerSegment ?? 100;
    this.maxCachedSegments = opts.maxCachedSegments ?? 32;
    const batch = opts.walBatchSize ?? DEFAULT_WAL_BATCH_ROWS;
    if (!Number.isInteger(batch) || batch < 1) {
      throw new RangeError('Journal: walBatchSize должно быть целым числом >= 1');
    }
    this.walBatchSize = batch;
    this._segmentCache = new LRUCache<string, Segment>(this.maxCachedSegments);
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
      // будут загружены лениво при первом обращении)
      const files = fs.readdirSync(journalPath)
        .filter(f => f.endsWith('.json'))
        .sort();

      this.segmentIndex.clear();
      this.segmentMeta.clear();
      for (const file of files) {
        const id = file.replace(/\.json$/, '');
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
              physicalRowCount: typeof m.physicalRowCount === 'number' ? m.physicalRowCount : m.rowCount
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

    const fileName = `${segment.id}.json`;
    const filePath = path.join(this.journalPath(), fileName);
    const tmpPath = `${filePath}.tmp`;

    // Атомарная запись: сначала во временный файл, затем rename.
    // Файл v2: gzip + CRC32 (см. codec.ts).
    fs.writeFileSync(tmpPath, encodeSegment(segment.serialize()));
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
        f.endsWith('.json') ||
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
      `seg_${Date.now()}_${this.segmentCounter++}`,
      this.schema!,
      { ...(this.metadata ?? {}) }
    );
    for (const row of rows) {
      merged.append(row);
    }

    // Атомарная запись слитого сегмента + его сайдкар с границами
    const fileName = `${merged.id}.json`;
    const filePath = path.join(this.journalPath(), fileName);
    fs.writeFileSync(`${filePath}.tmp`, encodeSegment(merged.serialize()));
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

  query(startTime: number, endTime: number): Row[] {
    const results: Row[] = [];

    for (const id of [...this.segmentIndex.keys()]) {
      // Границы из сайдкар'а .meta: сегмент вне диапазона не читается вообще
      const meta = this.segmentMeta.get(id);
      if (meta && meta.minTs !== null && meta.maxTs !== null) {
        if (meta.maxTs < startTime || meta.minTs > endTime) continue;
      }

      const seg = this._loadClosedSegment(id);
      if (seg.minTs !== null && seg.maxTs !== null) {
        // Повторная проверка на данных (сайдкар мог отсутствовать/устаревать)
        if (seg.maxTs < startTime || seg.minTs > endTime) continue;
      }

      for (let i = 0; i < seg.rowCount; i++) {
        const ts = seg.get('ts', i);
        if (typeof ts === 'number' && ts >= startTime && ts <= endTime) {
          results.push(this._normalizeRow(seg.getRow(i)));
        }
      }
    }

    // Активный сегмент — в памяти, обрабатываем последним (как раньше)
    const active = this.activeSegment;
    if (active && active.rowCount > 0) {
      for (let i = 0; i < active.rowCount; i++) {
        const ts = active.get('ts', i);
        if (typeof ts === 'number' && ts >= startTime && ts <= endTime) {
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
    const id = `seg_${Date.now()}_${this.segmentCounter++}`;
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

    let data: SerializedSegment;
    try {
      const buf = fs.readFileSync(path.join(this.journalPath(), fileName));
      data = decodeSegment(buf);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Не удалось прочитать сегмент ${fileName}: ${message}`);
    }

    const seg = Segment.deserialize(data);
    // Кэшируем границы: для старых файлов без .meta это единственный способ,
    // и дальше query()/stats() смогут работать по этим данным.
    this.segmentMeta.set(id, {
      minTs: seg.minTs,
      maxTs: seg.maxTs,
      rowCount: seg.rowCount,
      physicalRowCount: seg.physicalRowCount || seg.rowCount
    });
    this._segmentCache.set(id, seg);
    return seg;
  }

  private _loadAllClosed(): Segment[] {
    return [...this.segmentIndex.keys()].map(id => this._loadClosedSegment(id));
  }

  allSegments(): Segment[] {
    const segments = this._loadAllClosed();
    if (this.activeSegment && this.activeSegment.rowCount > 0) {
      segments.push(this.activeSegment);
    }
    return segments;
  }

  /** Сайдкар <файл>.meta — min/max ts + счётчики для query()/stats() без загрузки файла. */
  private _writeMeta(seg: Segment, fileName: string): void {
    const meta: SegmentMeta = {
      minTs: seg.minTs,
      maxTs: seg.maxTs,
      rowCount: seg.rowCount,
      physicalRowCount: seg.physicalRowCount || seg.rowCount
    };
    this.segmentMeta.set(seg.id, meta);
    const metaPath = path.join(this.journalPath(), `${fileName}${META_SUFFIX}`);
    fs.writeFileSync(`${metaPath}.tmp`, JSON.stringify(meta));
    fs.renameSync(`${metaPath}.tmp`, metaPath); // атомарно — «сироты» не остаются
  }

  /** id закрытых сегментов в хронологическом порядке (по числовому суффиксу). */
  private _sortedClosedIds(): string[] {
    const key = (id: string): number => {
      const m = id.match(/_(\d+)$/);
      return m ? Number(m[1]) : -1;
    };
    return [...this.segmentIndex.keys()].sort((a, b) => key(a) - key(b));
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
      throw new Error(`Журнал заблокирован процессом ${holderPid} (${lockPath})`);
    }

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  }

  private _releaseLock(): void {
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
