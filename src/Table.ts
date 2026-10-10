// ============================================================
// Table.ts — Table: единый класс «таблица» для тайм-серий (фаза 6)
//
// Одна таблица — одна сущность с двумя физическими режимами:
//   - без retention — один журнал <name>;
//   - с retention   — журналы <name>/r<res> (тиры разрешения), rollup
//                     переносит состарившееся на грубые тиры (TTL чистит).
//
// Движок компактизации — из def.kind: 'log' (нет), 'upsert', 'summing',
// 'collapsing' (ClickHouse-семантика). Дескриптор пишется в метаданные
// журнала и применяется при compact(). Для тир-таблиц эффективный ключ =
// ['ts', …key без ts] — время часть ключа, чтобы compact не «схлопывал»
// разные моменты времени.
//
//   const t = store.open('cpu', {
//     columns: { ts: 'delta', value: 'auto', host: 'dictionary' },
//     retention: '5s:1d,15s:1w,1m:1mon',
//     agg: { value: 'avg' },
//   });
//   t.append({ ts: now, value: 42.3, host: 'web-1' });
//   t.query('now-30d', 'now');   // сам собирает ответ из нужных тиров
//   t.rollup();                  // переносит состарившееся на грубые тиры
//   t.stats();                   // { tier, resMs, ttlMs, rows, bytes, … }
//
//   const u = store.open('users', {
//     kind: 'upsert', key: ['host', 'metric'],
//     columns: { ts: 'auto', host: 'dictionary', metric: 'auto', value: 'auto' },
//   });
//   u.append({ ts: now, host: 'web-1', metric: 'cpu', value: 42 });
//   u.compact();                 // дедупликация по (host, metric): остаётся последняя
//
// Rollup идемпотентен по чекпоинту (последний перенесённый maxTs на пару
// тиров, пишется атомарно ДО purge мелкого тира) — повторный вызов того же
// окна ничего не дублирует (границы бакетов детерминированы через roundTime).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { Interval } from './Interval.ts';
import { Journal } from './Journal.ts';
import { Percentile } from './Percentile.ts';
import { Rollup } from './Rollup.ts';
import type { RollupConfig } from './Rollup.ts';
import type {
  AggFn,
  AggregateExpr,
  CompactResult,
  Metadata,
  OpenJournalOptions,
  PurgeResult,
  ResolutionTier,
  Row,
  RollupReport,
  Schema,
  ScanOptions,
  TableTierStat,
  TimelineBucket,
} from './types.ts';
import type { AnyTableDef, TableRuntime } from './compaction/define.ts';
import { Descriptor, ENGINE_META_KEY } from './compaction/Descriptor.ts';
import { RetentionEngine } from './RetentionEngine.ts';
import type { ApplyReport, ConversionPlan, ScanWhere, TierStatus } from './types.ts';
import { Sql } from './Sql.ts';
import { SqlError } from './SqlError.ts';

// Минимальный структурный интерфейс хранилища (Store из store.ts подходит
// без импорта — исключает циклическую зависимость store.ts ↔ table.ts).
export interface TableStore {
  readonly baseDir: string;
  openJournals: Map<string, Journal>;
  _openJournal(
    name: string,
    schema: Schema,
    metadata?: Metadata,
    opts?: OpenJournalOptions,
  ): Journal;
  _closeJournal(name: string): void;
}

const AGG_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count']);
const isAggFn = (fn: unknown): fn is AggFn => AGG_FNS.has(String(fn));

/**
 * Троттлинг авто-ролапа/авто-purge: не чаще, чем раз в 30 секунд. Дешёвая
 * проверка «пора ли» выполняется на каждый append, но сама работа (rollup/purge
 * перекодирует данные) не чаще, чем раз в этот интервал — чтобы горячий цикл
 * записей не дёргал диск на каждую строку. 0 выключает троттлинг (тесты).
 */
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 30_000;

/** Отчёт rollupOne: один перенос (тонкий тир → целевой тир разрешения res). */
export interface RollupOneReport {
  /** Индекс целевого тира (по порядку разрешения). */
  tierIndex: number;
  /** Разрешение целевого тира (мс). */
  resMs: number;
  /** Откуда начиналось окно переноса (мс). */
  fromMs: number;
  /** Докуда закончилось окно переноса (мс). */
  toMs: number;
  /** Сколько строк прочитано из тонкого тира. */
  sourceRows: number;
  /** Сколько строк записано в целевой тир. */
  promotedRows: number;
}

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
      throw new RangeError('Table: retention — ttl должны неубывать слева направо');
    }
  }
  return tiers;
}

