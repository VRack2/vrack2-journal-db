// ============================================================
// table.ts — Table: мультитирная таблица метрик (GraphiteMergeTree)
//
// Фаза 4. Одна таблица = несколько тиров разрешения, каждый — отдельный
// журнал. Свежие данные живут на тонком разрешении; по мере «возраста»
// rollup переносит их на более грубые тиры, а мелкий тир чистит (TTL).
// Размер предсказуем: Σ(разрешение × ttl). Чтение разбивает диапазон по
// «возрасту» на окна тиров и склеивает ответ в хронологическом порядке.
//
//   const t = store.openTable('cpu', {
//     retention: '5s:1d,15s:1w,1m:1mon',
//     agg: { value: 'avg' },
//     schema: { ts: 'delta', value: 'auto', host: 'dictionary' },
//   });
//   t.append({ ts: now, value: 42.3, host: 'web-1' });
//   t.query('now-30d', 'now');   // сам собирает ответ из нужных тиров
//   t.rollup();                  // переносит состарившееся на грубые тиры
//   t.stats();                   // { tier, resMs, ttlMs, rows, bytes, … }
//
// Rollup идемпотентен по чекпоинту (последний перенесённый maxTs на пару
// тиров, пишется атомарно ДО purge мелкого тира) — повторный вызов того же
// окна ничего не дублирует (границы бакетов детерминированы через roundTime).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { Journal, percentileKey, percentileOf } from './journal.ts';
import { Interval } from './interval.ts';
import type {
  AggFn,
  JsonValue,
  Metadata,
  OpenJournalOptions,
  ResolutionTier,
  Row,
  RollupReport,
  Schema,
  TableConfig,
  TableTierStat,
} from './types.ts';

// Минимальный структурный интерфейс хранилища (Store из store.ts подходит
// без импорта — исключает циклическую зависимость store.ts ↔ table.ts).
export interface TableStore {
  readonly baseDir: string;
  openJournals: Map<string, Journal>;
  openJournal(
    name: string,
    schema: Schema,
    metadata?: Metadata,
    opts?: OpenJournalOptions,
  ): Journal;
  closeJournal(name: string): void;
}

const AGG_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count']);
const isAggFn = (fn: unknown): fn is AggFn => AGG_FNS.has(String(fn));

/**
 * Парсит retention-политику '5s:1d,15s:1w,1m:1mon' в массив тиров
 * (от тонких к грубым). Валидирует: res/ttl > 0, разрешения и ttl неубывающие.
 */
export function parseRetention(retention: string): ResolutionTier[] {
  const s = String(retention).trim();
  if (!s) {
    throw new RangeError('Table: retention — непустая строка, например "5s:1d,15s:1w,1m:1mon"');
  }
  const parts = s.split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length === 0) {
    throw new RangeError('Table: retention — хотя бы один тир вида "res:ttl"');
  }
  const tiers: ResolutionTier[] = [];
  for (const part of parts) {
    const m = part.match(/^(\S+):(\S+)$/);
    if (!m) {
      throw new RangeError(`Table: retention — тир в формате "res:ttl" (получено "${part}")`);
    }
    let resMs: number;
    let ttlMs: number;
    try {
      resMs = Interval.parseInterval(m[1]);
    } catch (e) {
      throw new RangeError(`Table: retention — разрешение "${m[1]}": ${(e as Error).message}`);
    }
    try {
      ttlMs = Interval.parseInterval(m[2]);
    } catch (e) {
      throw new RangeError(`Table: retention — ttl "${m[2]}": ${(e as Error).message}`);
    }
    if (!Number.isFinite(resMs) || resMs <= 0) {
      throw new RangeError(`Table: retention — res должно быть > 0 (получено "${part}")`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(`Table: retention — ttl должно быть > 0 (получено "${part}")`);
    }
    tiers.push({ resMs, ttlMs });
  }
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].resMs < tiers[i - 1].resMs) {
      throw new RangeError('Table: retention — разрешения должны неубывать слева направо (тонкий → грубый)');
    }
    if (tiers[i].ttlMs < tiers[i - 1].ttlMs) {
      throw new RangeError('Table: retention — ttl должны неубывать слева направо (свежее живёт дольше? нет — ttl растёт)');
    }
  }
  return tiers;
}

