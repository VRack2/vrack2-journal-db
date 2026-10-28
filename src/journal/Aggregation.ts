// aggregation.ts — min/max/sum/count accumulators shared by
// aggregate() / downsample() / scan(agg), plus the agg-fn vocabulary.

import type { Segment } from '../format/Segment.ts';
import type { AggFn, ColumnSummary } from '../core/types.ts';

export interface AggAcc {
  min: number;
  max: number;
  sum: number;
  count: number;
}

export const newAcc = (): AggAcc => ({ min: Infinity, max: -Infinity, sum: 0, count: 0 });

export function addValue(acc: AggAcc, v: number): void {
  if (v < acc.min) acc.min = v;
  if (v > acc.max) acc.max = v;
  acc.sum += v;
  acc.count++;
}

export function addSummary(acc: AggAcc, s: ColumnSummary): void {
  if (s.count === 0) return;
  if (s.min < acc.min) acc.min = s.min;
  if (s.max > acc.max) acc.max = s.max;
  acc.sum += s.sum;
  acc.count += s.count;
}

const AGG_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count']);
export function isAggFn(fn: unknown): fn is AggFn {
  return typeof fn === 'string' && AGG_FNS.has(fn);
}

export function aggValue(acc: AggAcc, fn: AggFn): number | null {
  switch (fn) {
    case 'count': return acc.count;
    case 'sum':   return acc.count > 0 ? acc.sum : null;
    case 'min':   return acc.count > 0 ? acc.min : null;
    case 'max':   return acc.count > 0 ? acc.max : null;
    case 'avg':   return acc.count > 0 ? acc.sum / acc.count : null;
  }
}

/** Fold numeric values of `fields` within [start, end] from `seg` into `accs`. */
export function scanAggregate(seg: Segment, start: number, end: number, fields: string[], accs: Record<string, AggAcc>): void {
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

/**
 * Fold one whole segment into `accs` for [start, end]: when the segment is
 * fully inside the range, use its column summaries (fast path) and scan only
 * the fields without a summary; otherwise scan rows.
 */
export function aggregateSegment(seg: Segment, start: number, end: number, fields: string[], accs: Record<string, AggAcc>): void {
  const minTs = seg.minTs;
  const maxTs = seg.maxTs;
  if (minTs !== null && maxTs !== null && (maxTs < start || minTs > end)) return;
  if (minTs !== null && maxTs !== null && minTs >= start && maxTs <= end) {
    const slow: string[] = [];
    for (const f of fields) {
      const s = seg.summaries[f];
      if (s) addSummary(accs[f], s);
      else slow.push(f);
    }
    if (slow.length > 0) scanAggregate(seg, start, end, slow, accs);
    return;
  }
  scanAggregate(seg, start, end, fields, accs);
}