/**
 * Table: одна «таблица» — единый класс для двух режимов (см. шапку файла).
 */
export class Table {
  readonly name: string;
  readonly store: TableStore;
  /** Описание таблицы (def) из манифеста/создания. */
  readonly def: AnyTableDef;
  readonly schema: Schema;
  /** Движок компактизации: 'log' | 'upsert' | 'summing' | 'collapsing'. */
  readonly kind: 'log' | 'upsert' | 'summing' | 'collapsing';
  /** Тиры разрешения (null — одиночный журнал, без retention). */
  readonly tiers: ResolutionTier[] | null;
  /** Поля, агрегируемые при rollup (поле → fn). Остальные не-ts поля — размеры. */
  readonly agg: Record<string, AggFn>;
  /** Поля-размеры (group-by при rollup): схема минус ts и минус agg-поля. */
  readonly dims: string[];

  private readonly nowProvider: () => number;
  private readonly journalNames: string[];
  private readonly journals: Journal[];
  private checkpoints: Record<string, number>;
  private readonly cpPath: string;
  private readonly engines: RetentionEngine[];

  // --- авто-обслуживание (включено по умолчанию, только тир-режим) --------
  /** Авто-ролап при append (по умолчанию true). */
  readonly autoRollup: boolean;
  /** Авто-purge (TTL грубейшего тира) при append (по умолчанию true). */
  readonly autoPurge: boolean;
  /** Троттлинг авто-ролапа/авто-purge (по умолчанию 30 000 мс; 0 — каждый append). */
  readonly maintenanceMinIntervalMs: number;
  /** Время последнего авто-обслуживания (в единицах nowProvider). */
  private _lastMaintain = 0;

