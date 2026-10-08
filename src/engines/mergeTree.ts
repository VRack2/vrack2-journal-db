// Фаза 2 — MergeTree: мультитирная таблица-метрик (тонкий → грубый тир),
// rollup (перенос состарившегося на грубый тир через агрегацию) и retention
// (purge тиров старше их ttl).
//
// Построено на движках Phase 1: тонкий тир — log, грубые — upsert
// (key=[ts, …dims], version=ts), чтобы повторный rollup того же бакета
// схлопывался при compact. Rollup-агрегация — чистая функция promote().

import type { Journal } from '../journal.ts';
import type {
  AggFn,
  Metadata,
  OpenJournalOptions,
  ResolutionTier,
  Row,
  Schema,
} from '../types.ts';
import type { TableStore } from '../table.ts';
import { Tier } from './tier.ts';
import { promote } from './rollup.ts';
import type { RollupConfig } from './rollup.ts';
import { tiersForRetention, validateTiers } from './retention.ts';

export interface MergeTreeConfig {
  name: string;
  store: TableStore;
  /** Retention-политика 'res:ttl,res:ttl' ИЛИ явный массив тиров. */
  retention?: string;
  tiers?: ResolutionTier[];
  schema: Schema;
  /** Поля, агрегируемые при rollup (поле → fn). По умолчанию — первое не-ts поле → avg. */
  agg?: Record<string, AggFn>;
  /** Поля-размеры (group-by). По умолчанию — схема минус ts и минус agg-поля. */
  dims?: string[];
  opts?: OpenJournalOptions;
  /** Провайдер «текущего времени» (тесты). По умолчанию Date.now. */
  nowProvider?: () => number;
}

export interface MergeTreeRollupReport {
  /** Сколько пар тиров перенесено. */
  pairs: number;
  /** Сколько строк прочитано из тонких тиров. */
  rolledRows: number;
  /** Сколько строк удалено из тонких тиров (purge). */
  purgedRows: number;
}

export interface MergeTreeTierStat {
  index: number;
  name: string;
  resMs: number;
  ttlMs: number;
  rows: number;
}

export class MergeTree {
  readonly name: string;
  readonly tiers: ResolutionTier[];
  readonly agg: Record<string, AggFn>;
  readonly dims: string[];
  readonly tierObjs: Tier[];

  private readonly store: TableStore;
  private readonly nowProvider: () => number;
  private readonly checkpoints: Record<string, number> = {};

  constructor(config: MergeTreeConfig) {
    const name = config.name;
    if (!name || name.includes('/')) {
      throw new RangeError(`MergeTree: name не должно содержать "/" (получено "${name}")`);
    }
    if (!config.schema || !('ts' in config.schema)) {
      throw new RangeError('MergeTree: схема должна содержать ts');
    }
    this.name = name;

    // --- тиры -------------------------------------------------------------
    let tiers: ResolutionTier[];
    if (config.tiers && config.tiers.length > 0) {
      tiers = config.tiers.slice();
      validateTiers(tiers);
    } else if (config.retention) {
      tiers = tiersForRetention(config.retention);
    } else {
      throw new RangeError('MergeTree: укажите retention (строка "res:ttl,…") или tiers (массив)');
    }
    this.tiers = tiers;

    // --- agg / dims -------------------------------------------------------
    let agg = config.agg;
    if (!agg || Object.keys(agg).length === 0) {
      const first = Object.keys(config.schema).find(f => f !== 'ts');
      if (!first) throw new RangeError('MergeTree: схема должна содержать не-ts поле для agg');
      agg = { [first]: 'avg' };
    }
    for (const [f, fn] of Object.entries(agg)) {
      if (fn !== 'min' && fn !== 'max' && fn !== 'sum' && fn !== 'avg' && fn !== 'count') {
        throw new RangeError(`MergeTree: agg.${f} — fn min|max|sum|avg|count (получено ${String(fn)})`);
      }
    }
    this.agg = agg;
    const dims = config.dims ?? Object.keys(config.schema).filter(f => f !== 'ts' && !(f in agg));
    this.dims = dims;

    this.store = config.store;
    this.nowProvider = config.nowProvider ?? (() => Date.now());

    // --- создание тиров ---------------------------------------------------
    // Тонкий (индекс 0) — log (строки не меняются). Грубые (1..n) — upsert
    // (key=[ts, …dims], version=ts): повторный rollup того же бакета схлопывается.
    this.tierObjs = tiers.map((t, i) => {
      const jName = `${name}/r${t.resMs}`;
      const meta: Metadata = { table: name, tier: i, resMs: t.resMs, ttlMs: t.ttlMs };
      if (i > 0) {
        meta._engine = { kind: 'upsert', key: ['ts', ...dims], version: 'ts' };
      }
      const journal = this.store.openJournal(jName, config.schema, meta, config.opts);
      return new Tier(i, t, journal);
    });
  }

  get isOpen(): boolean {
    return this.tierObjs.every(t => t.isOpen);
  }

  /** «Текущее время» таблицы. */
  now(): number {
    return this.nowProvider();
  }

  /** Запись строки в самый тонкий тир (индекс 0). */
  append(row: Row): void {
    if (!this.isOpen) throw new Error('MergeTree: не открыта (вызван close())');
    this.tierObjs[0].append(row);
  }

