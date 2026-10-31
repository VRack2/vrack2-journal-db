// Rollup.ts — rollup: aggregating rows of a fine tier into rows of a coarser resolution.
//
// Pure functions (no IO): grouping by (coarse-resolution bucket, dims) +
// agg over numbers. Table writes the result into the journal.
// Wrapper class: one file = one class (RULES.md §8).
//
// Memory: aggregation is incremental — each (bucket, dims) group carries a
// running { count, sum, min, max, last, first } per field (O(1) per group),
// NOT the full list of values. This lets Table feed rows page-by-page and
// keep peak memory bounded by the number of buckets, not by the number of
// input rows.
//
// Two output formats:
//  - legacy (single AggFn per field, `multi: false`) — the promoted row keeps
//    the bare `<field>` column holding the declared fn's value (v3 behavior);
//  - multi (`multi: true`) — the promoted row carries one column per declared
//    function: `<field>_min`, `<field>_max`, `<field>_sum`, `<field>_count`,
//    `<field>_avg`, `<field>_last` + `<field>_last_ts`, `<field>_first` +
//    `<field>_first_ts`. Every one of them is associative under tier-to-tier
//    merging (last/first merge through their (value, ts) pair), so coarse
//    tiers stay honest for min/max/sum/last/first at any read window.
//
// Input rows may themselves be rollup rows (tier→tier promotion): a row that
// carries `<field>_<fn>` columns is merged by the associative rules instead of
// being read as a raw value.

import { Interval } from '../core/Interval.ts';
import { Aggregation, type AggAcc } from './Aggregation.ts';
import type { AggFn, JsonValue, RollupFn, Row } from '../core/types.ts';

  /**
   * Explicit rollup configuration: how to aggregate a fine tier into the target (res).
   * `agg` — aggregate fields, `dims` — dimensions (group-by), `res` — the target
   * resolution (ms), defines the buckets. `multi` — emit the multi-column
   * rollup format (one column per fn) instead of the legacy single-value column.
   */
export interface RollupConfig {
  agg: Record<string, RollupFn | RollupFn[]>;
  dims: string[];
  /** Target tier resolution the rollup goes into (ms). */
  res: number;
  /** Multi-column rollup format (default false — legacy single value). */
  multi?: boolean;
}

/** Running per-field aggregate; count/sum/min/max/last/first cover all seven
 *  rollup fns (avg = sum/count). */
interface FieldAcc {
  count: number;
  sum: number;
  min: number;
  max: number;
  lastVal: number | null;
  lastTs: number | null;
  firstVal: number | null;
  firstTs: number | null;
}

/** Final value of a field aggregate (count === 0 is handled by the caller). */
const AGG_VALUE: Record<AggFn, (a: FieldAcc) => number> = {
  count: a => a.count,
  sum: a => a.sum,
  min: a => a.min,
  max: a => a.max,
  avg: a => a.sum / a.count,
};

/** One (bucket, dims) group being accumulated. */
interface Group {
  bucket: number;
  dims: Record<string, JsonValue>;
  acc: Record<string, FieldAcc>;
}

/**
 * Incremental rollup accumulator. Feed rows with add() (in any page order —
 * grouping is by bucket+dims, not by arrival), then finalize() to get the
 * promoted rows. Memory is O(#groups × #fields), independent of row count.
 */
export interface RollupAcc {
  add(row: Row): void;
  finalize(): Row[];
}

function resolveCfg(
  arg1: Record<string, RollupFn | RollupFn[]> | RollupConfig,
  arg2?: string[],
  arg3?: number
): RollupConfig {
  const isCfg =
    typeof arg1 === 'object' &&
    arg1 !== null &&
    'agg' in arg1 &&
    'res' in arg1;
  return isCfg
    ? (arg1 as RollupConfig)
    : { agg: arg1 as Record<string, RollupFn | RollupFn[]>, dims: arg2 ?? [], res: arg3 as number };
}

/** Normalize one agg declaration entry to a fn list. */
function fnList(decl: RollupFn | RollupFn[]): RollupFn[] {
  return Array.isArray(decl) ? decl.slice() : [decl];
}

  /**
   * Rollup: pure aggregation of rows into buckets of a coarser resolution.
   *
   *   Rollup.applyAgg('avg', [1, 2, 3])
   *   Rollup.promote(rows, { agg: { value: 'avg' }, dims: ['host'], res: 15_000 })
   *   Rollup.promote(rows, { agg: { value: ['min','max','sum','last'] }, dims: ['host'], res: 15_000, multi: true })
   *   const acc = Rollup.accumulate({ agg, dims, res, multi })
   *   for (const r of page) acc.add(r);  const out = acc.finalize();
   */
export class Rollup {
  /** Apply an aggregation function to a list of numbers. */
  static applyAgg(fn: AggFn, vals: number[]): number {
    switch (fn) {
      case 'count':
        return vals.length;
      case 'sum':
      case 'avg': {
        // One pass: avg reuses the sum.
        let sum = 0;
        for (const v of vals) sum += v;
        return fn === 'avg' ? sum / vals.length : sum;
      }
      case 'min':
      case 'max': {
        // Loops, not Math.min(...vals): spreading millions of values overflows the call stack.
        let m = fn === 'min' ? Infinity : -Infinity;
        for (const v of vals) {
          if (fn === 'min' ? v < m : v > m) m = v;
        }
        return m;
      }
    }
  }

