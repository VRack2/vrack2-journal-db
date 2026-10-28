// Aggregation.ts — the min/max/sum/avg/count semantics shared by the scan
// aggregate(), rollup downsample and table/compaction validation: the agg-fn
// vocabulary plus the accumulator that folds values into one bucket.

import type { Segment } from '../format/Segment.ts';
import type { AggFn, ColumnSummary } from '../core/types.ts';

/** One fold accumulator (per aggregated field). */
export interface AggAcc {
  min: number;
  max: number;
  sum: number;
  count: number;
}

export class Aggregation {
  static newAcc(): AggAcc {
    return { min: Infinity, max: -Infinity, sum: 0, count: 0 };
  }

  static addValue(acc: AggAcc, v: number): void {
    if (v < acc.min) acc.min = v;
    if (v > acc.max) acc.max = v;
    acc.sum += v;
    acc.count++;
  }

  static addSummary(acc: AggAcc, s: ColumnSummary): void {
    if (s.count === 0) return;
    if (s.min < acc.min) acc.min = s.min;
    if (s.max > acc.max) acc.max = s.max;
    acc.sum += s.sum;
    acc.count += s.count;
  }

  /** Is `fn` one of the aggregation functions? (the AggFn vocabulary) */
  static isAggFn(fn: unknown): fn is AggFn {
    return typeof fn === 'string' && Aggregation.AGG_FNS.has(fn);
  }

  static value(acc: AggAcc, fn: AggFn): number | null {
    switch (fn) {
      case 'count': return acc.count;
      case 'sum':   return acc.count > 0 ? acc.sum : null;
      case 'min':   return acc.count > 0 ? acc.min : null;
      case 'max':   return acc.count > 0 ? acc.max : null;
      case 'avg':   return acc.count > 0 ? acc.sum / acc.count : null;
    }
  }

  /** Fold numeric values of `fields` within [start, end] from `seg` into `accs`. */
  static scanAggregate(seg: Segment, start: number, end: number, fields: string[], accs: Record<string, AggAcc>): void {
    if (fields.length === 0) return;
    for (let i = 0; i < seg.rowCount; i++) {
      const ts = seg.get('ts', i);
      if (typeof ts !== 'number' || ts < start || ts > end) continue;
      for (const f of fields) {
        const v = seg.get(f, i);
        if (typeof v === 'number' && Number.isFinite(v)) Aggregation.addValue(accs[f], v);
      }
    }
  }

  private static readonly AGG_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count']);
}