  constructor(store: TableStore, name: string, def: AnyTableDef) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new RangeError('Table: name — непустая строка');
    }
    if (name.includes('/')) {
      throw new RangeError('Table: name не должно содержать "/" (тиры создаются как <name>/r<res>)');
    }
    if (!def || typeof def !== 'object') {
      throw new RangeError('Table: def обязателен ({ columns: { … } })');
    }
    if (def.name !== undefined && def.name !== name) {
      throw new RangeError(`Table: name '${name}' не совпадает с def.name '${def.name}'`);
    }
    const columns = def.columns;
    if (!columns || typeof columns !== 'object' || Object.keys(columns).length === 0) {
      throw new RangeError('Table: def.columns — непустая схема { поле: тип }');
    }
    this.store = store;
    this.name = name;
    this.def = def;

    // --- схема -----------------------------------------------------------
    const schema: Schema = { ...columns };
    if (!schema['ts']) schema['ts'] = 'delta';
    this.schema = schema;

    // --- движок -----------------------------------------------------------
    this.kind = def.kind ?? 'log';
    if (this.kind !== 'log') {
      const key = (def as { key?: string[] }).key;
      if (!Array.isArray(key) || key.length === 0 || key.some(f => typeof f !== 'string' || f.length === 0)) {
        throw new RangeError(`Table: kind '${this.kind}' — def.key: непустой массив полей ключа`);
      }
      for (const f of key) {
        if (!(f in schema)) throw new RangeError(`Table: kind '${this.kind}' — ключ '${f}' не в схеме`);
      }
    }

    // --- агрегация rollup ------------------------------------------------
    let agg = def.agg;
    if (!agg || Object.keys(agg).length === 0) {
      agg = Table._defaultAgg(this.kind, schema, def);
    }
    for (const [f, fn] of Object.entries(agg)) {
      if (!(f in schema)) throw new RangeError(`Table: agg.${f} — поле не найдено в columns`);
      if (!isAggFn(fn)) {
        throw new RangeError(`Table: agg.${f} — fn min|max|sum|avg|count (получено ${String(fn)})`);
      }
    }
    this.agg = agg;

    // --- размеры rollup ----------------------------------------------------
    if (def.dims && def.dims.length > 0) {
      for (const f of def.dims) {
        if (!(f in schema)) throw new RangeError(`Table: dims — поле "${f}" не найдено в columns`);
      }
      this.dims = def.dims.slice();
    } else {
      this.dims = Object.keys(schema).filter(f => f !== 'ts' && !(f in agg));
    }

    // --- тиры или одиночный журнал ----------------------------------------
    this.tiers = def.tiers && def.tiers.length > 0
      ? (() => { Table.validateTiers(def.tiers!); return def.tiers!.slice(); })()
      : def.retention
        ? parseRetention(def.retention)
        : null;

    this.nowProvider = def.nowProvider ?? Date.now;

    // --- авто-обслуживание ------------------------------------------------
    this.autoRollup = def.autoRollup ?? true;
    this.autoPurge = def.autoPurge ?? true;
    const minInterval = def.maintenanceMinIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    if (minInterval < 0 || !Number.isFinite(minInterval)) {
      throw new RangeError('Table: maintenanceMinIntervalMs — число >= 0');
    }
    this.maintenanceMinIntervalMs = minInterval;
    // Первое авто-обслуживание не раньше, чем через maintenanceMinIntervalMs
    // после создания — иначе бы сработало на самом первом append.
    this._lastMaintain = this.nowProvider();

    // --- дескриптор движка (в метаданные журнала; compact() применяет) ----
    let descriptor: Descriptor | null = null;
    if (this.kind !== 'log') {
      const d = def as {
        key: string[];
        version?: string;
        sum?: string[];
        sign?: string;
      };
      const baseKey = d.key.filter(f => f !== 'ts');
      // Тир-режим: время — часть ключа (compact не схлопывает разные бакеты).
      const key = this.tiers ? ['ts', ...baseKey] : d.key;
      descriptor = new Descriptor({
        kind: this.kind,
        key,
        version: d.version,
        sum: d.sum,
        sign: d.sign,
      });
    }

    // --- открываем журнал(и) ----------------------------------------------
    const opts: OpenJournalOptions = {};
    if (def.rowsPerSegment !== undefined) opts.rowsPerSegment = def.rowsPerSegment;
    Object.assign(opts, def.opts ?? {});
    // Rollup-строки содержат null — agg-поля в тир-режиме пишутся как 'auto'.
    const tierSchema = this.tiers ? Table._tierSchema(schema, this.agg) : schema;

    if (this.tiers) {
      this.journalNames = this.tiers.map(t => `${name}/r${t.resMs}`);
      this.journals = this.tiers.map((t, i) =>
        store._openJournal(
          this.journalNames[i],
          tierSchema,
          {
            table: name,
            tier: i,
            resMs: t.resMs,
            ttlMs: t.ttlMs,
            formatVersion: 3,
            ...(descriptor ? { [ENGINE_META_KEY]: descriptor.toMeta() } : {}),
          },
          opts,
        ),
      );
      this.cpPath = path.join(store.baseDir, 'journals', name, '_rollup.json');
      this.checkpoints = Table.readJson(this.cpPath);
    } else {
      this.journalNames = [name];
      this.journals = [
        store._openJournal(
          name,
          schema,
          { formatVersion: 3, ...(descriptor ? { [ENGINE_META_KEY]: descriptor.toMeta() } : {}) },
          opts,
        ),
      ];
      this.cpPath = '';
      this.checkpoints = {};
    }

    // --- движок retention-кодирования (Фаза 4), если задан def.storage ----
    this.engines = def.storage
      ? this.journals.map(j => new RetentionEngine(j, def.storage?.tiers))
      : [];
  }

  /** Схема тира: agg-поля — 'auto' (rollup-строки могут нести null). */
  private static _tierSchema(schema: Schema, agg: Record<string, AggFn>): Schema {
    const out = { ...schema };
    for (const f of Object.keys(agg)) out[f] = 'auto';
    return out;
  }

  /**
   * Дефолтная агрегация rollup при отсутствии def.agg:
   * - log/upsert — первое не-ts не-agg поле → 'avg';
   * - summing/collapsing — поля sum/sign (или первое не-ts поле) → 'sum'.
   */
  private static _defaultAgg(
    kind: string,
    schema: Schema,
    def: AnyTableDef,
  ): Record<string, AggFn> {
    if (kind === 'summing' || kind === 'collapsing') {
      const d = def as { sum?: string[]; sign?: string };
      const out: Record<string, AggFn> = {};
      if (typeof d.sign === 'string' && d.sign.length > 0) out[d.sign] = 'sum';
      if (Array.isArray(d.sum)) {
        for (const f of d.sum) out[f] = 'sum';
      }
      if (Object.keys(out).length > 0) return out;
      const first = Object.keys(schema).find(f => f !== 'ts');
      if (first) return { [first]: 'sum' };
      throw new RangeError(`Table: kind '${kind}' — нужны не-ts поля для агрегации`);
    }
    const first = Object.keys(schema).find(f => f !== 'ts');
    if (!first) {
      throw new RangeError('Table: схема должна содержать хотя бы одну не-ts колонку для rollup');
    }
    return { [first]: 'avg' };
  }

  /** Валидирует явный массив тиров (res/ttl > 0, неубывающие). */
  static validateTiers(tiers: ResolutionTier[]): void {
    if (!tiers || tiers.length === 0) throw new RangeError('Table: tiers — непустой массив');
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
    return this.journals.every(j => j.isOpen);
  }

  /** Имя журнала тира (для отладки): одиночный режим — <name>, тир — <name>/r<resMs>. */
  journalName(i: number): string {
    if (i < 0 || i >= this.journals.length) throw new RangeError(`Table: нет журнала ${i}`);
    return this.journalNames[i];
  }

  /** Открытый журнал под индексом (0 — самый тонкий/единственный). */
  journal(i: number): Journal {
    if (i < 0 || i >= this.journals.length) throw new RangeError(`Table: нет журнала ${i}`);
    return this.journals[i];
  }

  /** Запись строки в самый тонкий журнал (0). После записи — авто-обслуживание
   *  (ролап + purge), если включено, тир-режим и не троттлинговано. */
  append(row: Row): void {
    this._assertOpen();
    this.journals[0].append(row);
    if (this.tiers) this._maybeMaintain();
  }

  /**
   * Авто-обслуживание (тир-режим): перенос состарившихся строк между тирами
   * (rollup) и удаление из грубейшего тира данных старше его TTL (purge).
   * Идемпотентно (rollup чекпоинтит, purge фильтрует по ts) и троттлинговано
   * maintenanceMinIntervalMs. Ошибки обслуживания не роняют запись.
   */
  private _maybeMaintain(): void {
    if (!this.tiers) return;
    if (!this.autoRollup && !this.autoPurge) return;
    const now = this.nowProvider();
    if (now - this._lastMaintain < this.maintenanceMinIntervalMs) return;
    this._lastMaintain = now;

    if (this.autoRollup) {
      try {
        this.rollup(now);
      } catch (e) {
        console.error(`Table ${this.name}: авто-ролап не сработал:`, e);
      }
    }
    if (this.autoPurge) {
      const i = this.tiers.length - 1;
      try {
        this.journals[i].purge(now - this.tiers[i].ttlMs);
      } catch (e) {
        console.error(`Table ${this.name}: авто-purge тира ${i} не сработал:`, e);
      }
    }
  }

  /** Слить активные сегменты всех журналов на диск (WAL срезается). */
  flush(): void {
    this._assertOpen();
    for (const j of this.journals) j.flush();
  }

  /** Закрыть все журналы таблицы. */
  close(): void {
    for (const n of this.journalNames) {
      if (this.store.openJournals.has(n)) this.store._closeJournal(n);
    }
  }

  private _assertOpen(): void {
    if (!this.isOpen) throw new Error('Table: не открыта (вызван close())');
  }

  // --------------------------------------------------
  // Чтение
  // --------------------------------------------------

  /**
   * Чтение [start, end] (обе границы включительно).
   *
   * Одиночный режим — делегирует журналу (скан с pruning по .meta).
   * Тир-режим — диапазон разбивается по «возрасту» на окна тиров
   * (now−ttl0:now → тир0, now−ttl1:now−ttl0 → тир1, …); самый тонкий тир —
   * «источник» на всём диапазоне (в нём лежит и свежее, и ещё не перенесённое;
   * перенесённое уже purged из него, поэтому дублей нет). Ответ — по ts ↑.
   */
   query(start: number | string, end: number | string): Row[] {
    this._assertOpen();
    const [startTs, endTs] = Interval.period(start, end, this.now());

    if (!this.tiers) {
      return this.journals[0].scan({ start: startTs, end: endTs });
    }

    const now = this.now();
    const out: Row[] = [];
    for (let i = 0; i < this.tiers.length; i++) {
      const ttl = this.tiers[i].ttlMs;
      let winStart: number;
      let winEnd: number;
      if (i === 0) {
        winStart = startTs;
        winEnd = Math.min(endTs, now);
      } else {
        winStart = Math.max(startTs, now - ttl);
        winEnd = Math.min(endTs, now - this.tiers[i - 1].ttlMs);
      }
      if (winStart > winEnd) continue;
      const rows = this.journals[i].scan({ start: winStart, end: winEnd });
      for (const r of rows) out.push(r);
    }
    out.sort((a, b) => (Table.tsOf(a) ?? 0) - (Table.tsOf(b) ?? 0));
    return out;
  }

  /** Все строки таблицы (по ts ↑). Одиночный журнал — прямая делегация. */
  allRows(): Row[] {
    this._assertOpen();
    if (!this.tiers) return this.journals[0].allRows();
    const rows = this.query(0, this.now());
    rows.sort((a, b) => (Table.tsOf(a) ?? 0) - (Table.tsOf(b) ?? 0));
    return rows;
  }

  /** Последние `count` строк (по ts). Одиночный журнал — прямая делегация. */
  tail(count: number): Row[] {
    this._assertOpen();
    if (count < 0) throw new RangeError('Table: tail — count >= 0');
    if (!this.tiers) return this.journals[0].tail(count);
    return this.allRows().slice(-count);
  }

  /**
   * Скан по опциям (select/where/order/limit/offset/start/end).
   * Одиночный журнал — прямая делегация Journal.scan. Тир-режим —
   * материализация через query() + применение опций по строкам.
   */
  scan(opts: ScanOptions): Row[] {
    this._assertOpen();
    if (!this.tiers) return this.journals[0].scan(opts);

    const now = this.now();
    const [start, end] = Interval.period(opts.start ?? 0, opts.end ?? now, now);
    if (opts.agg || opts.groupBy) {
      throw new SqlError('Table: scan — agg/groupBy в тир-режиме: используйте aggregate()/sql()');
    }
    let rows = this.query(start, end);
    if (opts.where && opts.where.length > 0) {
      rows = rows.filter(r => opts.where!.every(w => Table._matchWhere(r, w)));
    }
    rows = Table._applyScanOptions(rows, opts);
    if (opts.order === 'desc') {
      rows = rows.sort((a, b) => (Table.tsOf(b) ?? 0) - (Table.tsOf(a) ?? 0));
    }
    return rows;
  }

  /**
   * SQL-скан: одиночный режим — делегирует журналу (включая INSERT);
   * тир-режим — разбор SELECT через Sql.parse + скан через query().
   */
   sql(query: string): Row[] | number | Record<string, number | null> {
    this._assertOpen();
    const head = query.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
    if (head === 'INSERT') {
      const ins = Sql.parseInsert(query);
      if (ins.name !== this.name && !ins.name.startsWith(`${this.name}/`)) {
        throw new SqlError(`SQL: INSERT INTO ${ins.name} — не таблица '${this.name}'`);
      }
      for (const row of ins.rows) this.append(row);
      return ins.rows.length;
    }
    const opts = Sql.parse(query);
    if (opts.table !== undefined && opts.table !== this.name) {
      throw new SqlError(`SQL: таблица '${opts.table}' — это '${this.name}'`);
    }
    if (!this.tiers) return this.journals[0].scan(opts);

    const now = this.now();
    const [start, end] = Interval.period(opts.start ?? 0, opts.end ?? now, now);

    // Агрегации (без GROUP BY) — через aggregate().
    if (opts.agg) {
      if (opts.groupBy) {
        throw new SqlError('SQL: GROUP BY в тир-режиме — пока не поддерживается');
      }
      const exprs: AggregateExpr[] = [];
      for (const [f, fns] of Object.entries(opts.agg)) {
        for (const fn of fns) exprs.push({ field: f, fn });
      }
      if (opts.where && opts.where.length > 0) {
        throw new SqlError('SQL: WHERE + агрегации в тир-режиме — пока не поддерживаются');
      }
      return this.aggregate(start, end, exprs);
    }
    if (opts.groupBy) {
      throw new SqlError('SQL: GROUP BY в тир-режиме — пока не поддерживается');
    }

    let rows = this.query(start, end);
    if (opts.where && opts.where.length > 0) {
      rows = rows.filter(r => opts.where!.every(w => Table._matchWhere(r, w)));
    }
    return Table._applyScanOptions(rows, opts);
  }

  /** select/limit/offset по готовым строкам (тир-режим sql()). */
  private static _applyScanOptions(rows: Row[], opts: ScanOptions): Row[] {
    let out = rows;
    const select = opts.select;
    if (select && select.length > 0) {
      out = out.map(r => {
        const o: Row = {};
        for (const f of select) o[f] = r[f] ?? null;
        return o;
      });
    }
    if (opts.offset) out = out.slice(opts.offset);
    if (opts.limit !== undefined && opts.limit >= 0) out = out.slice(0, opts.limit);
    return out;
  }

  /** Оценит одно условие where() для строки (тир-режим sql()). */
  private static _matchWhere(row: Row, w: ScanWhere): boolean {
    const v = row[w.field];
    switch (w.op) {
      case 'eq': return v === w.value;
      case 'ne': return v !== w.value;
      case 'lt': return typeof v === 'number' && v < (w.value as number);
      case 'le': return typeof v === 'number' && v <= (w.value as number);
      case 'gt': return typeof v === 'number' && v > (w.value as number);
      case 'ge': return typeof v === 'number' && v >= (w.value as number);
      case 'in': return Array.isArray(w.value) && w.value.includes(v);
      case 'nin': return Array.isArray(w.value) && !w.value.includes(v);
      case 'isNull': return v === null || v === undefined;
      case 'isNotNull': return v !== null && v !== undefined;
    }
    throw new SqlError(`SQL: where — неизвестный оператор '${w.op}'`);
  }

  /**
   * Таймлайн: плотный ряд бакетов [start, end] (каждый interval) со счётчиком
   * строк. Одиночный режим — делегирует журналу; тир-режим — материализует
   * строки через query() и складывает в бакеты.
   */
  timeline(
    interval: number | string,
    start: number | string,
    end: number | string,
  ): TimelineBucket[] {
    this._assertOpen();
    const int = typeof interval === 'number' ? interval : Interval.parseInterval(interval);
    if (!Number.isFinite(int) || int <= 0) {
      throw new RangeError('Table: timeline — интервал: число мс > 0 или строка вида "15m"');
    }
    const [startTs, endTs] = Interval.period(start, end, this.now());

    if (!this.tiers) {
      return this.journals[0].timeline(int, [startTs, endTs]);
    }

    const rows = this.query(startTs, endTs);
    const n = Math.floor((endTs - startTs) / int);
    const counts = new Array<number>(n).fill(0);
    for (const r of rows) {
      const ts = Table.tsOf(r);
      if (ts === null) continue;
      const idx = Math.floor((ts - startTs) / int);
      if (idx >= 0 && idx < n) counts[idx]++;
    }
    const out: TimelineBucket[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const bStart = startTs + i * int;
      out[i] = {
        start: bStart,
        end: Math.min(bStart + int, endTs),
        count: counts[i],
        hasData: counts[i] > 0,
      };
    }
    return out;
  }

  /**
   * Агрегация min/max/sum/avg/count по диапазону (сквозь все тиры).
   * Материализует строки через query() и агрегирует по запрошенным полям.
   */
  aggregate(
    start: number | string,
    end: number | string,
    exprs: AggregateExpr[],
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
      out[`${e.field}_${e.fn}`] =
        values[e.field].length === 0
          ? e.fn === 'count' ? 0 : null
          : Rollup.applyAgg(e.fn, values[e.field]);
    }
    return out;
  }

  /**
   * Квантили (percentile) значения `value` в [start, end]: p50/p90/p95/p99.
   * Материализует строки через query() и считает линейной интерполяцией.
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
      out[Percentile.key(q)] = vals.length === 0 ? null : Percentile.of(vals, q);
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
   * Только тир-режим; одиночная таблица не имеет грубых тиров.
   * Возвращает отчёт { pairs, rolledRows, purgedRows }.
   */
  rollup(now?: number): RollupReport {
    this._assertOpen();
    if (!this.tiers) {
      throw new RangeError('Table: rollup() — таблица без retention (нет тиров)');
    }
    const nowTs = typeof now === 'number' ? now : this.now();
    if (!Number.isFinite(nowTs)) throw new RangeError('Table: rollup(now) — now: конечное число (мс)');

    let pairs = 0;
    let rolledRows = 0;
    let purgedRows = 0;

    for (let i = 0; i + 1 < this.tiers.length; i++) {
      const fine = this.journals[i];
      const coarse = this.journals[i + 1];
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

      // Группируем по (бакет грубого разрешения, размеры dims) + agg — в
      // чистой функции Rollup.promote().
      const promoted = Rollup.promote(rows, this.agg, this.dims, coarseRes);
      for (const outRow of promoted) coarse.append(outRow);
      if (promoted.length > 0) coarse.flush();

      // Чекпоинт — атомарно ДО purge. Повторный rollup того же окна идемпотентен.
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

  /**
   * Rollup в один целевой тир (явный, по разрешению res): переносит строки из
   * тонких тиров (res < cfg.res) в тир с cfg.res, агрегируя до бакетов cfg.res.
   * Чекпоинтит на паре (тонкий → целевой) — идемпотентно.
   *
   * Только тир-режим. Возвращает отчёт { tierIndex, resMs, … }.
   */
  rollupOne(cfgOrNow: RollupConfig | number, now?: number): RollupOneReport {
    this._assertOpen();
    if (!this.tiers) {
      throw new RangeError('Table: rollupOne() — таблица без retention (нет тиров)');
    }
    let cfg: RollupConfig;
    let nowTs: number;
    if (typeof cfgOrNow === 'number') {
      cfg = { agg: this.agg, dims: this.dims, res: 15_000 };
      nowTs = cfgOrNow;
      if (now !== undefined) nowTs = now;
    } else {
      cfg = cfgOrNow;
      nowTs = now !== undefined ? now : this.now();
    }
    if (!Number.isFinite(nowTs)) throw new RangeError('Table: rollupOne(now) — now: конечное число (мс)');

    const targetIdx = this.tiers.findIndex(t => t.resMs === cfg.res);
    if (targetIdx <= 0) {
      throw new RangeError(`Table: rollupOne() — res ${cfg.res} не совпадает с тиром (или тир 0)`);
    }
    const fineIdx = targetIdx - 1;
    const fine = this.journals[fineIdx];
    const coarse = this.journals[targetIdx];
    const fineTtl = this.tiers[fineIdx].ttlMs;
    const maxRollable = nowTs - fineTtl;
    const cpKey = `${fineIdx}->${targetIdx}`;
    const cp = this.checkpoints[cpKey] ?? 0;
    if (maxRollable <= cp) {
      return {
        tierIndex: targetIdx, resMs: cfg.res, fromMs: cp, toMs: maxRollable,
        sourceRows: 0, promotedRows: 0,
      };
    }

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

    const promoted = Rollup.promote(rows, cfg.agg, cfg.dims, cfg.res);
    for (const outRow of promoted) coarse.append(outRow);
    if (promoted.length > 0) coarse.flush();

    this.checkpoints[cpKey] = maxRollable;
    Table.writeJson(this.cpPath, this.checkpoints);

    const purged = fine.purge(maxRollable + 1);
    void purged;

    return {
      tierIndex: targetIdx,
      resMs: cfg.res,
      fromMs: cp,
      toMs: maxRollable,
      sourceRows: rows.length,
      promotedRows: promoted.length,
    };
  }

  /**
   * Удалить строки до границы (обе границы: остаются ts >= until) из всех
   * журналов таблицы (одиночный режим — из единственного).
   */
  purge(until: number | string): PurgeResult {
    this._assertOpen();
    let removedRows = 0;
    let removedSegments = 0;
    let rewrittenSegments = 0;
    for (const j of this.journals) {
      const r = j.purge(until);
      removedRows += r.removedRows;
      removedSegments += r.removedSegments;
      rewrittenSegments += r.rewrittenSegments;
    }
    return { removedRows, removedSegments, rewrittenSegments };
  }

  /**
   * Компактизация (дедупликация) всех журналов таблицы. Для движков
   * upsert/summing/collapsing — применение семантики по ключу (см. def.kind).
   * Возвращает суммарный отчёт.
   */
  compact(): CompactResult {
    this._assertOpen();
    let mergedSegments = 0;
    let logicalRows = 0;
    let physicalBefore = 0;
    let physicalAfter = 0;
    let collapsedRows = 0;
    for (const j of this.journals) {
      const r = j.compact();
      mergedSegments += r.mergedSegments;
      logicalRows += r.logicalRows;
      physicalBefore += r.physicalBefore;
      physicalAfter += r.physicalAfter;
      collapsedRows += r.collapsedRows;
    }
    return { mergedSegments, logicalRows, physicalBefore, physicalAfter, collapsedRows };
  }

  /** Примени fn к списку чисел (делегация в Rollup.applyAgg). */
  static applyAgg(fn: AggFn, vals: number[]): number {
    return Rollup.applyAgg(fn, vals);
  }

  // --------------------------------------------------
  // Retention-кодирование (Фаза 4) — делегирование RetentionEngine
  // --------------------------------------------------

  /** Есть ли настроенный движок retention-кодирования (def.storage). */
  get hasStorage(): boolean {
    return this.engines.length > 0;
  }

  /** Статус retention-тиров кодирования (по первому журналу). */
  storageStatus(now?: number): TierStatus[] {
    this._assertOpen();
    if (!this.hasStorage) throw new RangeError('Table: def.storage не задан (нет retention-тиров кодирования)');
    return this.engines[0].status(now);
  }

  /** План retention-кодирования (dry-run) по всем журналам. */
  storagePlan(now?: number): ConversionPlan[] {
    this._assertOpen();
    if (!this.hasStorage) throw new RangeError('Table: def.storage не задан (нет retention-тиров кодирования)');
    let out: ConversionPlan[] = [];
    for (const e of this.engines) out = out.concat(e.plan(now));
    return out;
  }

  /** Применить retention-кодирование (перекодирование + слияние блоков). */
  storageApply(now?: number): ApplyReport {
    this._assertOpen();
    if (!this.hasStorage) throw new RangeError('Table: def.storage не задан (нет retention-тиров кодирования)');
    let reencoded = 0;
    let merged = 0;
    let skipped = 0;
    let beforeSegments = 0;
    let afterSegments = 0;
    let beforeBytes = 0;
    let afterBytes = 0;
    for (const e of this.engines) {
      const r = e.apply(now);
      reencoded += r.reencoded;
      merged += r.merged;
      skipped += r.skipped;
      if (beforeSegments === 0) beforeSegments = r.beforeSegments;
      afterSegments = r.afterSegments;
      if (beforeBytes === 0) beforeBytes = r.beforeBytes;
      afterBytes = r.afterBytes;
    }
    return { reencoded, merged, skipped, beforeSegments, afterSegments, beforeBytes, afterBytes };
  }

  /** Слияние блоков в одном тире кодирования (id из RetentionEngine.defaultTiers()). */
  storageCompactTier(tierId: string, now?: number) {
    this._assertOpen();
    if (!this.hasStorage) throw new RangeError('Table: def.storage не задан (нет retention-тиров кодирования)');
    let mergedGroups = 0;
    let beforeSegments = 0;
    let afterSegments = 0;
    for (const e of this.engines) {
      const r = e.compactTier(tierId, now);
      mergedGroups += r.mergedGroups;
      if (beforeSegments === 0) beforeSegments = r.beforeSegments;
      afterSegments = r.afterSegments;
    }
    return { mergedGroups, beforeSegments, afterSegments };
  }

  // --------------------------------------------------
  // Статистика
  // --------------------------------------------------

  /**
   * Статус журналов: одиночный режим — одна запись (tier 0, resMs/ttlMs = 0);
   * тир-режим — по тирам: rows/bytes/minTs/maxTs.
   */
  stats(): TableTierStat[] {
    this._assertOpen();
    return this.journals.map((j, i) => {
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
      const t = this.tiers ? this.tiers[i] : null;
      return {
        tier: i,
        resMs: t ? t.resMs : 0,
        ttlMs: t ? t.ttlMs : 0,
        rows: st.totalRows,
        bytes,
        minTs,
        maxTs,
      };
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