  /**
   * Create an incremental rollup accumulator for the given config. Feed rows via
   * acc.add(row) (page by page, any order), then acc.finalize() to get the
   * promoted rows. Two config forms, mirroring promote():
   *   Rollup.accumulate(agg, dims, toResMs)
   *   Rollup.accumulate({ agg, dims, res, multi })
   */
  static accumulate(
    arg1: Record<string, RollupFn | RollupFn[]> | RollupConfig,
    arg2?: string[],
    arg3?: number
  ): RollupAcc {
    const cfg = resolveCfg(arg1, arg2, arg3);
    const { dims, res: toResMs, multi = false } = cfg;
    const aggFields = Object.keys(cfg.agg);
    const fnsOf: Record<string, RollupFn[]> = {};
    // A field is stored in the multi-column format when the config asks for
    // it, or when its declaration includes last/first (the legacy single-value
    // column cannot carry a (value, ts) pair).
    const multiOf: Record<string, boolean> = {};
    for (const f of aggFields) {
      const decl = cfg.agg[f];
      fnsOf[f] = fnList(decl);
      multiOf[f] = multi === true || Array.isArray(decl) || fnsOf[f].some(fn => fn === 'last' || fn === 'first');
    }
    const groups = new Map<string, Group>();

    return {
      add(row: Row): void {
        const bucket = Interval.roundTime(row['ts'] as number, toResMs);
        const dimVals: Record<string, JsonValue> = {};
        for (const d of dims) dimVals[d] = row[d] ?? null;
        const dimKey = dims.map(d => JSON.stringify(dimVals[d])).join('\u001f');
        const key = `${bucket}\u001e${dimKey}`;
        let g = groups.get(key);
        if (!g) {
          g = { bucket, dims: dimVals, acc: {} };
          for (const f of aggFields) {
            g.acc[f] = {
              count: 0, sum: 0, min: Infinity, max: -Infinity,
              lastVal: null, lastTs: null, firstVal: null, firstTs: null,
            };
          }
          groups.set(key, g);
        }
        const rowTs = typeof row['ts'] === 'number' && Number.isFinite(row['ts']) ? (row['ts'] as number) : undefined;
        for (const f of aggFields) {
          const a = g.acc[f];
          // A pre-aggregated (rollup-tier) row: merge by the associative rules.
          if (multiOf[f] && Aggregation.hasRollupCols(row, f)) {
            const o = Aggregation.fromRollupRow(row, f);
            if (o === null || o.count === 0) continue;
            if (a.count === 0) {
              a.count = o.count; a.sum = o.sum; a.min = o.min; a.max = o.max;
              a.lastVal = o.lastVal; a.lastTs = o.lastTs;
              a.firstVal = o.firstVal; a.firstTs = o.firstTs;
            } else {
              if (o.min < a.min) a.min = o.min;
              if (o.max > a.max) a.max = o.max;
              a.sum += o.sum;
              a.count += o.count;
              if (o.lastTs !== null && (a.lastTs === null || o.lastTs >= a.lastTs)) {
                a.lastVal = o.lastVal; a.lastTs = o.lastTs;
              }
              if (o.firstTs !== null && (a.firstTs === null || o.firstTs < a.firstTs)) {
                a.firstVal = o.firstVal; a.firstTs = o.firstTs;
              }
            }
            continue;
          }
          const v = row[f];
          if (typeof v === 'number' && Number.isFinite(v)) {
            a.count++;
            a.sum += v;
            if (v < a.min) a.min = v;
            if (v > a.max) a.max = v;
            if (rowTs === undefined) {
              if (a.lastTs === null) { a.lastVal = v; a.lastTs = 0; a.firstVal = v; a.firstTs = 0; }
              else a.lastVal = v;
            } else {
              if (a.lastTs === null || rowTs >= a.lastTs) { a.lastVal = v; a.lastTs = rowTs; }
              if (a.firstTs === null || rowTs < a.firstTs) { a.firstVal = v; a.firstTs = rowTs; }
            }
          }
        }
      },
      finalize(): Row[] {
        const out: Row[] = [];
        for (const g of groups.values()) {
          const outRow: Row = { ts: g.bucket, ...g.dims };
          for (const f of aggFields) {
            const a = g.acc[f];
            if (!multiOf[f]) {
              const fns = fnsOf[f];
              const fn = (fns[0] ?? 'avg') as AggFn;
              outRow[f] = a.count === 0 ? null : AGG_VALUE[fn](a);
              continue;
            }
            for (const fn of fnsOf[f]) {
              if (fn === 'last') {
                outRow[`${f}_last`] = a.lastVal;
                outRow[`${f}_last_ts`] = a.lastTs;
              } else if (fn === 'first') {
                outRow[`${f}_first`] = a.firstVal;
                outRow[`${f}_first_ts`] = a.firstTs;
              } else if (fn === 'avg') {
                outRow[`${f}_avg`] = a.count === 0 ? null : a.sum / a.count;
              } else {
                outRow[`${f}_${fn}`] = a.count === 0 ? null : AGG_VALUE[fn](a);
              }
            }
          }
          out.push(outRow);
        }
        return out;
      },
    };
  }

  /**
   * Aggregates `rows` (from a fine tier) into rows of resolution `toResMs`
   * (coarse tier). Grouping by (toResMs bucket, dims); for each agg field —
   * applyAgg over the collected numbers; rows without numbers for a field give null.
   *
   * Output order — first-encounter order of the group (stable for tests).
   * Pure function: does not touch the journal.
   *
   * Two call forms:
   *   Rollup.promote(rows, agg, dims, toResMs) — explicit parameters
   *   Rollup.promote(rows, cfg)                 — cfg: { agg, dims, res, multi }
   *
   * Thin wrapper over accumulate(): feed all rows, then finalize.
   */
  static promote(
    rows: Row[],
    arg1: Record<string, RollupFn | RollupFn[]> | RollupConfig,
    arg2?: string[],
    arg3?: number
  ): Row[] {
    const acc = Rollup.accumulate(arg1, arg2, arg3);
    for (const row of rows) acc.add(row);
    return acc.finalize();
  }
}