/**
 * Table: один метрик = несколько тиров разрешения (каждый — журнал).
 * См. шапку файла.
 */
export class Table {
  readonly name: string;
  readonly store: TableStore;
  readonly tiers: ResolutionTier[];
  /** Поля, агрегируемые при rollup (поле → fn). Остальные не-ts поля — размеры. */
  readonly agg: Record<string, AggFn>;
  /** Поля-размеры (group-by при rollup): схема минус ts и минус agg-поля. */
  readonly dims: string[];
  readonly schema: Schema;
  private readonly nowProvider: () => number;
  private readonly tierJournals: Journal[];
  private readonly tierNames: string[];
  private checkpoints: Record<string, number>;
  private readonly cpPath: string;

  constructor(store: TableStore, name: string, config: TableConfig = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new RangeError('Table: name — непустая строка');
    }
    if (name.includes('/')) {
      throw new RangeError('Table: name не должно содержать "/" (тиры создаются как <name>/r<res>)');
    }
    this.store = store;
    this.name = name;

    // --- тир'ы -----------------------------------------------------------
    let tiers: ResolutionTier[];
    if (config.tiers && config.tiers.length > 0) {
      tiers = config.tiers.slice();
      Table.validateTiers(tiers);
    } else if (config.retention) {
      tiers = parseRetention(config.retention);
    } else {
      throw new RangeError('Table: укажите retention (строка "5s:1d,…") или tiers (массив)');
    }
    this.tiers = tiers;

    // --- схема -----------------------------------------------------------
    const schema: Schema = { ...(config.schema ?? {}) };
    if (!schema['ts']) schema['ts'] = 'delta';
    if (Object.keys(schema).length <= 1) schema['value'] = 'auto';
    this.schema = schema;

    // --- агрегация rollup ------------------------------------------------
    let agg = config.agg;
    if (!agg || Object.keys(agg).length === 0) {
      const firstField = Object.keys(schema).find(f => f !== 'ts');
      if (!firstField) {
        throw new RangeError('Table: схема должна содержать хотя бы одну не-ts колонку для rollup');
      }
      agg = { [firstField]: 'avg' };
    }
    for (const [f, fn] of Object.entries(agg)) {
      if (!isAggFn(fn)) {
        throw new RangeError(`Table: agg.${f} — fn min|max|sum|avg|count (получено ${String(fn)})`);
      }
    }
    this.agg = agg;
    this.dims = Object.keys(schema).filter(f => f !== 'ts' && !(f in agg));

    this.nowProvider = config.nowProvider ?? Date.now;

    // --- открываем журнал на каждый тир ---------------------------------
    const opts: OpenJournalOptions = {};
    if (config.rowsPerSegment !== undefined) opts.rowsPerSegment = config.rowsPerSegment;
    this.tierNames = tiers.map((t, i) => `${name}/r${t.resMs}`);
    this.tierJournals = tiers.map((t, i) =>
      store.openJournal(
        this.tierNames[i],
        schema,
        { table: name, tier: i, resMs: t.resMs, ttlMs: t.ttlMs },
        opts,
      ),
    );

