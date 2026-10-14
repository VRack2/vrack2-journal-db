// Rollup.ts — rollup: aggregating rows of a fine tier into rows of a coarser resolution.
//
// Pure functions (no IO): grouping by (coarse-resolution bucket, dims) +
// agg over numbers. Table writes the result into the journal.
// Wrapper class: one file = one class (RULES.md §8).

import { Interval } from './Interval.ts';
import type { AggFn, JsonValue, Row } from './types.ts';

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

  /**
   * Rollup: pure aggregation of rows into buckets of a coarser resolution.
   *
   *   Rollup.applyAgg('avg', [1, 2, 3])
   *   Rollup.promote(rows, { agg: { value: 'avg' }, dims: ['host'], res: 15_000 })
   */
export class Rollup {
  /** Apply an aggregation function to a list of numbers. */
  static applyAgg(fn: AggFn, vals: number[]): number {
    switch (fn) {
      case 'count':
        return vals.length;
      case 'sum':
        return vals.reduce((a, b) => a + b, 0);
      case 'min':
        return Math.min(...vals);
      case 'max':
        return Math.max(...vals);
      case 'avg':
        return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
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
   */
  static promote(
    rows: Row[],
    arg1: Record<string, AggFn> | RollupConfig,
    arg2?: string[],
    arg3?: number
  ): Row[] {
    const isCfg =
      typeof arg1 === 'object' &&
      arg1 !== null &&
      'agg' in arg1 &&
      'res' in arg1;
    const cfg: RollupConfig = isCfg
      ? (arg1 as RollupConfig)
      : { agg: arg1 as Record<string, AggFn>, dims: arg2 ?? [], res: arg3 as number };
    const { agg, dims, res: toResMs } = cfg;

    const aggFields = Object.keys(agg);
    const groups = new Map<
      string,
      { bucket: number; dims: Record<string, JsonValue>; values: Record<string, number[]> }
    >();

    for (const row of rows) {
      const bucket = Interval.roundTime(row['ts'] as number, toResMs);
      const dimVals: Record<string, JsonValue> = {};
      for (const d of dims) dimVals[d] = row[d] ?? null;
      const dimKey = dims.map(d => JSON.stringify(dimVals[d])).join('\u001f');
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

    const out: Row[] = [];
    for (const g of groups.values()) {
      const outRow: Row = { ts: g.bucket, ...g.dims };
      for (const f of aggFields) {
        outRow[f] = g.values[f].length > 0 ? Rollup.applyAgg(agg[f], g.values[f]) : null;
      }
      out.push(outRow);
    }
    return out;
  }
}
