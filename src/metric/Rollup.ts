// Rollup.ts — rollup: aggregating rows of a fine tier into rows of a coarser resolution.
//
// Pure functions (no IO): grouping by (coarse-resolution bucket, dims) +
// agg over numbers. Table writes the result into the journal.
// Wrapper class: one file = one class (RULES.md §8).
//
// Memory: aggregation is incremental — each (bucket, dims) group carries a
// running { count, sum, min, max } per field (O(1) per group), NOT the full
// list of values. This lets Table feed rows page-by-page and keep peak memory
// bounded by the number of buckets, not by the number of input rows.

import { Interval } from '../core/Interval.ts';
import type { AggFn, JsonValue, Row } from '../core/types.ts';

  /**
   * Explicit rollup configuration: how to aggregate a fine tier into the target (res).
   * `agg` — aggregate fields, `dims` — dimensions (group-by), `res` — the target
   * resolution (ms), defines the buckets.
   */
export interface RollupConfig {
  agg: Record<string, AggFn>;
  dims: string[];
  /** Target tier resolution the rollup goes into (ms). */
  res: number;
}

/** Running per-field aggregate; count/sum/min/max cover all five agg fns (avg = sum/count). */
interface FieldAcc {
  count: number;
  sum: number;
  min: number;
  max: number;
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
  arg1: Record<string, AggFn> | RollupConfig,
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
    : { agg: arg1 as Record<string, AggFn>, dims: arg2 ?? [], res: arg3 as number };
}

  /**
   * Rollup: pure aggregation of rows into buckets of a coarser resolution.
   *
   *   Rollup.applyAgg('avg', [1, 2, 3])
   *   Rollup.promote(rows, { agg: { value: 'avg' }, dims: ['host'], res: 15_000 })
   *   const acc = Rollup.accumulate({ agg: { value: 'avg' }, dims: ['host'], res: 15_000 })
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
   *   Rollup.accumulate({ agg, dims, res })
   */
  static accumulate(
    arg1: Record<string, AggFn> | RollupConfig,
    arg2?: string[],
    arg3?: number
  ): RollupAcc {
    const cfg = resolveCfg(arg1, arg2, arg3);
    const { agg, dims, res: toResMs } = cfg;
    const aggFields = Object.keys(agg);
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
          for (const f of aggFields) g.acc[f] = { count: 0, sum: 0, min: Infinity, max: -Infinity };
          groups.set(key, g);
        }
        for (const f of aggFields) {
          const v = row[f];
          if (typeof v === 'number' && Number.isFinite(v)) {
            const a = g.acc[f];
            a.count++;
            a.sum += v;
            if (v < a.min) a.min = v;
            if (v > a.max) a.max = v;
          }
        }
      },
      finalize(): Row[] {
        const out: Row[] = [];
        for (const g of groups.values()) {
          const outRow: Row = { ts: g.bucket, ...g.dims };
          for (const f of aggFields) {
            const a = g.acc[f];
            outRow[f] = a.count === 0 ? null : AGG_VALUE[agg[f]](a);
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
   *   Rollup.promote(rows, cfg)                 — cfg: { agg, dims, res }
   *
   * Thin wrapper over accumulate(): feed all rows, then finalize.
   */
  static promote(
    rows: Row[],
    arg1: Record<string, AggFn> | RollupConfig,
    arg2?: string[],
    arg3?: number
  ): Row[] {
    const acc = Rollup.accumulate(arg1, arg2, arg3);
    for (const row of rows) acc.add(row);
    return acc.finalize();
  }
}