    // --- чекпоинты rollup ------------------------------------------------
    this.cpPath = path.join(store.baseDir, 'journals', name, '_rollup.json');
    this.checkpoints = Table.readJson(this.cpPath);
  }

  /** Валидирует явный массив тиров (res/ttl > 0, неубывающие). */
  static validateTiers(tiers: ResolutionTier[]): void {
    if (tiers.length === 0) throw new RangeError('Table: tiers — непустой массив');
    for (const t of tiers) {
      if (!Number.isFinite(t.resMs) || t.resMs <= 0) {
        throw new RangeError('Table: tiers — resMs должно быть > 0');
      }
      if (!Number.isFinite(t.ttlMs) || t.ttlMs <= 0) {
        throw new RangeError('Table: tiers — ttlMs должно быть > 0');
      }
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].resMs < tiers[i - 1].resMs) {
        throw new RangeError('Table: tiers — разрешения должны неубывать (тонкий → грубый)');
      }
      if (tiers[i].ttlMs < tiers[i - 1].ttlMs) {
        throw new RangeError('Table: tiers — ttl должны неубывать (по возрастанию возраста)');
      }
    }
  }

  // --------------------------------------------------
  // Базовое
  // --------------------------------------------------

  /** «Текущее время» таблицы (через nowProvider). */
  now(): number {
    return this.nowProvider();
  }

  get isOpen(): boolean {
    return this.tierJournals.every(j => j.isOpen);
  }

  /** Имя журнала тира (для отладки): `<name>/r<resMs>`. */
  tierJournalName(i: number): string {
    if (i < 0 || i >= this.tiers.length) throw new RangeError(`Table: нет тира ${i}`);
    return this.tierNames[i];
  }

  /** Запись строки в самый тонкий тир (0). */
  append(row: Row): void {
    this._assertOpen();
    this.tierJournals[0].append(row);
  }

  /** Слить активные сегменты всех тиров на диск (WAL срезается). */
  flush(): void {
    this._assertOpen();
    for (const j of this.tierJournals) j.flush();
  }

  /** Закрыть все тиры. */
  close(): void {
    for (const n of this.tierNames) {
      if (this.store.openJournals.has(n)) this.store.closeJournal(n);
    }
  }

  private _assertOpen(): void {
    if (!this.isOpen) throw new Error('Table: не открыта (вызван close())');
  }

  // --------------------------------------------------
  // Чтение (разбивка по «возрасту» на окна тиров)
  // --------------------------------------------------

  private _resolveTs(v: number | string, argName: string): number {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new RangeError(`Table: ${argName} — конечное число (мс)`);
      return v;
    }
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    try {
      return Interval.partOfPeriod(s, this.now());
    } catch (e) {
      throw new RangeError(`Table: ${argName} — время (число мс или 'now-1d'): ${(e as Error).message}`);
    }
  }

  /**
   * Чтение [start, end] (обе границы включительно). Диапазон разбивается по
   * «возрасту» на окна тиров (now−ttl0:now → тир0, now−ttl1:now−ttl0 → тир1, …);
   * внутри тира — скан с pruning по .meta; ответ склеивается по ts ↑.
   *
   * Самый тонкий тир (0) опрашивается на всём диапазоне [start, end] — это
   * «источник», где лежит и свежее, и ещё не перенесённое (rollup-lag);
   * перенесённое уже purged из него, поэтому дублей нет.
   */
  query(start: number | string, end: number | string): Row[] {
    this._assertOpen();
    const startTs = this._resolveTs(start, 'query(start)');
    const endTs = this._resolveTs(end, 'query(end)');
    if (endTs < startTs) throw new RangeError('Table: query — start должен быть <= end');

    const now = this.now();
    const out: Row[] = [];
    for (let i = 0; i < this.tiers.length; i++) {
      const ttl = this.tiers[i].ttlMs;
      let winStart: number;
      let winEnd: number;
      if (i === 0) {
        // Тонкий тир — источник: весь запрошенный диапазон до now (в нём лежит
        // и свежее, и ещё не перенесённое; перенесённое уже purged — дублей нет).
        winStart = startTs;
        winEnd = Math.min(endTs, now);
      } else {
        // Грубый тир — своё «возрастное» окно.
        winStart = Math.max(startTs, now - ttl);
        winEnd = Math.min(endTs, now - this.tiers[i - 1].ttlMs);
      }
      if (winStart > winEnd) continue;
      const rows = this.tierJournals[i].scan({ start: winStart, end: winEnd });
      for (const r of rows) out.push(r);
    }
    out.sort((a, b) => (Table.tsOf(a) ?? 0) - (Table.tsOf(b) ?? 0));
    return out;
  }

  /**
   * Агрегация min/max/sum/avg/count по диапазону (сквозь все тиры).
   * Материализует строки через query() и агрегирует по запрошенным полям.
   */
  aggregate(
    start: number | string,
    end: number | string,
    exprs: { field: string; fn: AggFn }[],
  ): Record<string, number | null> {
    if (!Array.isArray(exprs) || exprs.length === 0) {
      throw new RangeError('Table: aggregate() — exprs: непустой массив { field, fn }');
    }
    for (const e of exprs) {
      if (!e || typeof e.field !== 'string' || e.field.length === 0) {
        throw new RangeError('Table: aggregate() — expr.field: непустое имя поля');
      }
      if (!isAggFn(e.fn)) {
        throw new RangeError(`Table: aggregate() — expr.fn: min|max|sum|avg|count (получено ${String(e.fn)})`);
      }
    }
    const rows = this.query(start, end);
    const fields = [...new Set(exprs.map(e => e.field))];
    const values: Record<string, number[]> = {};
    for (const f of fields) values[f] = [];
    for (const r of rows) {
      for (const f of fields) {
        const v = r[f];
        if (typeof v === 'number' && Number.isFinite(v)) values[f].push(v);
      }
    }
    const out: Record<string, number | null> = {};
    for (const e of exprs) {
      const vals = values[e.field];
      let val: number | null;
      switch (e.fn) {
        case 'count': val = vals.length; break;
        case 'sum': val = vals.length ? vals.reduce((a, b) => a + b, 0) : null; break;
        case 'min': val = vals.length ? Math.min(...vals) : null; break;
        case 'max': val = vals.length ? Math.max(...vals) : null; break;
        case 'avg': val = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; break;
      }
      out[`${e.field}__${e.fn}`] = val;
    }
    return out;
  }

  /**
   * Квантили (percentile) значения `value` в [start, end] (Фаза 5): p50/p90/p95/p99.
   * Материализует строки через query() и считает линейной интерполяцией.
   *
   * ```ts
   * t.percentile('now-1h', 'now', [0.5, 0.95, 0.99]);
   * // → { p50: 41.2, p95: 98.7, p99: 99.9 }
   * ```
   */
  percentile(
    start: number | string,
    end: number | string,
    levels: number | number[],
  ): Record<string, number | null> {
    const lv = Array.isArray(levels) ? levels.slice() : [levels];
    for (const q of lv) {
      if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0 || q >= 1) {
        throw new RangeError(`Table: percentile() — level: число в (0, 1) (получено ${String(q)})`);
      }
    }
    const rows = this.query(start, end);
    const vals: number[] = [];
    for (const r of rows) {
      const v = r.value;
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const out: Record<string, number | null> = {};
    for (const q of lv) {
      out[percentileKey(q)] = vals.length === 0 ? null : percentileOf(vals, q);
    }
    return out;
  }

  // --------------------------------------------------
  // Rollup (fine → coarse) + TTL purge
  // --------------------------------------------------

  /**
   * Переносит состарившееся из каждого мелкого тира в следующий более грубый
   * (downsample до разрешения грубого + агрегация `agg`), затем чистит мелкий
   * тир (TTL). Идемпотентен по чекпоинту. `now` — явное «текущее время»
   * (по умолчанию nowProvider).
   *
   * Возвращает отчёт { pairs, rolledRows, purgedRows }.
   */
  rollup(now?: number): RollupReport {
    this._assertOpen();
    const nowTs = typeof now === 'number' ? now : this.now();
    if (!Number.isFinite(nowTs)) throw new RangeError('Table: rollup(now) — now: конечное число (мс)');

    let pairs = 0;
    let rolledRows = 0;
    let purgedRows = 0;

    for (let i = 0; i + 1 < this.tiers.length; i++) {
      const fine = this.tierJournals[i];
      const coarse = this.tierJournals[i + 1];
      const fineTtl = this.tiers[i].ttlMs;
      const coarseRes = this.tiers[i + 1].resMs;
      const maxRollable = nowTs - fineTtl; // всё, что «возрастом» старше fineTtl
      const cpKey = `${i}->${i + 1}`;
      const cp = this.checkpoints[cpKey] ?? 0;
      if (maxRollable <= cp) continue; // уже всё перенесено — идемпотентно

      // Читаем строки мелкого тира в (cp, maxRollable].
      let rows: Row[];
      try {
        rows = fine.scan({ start: cp, end: maxRollable });
      } catch {
        rows = [];
      }
      rows = rows.filter(r => {
        const ts = r['ts'];
        return typeof ts === 'number' && Number.isFinite(ts) && ts > cp && ts <= maxRollable;
      });

      // Группируем по (бакет грубого разрешения, размеры dims).
      const aggFields = Object.keys(this.agg);
      const groups = new Map<
        string,
        { bucket: number; dims: Record<string, JsonValue>; values: Record<string, number[]> }
      >();
      for (const row of rows) {
        const bucket = Interval.roundTime(row['ts'] as number, coarseRes);
        const dimVals: Record<string, JsonValue> = {};
        for (const d of this.dims) dimVals[d] = row[d] ?? null;
        const dimKey = this.dims.map(d => JSON.stringify(dimVals[d])).join('\u001f');
        const key = `${bucket}\u001e${dimKey}`;
        let g = groups.get(key);
        if (!g) {
          g = { bucket, dims: dimVals, values: {} };
          for (const f of aggFields) g.values[f] = [];
          groups.set(key, g);
        }
        for (const f of aggFields) {
          const v = row[f];
          if (typeof v === 'number' && Number.isFinite(v)) g.values[f].push(v);
        }
      }

      // Записываем агрегаты в грубый тир.
      for (const g of groups.values()) {
        const outRow: Row = { ts: g.bucket, ...g.dims };
        for (const f of aggFields) {
          const vals = g.values[f];
          outRow[f] = vals.length > 0 ? Table.applyAgg(this.agg[f], vals) : null;
        }
        coarse.append(outRow);
      }
      if (rows.length > 0) coarse.flush();

      // Чекпоинт — атомарно ДО purge (по плану). Повторный rollup того же
      // окна идемпотентен: окно (cp, maxRollable] больше не попадает в работу.
      this.checkpoints[cpKey] = maxRollable;
      Table.writeJson(this.cpPath, this.checkpoints);

      // Чистим мелкий тир: всё с ts <= maxRollable уже в грубом.
      const purged = fine.purge(maxRollable + 1);
      purgedRows += purged.removedRows ?? 0;
      pairs++;
      rolledRows += rows.length;
    }

    return { pairs, rolledRows, purgedRows };
  }

  /** Примени fn к списку чисел. */
  static applyAgg(fn: AggFn, vals: number[]): number {
    switch (fn) {
      case 'count': return vals.length;
      case 'sum': return vals.reduce((a, b) => a + b, 0);
      case 'min': return Math.min(...vals);
      case 'max': return Math.max(...vals);
      case 'avg': return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  }

  // --------------------------------------------------
  // Статистика
  // --------------------------------------------------

  /** Статус каждого тира: rows/bytes/minTs/maxTs. */
  stats(): TableTierStat[] {
    this._assertOpen();
    return this.tiers.map((t, i) => {
      const j = this.tierJournals[i];
      const st = j.stats();
      let bytes = 0;
      let minTs: number | null = null;
      let maxTs: number | null = null;
      for (const id of j.closedSegmentIds()) {
        const info = j.closedSegmentInfo(id);
        if (!info) continue;
        bytes += info.bytes ?? 0;
        if (info.minTs !== null) minTs = minTs === null ? info.minTs : Math.min(minTs, info.minTs);
        if (info.maxTs !== null) maxTs = maxTs === null ? info.maxTs : Math.max(maxTs, info.maxTs);
      }
      if (st.timeRange) {
        const [lo, hi] = st.timeRange;
        if (lo !== null) minTs = minTs === null ? lo : Math.min(minTs, lo);
        if (hi !== null) maxTs = maxTs === null ? hi : Math.max(maxTs, hi);
      }
      return { tier: i, resMs: t.resMs, ttlMs: t.ttlMs, rows: st.totalRows, bytes, minTs, maxTs };
    });
  }

  // --------------------------------------------------
  // Вспомогательные
  // --------------------------------------------------

  private static tsOf(row: Row): number | null {
    const v = row['ts'];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  private static readJson(p: string): Record<string, number> {
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (obj && typeof obj === 'object') {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'number') out[k] = v;
        }
        return out;
      }
    } catch {
      /* файла нет или повреждён — считаем, что чекпоинтов нет */
    }
    return {};
  }

  private static writeJson(p: string, obj: Record<string, number>): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, p);
  }
}

/** Открыть таблицу (фабрика). Эквивалент store.openTable(name, config). */
export function openTable(store: TableStore, name: string, config: TableConfig = {}): Table {
  return new Table(store, name, config);
}
