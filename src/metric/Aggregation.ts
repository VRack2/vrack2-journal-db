// Aggregation.ts — the min/max/sum/avg/count semantics shared by the scan
// aggregate(), rollup downsample and table/compaction validation: the agg-fn
// vocabulary plus the accumulator that folds values into one bucket.
//
// The accumulator also carries the time-positioned last/first pair
// (value + ts), which makes them merge-safe across rollup tiers: merging two
// buckets keeps the candidate with the greater last_ts / smaller first_ts.

import type { Segment } from '../format/Segment.ts';
import type { AggFn, ColumnSummary, RollupFn, Row } from '../core/types.ts';

/** One fold accumulator (per aggregated field). */
export interface AggAcc {
  min: number;
  max: number;
  sum: number;
  count: number;
  /** Value at the greatest ts folded so far (null — nothing folded). */
  lastVal: number | null;
  lastTs: number | null;
  /** Value at the smallest ts folded so far (null — nothing folded). */
  firstVal: number | null;
  firstTs: number | null;
}

/** A rollup-tier row's aggregate columns for one field (see rollupColumnsOf). */
export interface RollupRowAgg {
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  count?: number | null;
  avg?: number | null;
  last?: number | null;
  last_ts?: number | null;
  first?: number | null;
  first_ts?: number | null;
}

export class Aggregation {
  static newAcc(): AggAcc {
    return {
      min: Infinity, max: -Infinity, sum: 0, count: 0,
      lastVal: null, lastTs: null, firstVal: null, firstTs: null,
    };
  }

  /** Fold one raw value; `ts` (when given) drives last/first, otherwise
   *  fold order decides them (last folded wins 'last', first folded wins 'first'). */
  static addValue(acc: AggAcc, v: number, ts?: number): void {
    if (v < acc.min) acc.min = v;
    if (v > acc.max) acc.max = v;
    acc.sum += v;
    acc.count++;
    if (ts === undefined) {
      if (acc.lastTs === null) { acc.lastVal = v; acc.lastTs = 0; acc.firstVal = v; acc.firstTs = 0; }
      else acc.lastVal = v;
      return;
    }
    if (acc.lastTs === null || ts >= acc.lastTs) { acc.lastVal = v; acc.lastTs = ts; }
    if (acc.firstTs === null || ts < acc.firstTs) { acc.firstVal = v; acc.firstTs = ts; }
  }

  static addSummary(acc: AggAcc, s: ColumnSummary): void {
    if (s.count === 0) return;
    if (s.min < acc.min) acc.min = s.min;
    if (s.max > acc.max) acc.max = s.max;
    acc.sum += s.sum;
    acc.count += s.count;
  }

  /** Merge another accumulator into `acc` (associative tier/bucket stitching). */
  static merge(acc: AggAcc, o: AggAcc): void {
    if (o.count === 0) return;
    if (acc.count === 0) {
      acc.min = o.min; acc.max = o.max; acc.sum = o.sum; acc.count = o.count;
      acc.lastVal = o.lastVal; acc.lastTs = o.lastTs;
      acc.firstVal = o.firstVal; acc.firstTs = o.firstTs;
      return;
    }
    if (o.min < acc.min) acc.min = o.min;
    if (o.max > acc.max) acc.max = o.max;
    acc.sum += o.sum;
    acc.count += o.count;
    if (o.lastTs !== null && (acc.lastTs === null || o.lastTs >= acc.lastTs)) {
      acc.lastVal = o.lastVal; acc.lastTs = o.lastTs;
    }
    if (o.firstTs !== null && (acc.firstTs === null || o.firstTs < acc.firstTs)) {
      acc.firstVal = o.firstVal; acc.firstTs = o.firstTs;
    }
  }

  /** Is `fn` one of the scan-API aggregation functions? (the AggFn vocabulary) */
  static isAggFn(fn: unknown): fn is AggFn {
    return typeof fn === 'string' && Aggregation.AGG_FNS.has(fn);
  }

  /** Is `fn` a table-declaration rollup function (AggFn + last/first)? */
  static isRollupFn(fn: unknown): fn is RollupFn {
    return typeof fn === 'string' && Aggregation.ROLLUP_FNS.has(fn);
  }

  /** The `<field>_<fn>` rollup columns a multi-agg table stores for `fns`. */
  static rollupColumnsOf(field: string, fns: readonly RollupFn[]): string[] {
    const out: string[] = [];
    for (const fn of fns) {
      out.push(`${field}_${fn}`);
      if (fn === 'last') out.push(`${field}_last_ts`);
      if (fn === 'first') out.push(`${field}_first_ts`);
    }
    return out;
  }

  /** Does `row` carry any rollup aggregate column for `field`? Journals fill
   *  absent schema columns with null, so null counts as absent. */
  static hasRollupCols(row: Row, field: string): boolean {
    for (const fn of Aggregation.ROLLUP_FNS) {
      if (row[`${field}_${fn}`] != null) return true;
      if (fn === 'last' && row[`${field}_last_ts`] != null) return true;
      if (fn === 'first' && row[`${field}_first_ts`] != null) return true;
    }
    return false;
  }

  /** Build an accumulator from a rollup-tier row's `<field>_<fn>` columns
   *  (merge-safe fold of a pre-aggregated bucket). Null when the row carries
   *  no aggregate columns for the field. */
  static fromRollupRow(row: Row, field: string): AggAcc | null {
    const g = (name: string): number | null => {
      const v = row[name];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const mn = g(`${field}_min`);
    const mx = g(`${field}_max`);
    const sm = g(`${field}_sum`);
    const ct = g(`${field}_count`);
    const av = g(`${field}_avg`);
    const lv = g(`${field}_last`);
    const lt = g(`${field}_last_ts`);
    const fv = g(`${field}_first`);
    const ft = g(`${field}_first_ts`);
    if (mn === null && mx === null && sm === null && ct === null && av === null && lv === null && fv === null) return null;
    const acc = Aggregation.newAcc();
    if (ct !== null && ct > 0) {
      acc.count = ct;
      acc.sum = sm ?? 0;
    } else if (sm !== null) {
      acc.sum = sm;
      acc.count = 1;
    } else if (lv !== null || fv !== null || av !== null) {
      acc.count = 1;
    }
    if (acc.count === 0) return acc;
    acc.min = mn ?? (lv ?? fv ?? av ?? 0);
    acc.max = mx ?? (lv ?? fv ?? av ?? 0);
    if (lv !== null) {
      acc.lastVal = lv;
      acc.lastTs = lt ?? (typeof row['ts'] === 'number' ? (row['ts'] as number) : null);
    }
    if (fv !== null) {
      acc.firstVal = fv;
      acc.firstTs = ft ?? (typeof row['ts'] === 'number' ? (row['ts'] as number) : null);
    }
    return acc;
  }

  static value(acc: AggAcc, fn: AggFn | 'last' | 'first'): number | null {
    switch (fn) {
      case 'count': return acc.count;
      case 'sum':   return acc.count > 0 ? acc.sum : null;
      case 'min':   return acc.count > 0 ? acc.min : null;
      case 'max':   return acc.count > 0 ? acc.max : null;
      case 'avg':   return acc.count > 0 ? acc.sum / acc.count : null;
      case 'last':  return acc.lastVal;
      case 'first': return acc.firstVal;
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
        if (typeof v === 'number' && Number.isFinite(v)) Aggregation.addValue(accs[f], v, ts);
      }
    }
  }

  private static readonly AGG_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count']);
  private static readonly ROLLUP_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count', 'last', 'first']);
}