  /**
   * Rollup (Фаза 3). Две формы:
   *   mt.rollup()            — все тиры по их дефолтным конфигам (agg/dims таблицы)
   *   mt.rollup(now)         — то же, но с явным «текущим временем»
   *   mt.rollup(cfg, now?)   — ОДИН тир с явным cfg: { agg, dims, res } (res — целевой тир)
   *
   * Перенос состарившегося (ts ≤ now − ttl_тонкого): promote() → грубый тир → purge тонкого.
   * Идемпотентно по чекпоинту на пару тиров.
   */
  rollup(cfgOrNow?: RollupConfig | number, now?: number): MergeTreeRollupReport {
    if (typeof cfgOrNow === 'number' || cfgOrNow === undefined) {
      // Все тиры — дефолтные конфиги. now — 1-й аргумент (число) либо 2-й.
      const nowTs = typeof cfgOrNow === 'number' ? cfgOrNow : (typeof now === 'number' ? now : this.now());
      return this._rollupAll(nowTs);
    }
    // Один тир — явный cfg (res определяет целевой тир).
    const nowTs = typeof now === 'number' ? now : this.now();
    return this._rollupOne(cfgOrNow, nowTs);
  }

  /** Rollup всех пар тиров (i → i+1) с дефолтными agg/dims таблицы. */
  private _rollupAll(nowTs: number): MergeTreeRollupReport {
    if (!this.isOpen) throw new Error('MergeTree: не открыта (вызван close())');
    if (!Number.isFinite(nowTs)) throw new RangeError('MergeTree: rollup(now) — now: конечное число (мс)');

    let pairs = 0;
    let rolledRows = 0;
    let purgedRows = 0;
    for (let i = 0; i + 1 < this.tiers.length; i++) {
      const rep = this._rollupPair(i, this.agg, this.dims, this.tiers[i + 1].resMs, nowTs);
      pairs += rep.pairs;
      rolledRows += rep.rolledRows;
      purgedRows += rep.purgedRows;
    }
    return { pairs, rolledRows, purgedRows };
  }

  /** Rollup одного тира с явным cfg (Фаза 3): целевой тир — tiers[i+1].resMs === cfg.res. */
  private _rollupOne(cfg: RollupConfig, nowTs: number): MergeTreeRollupReport {
    if (!this.isOpen) throw new Error('MergeTree: не открыта (вызван close())');
    const ci = this.tierObjs.findIndex(t => t.resMs === cfg.res);
    if (ci < 0) throw new RangeError(`MergeTree: rollup(cfg) — нет тира с res=${cfg.res}`);
    if (ci === 0) throw new RangeError('MergeTree: rollup(cfg) — целевой тир не может быть самым тонким');
    return this._rollupPair(ci - 1, cfg.agg, cfg.dims, cfg.res, nowTs);
  }

  /** Rollup пары тиров (fine=index → coarse=index+1) с данными agg/dims/цель. */
  private _rollupPair(
    i: number,
    agg: Record<string, AggFn>,
    dims: string[],
    coarseRes: number,
    nowTs: number
  ): MergeTreeRollupReport {
    const fine = this.tierObjs[i];
    const coarse = this.tierObjs[i + 1];
    const fineTtl = this.tiers[i].ttlMs;
    const maxRollable = nowTs - fineTtl; // всё, что «возрастом» старше fineTtl
    const cpKey = `${i}->${i + 1}`;
    const cp = this.checkpoints[cpKey] ?? 0;
    if (maxRollable <= cp) return { pairs: 0, rolledRows: 0, purgedRows: 0 }; // идемпотентно

    let rows: Row[];
    try {
      rows = fine.scan({ start: cp + 1, end: maxRollable });
    } catch {
      rows = [];
    }
    rows = rows.filter(r => {
      const ts = r['ts'];
      return typeof ts === 'number' && Number.isFinite(ts) && ts > cp && ts <= maxRollable;
    });

    const promoted = promote(rows, agg, dims, coarseRes);
    for (const outRow of promoted) coarse.append(outRow);
    if (promoted.length > 0) coarse.flush();

    // Чекпоинт — атомарно ДО purge.
    this.checkpoints[cpKey] = maxRollable;

    const purged = fine.purge(maxRollable + 1);
    return { pairs: 1, rolledRows: rows.length, purgedRows: purged.removedRows ?? 0 };
  }

  /** Purge каждого тира: удалить строки с ts < now − ttl_тира. */
  retention(now?: number): { purgedByTier: number[] } {
    if (!this.isOpen) throw new Error('MergeTree: не открыта (вызван close())');
    const nowTs = typeof now === 'number' ? now : this.now();
    const purgedByTier: number[] = [];
    for (const t of this.tierObjs) {
      const r = t.purge(nowTs - t.ttlMs);
      purgedByTier.push(r.removedRows ?? 0);
    }
    return { purgedByTier };
  }

  /** Чтение [start, end] (обе границы включительно) со всех тиров, склейка по ts ↑. */
  query(start?: number | string, end?: number | string): Row[] {
    if (!this.isOpen) throw new Error('MergeTree: не открыта (вызван close())');
    const all: Row[] = [];
    for (const t of this.tierObjs) {
      try {
        all.push(...t.scan({ start, end }));
      } catch {
        /* тир не читается — пропускаем */
      }
    }
    all.sort((a, b) => (a['ts'] as number) - (b['ts'] as number));
    return all;
  }

  /** Статистика по тирам. */
  stats(): MergeTreeTierStat[] {
    return this.tierObjs.map(t => ({
      index: t.index,
      name: t.name,
      resMs: t.resMs,
      ttlMs: t.ttlMs,
      rows: t.allRows().length,
    }));
  }

  /** Закрыть все тиры. */
  close(): void {
    for (const t of this.tierObjs) {
      if (this.store.openJournals.has(t.name)) this.store.closeJournal(t.name);
    }
  }
}
