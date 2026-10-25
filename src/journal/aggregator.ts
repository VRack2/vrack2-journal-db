// aggregator.ts — time-series reads over a journal's segments:
// timeline (events per bucket), aggregate (field_fn over a range),
// downsample (per-bucket aggregates) and the percentile helper.
//
// Shared with JournalReader: both take a SegmentSource, so the same code
// serves the public Journal API and the reader object.

import { Interval } from '../Interval.ts';
import { Percentile } from '../Percentile.ts';
import type { Segment } from '../Segment.ts';
import ErrorManager from '../errors/ErrorManager.ts';
import type {
  AggregateExpr, AggFn, DownsampleBucket, TimelineBucket,
} from '../types.ts';
import { addSummary, addValue, aggValue, isAggFn, newAcc, scanAggregate, type AggAcc } from './Aggregation.ts';
import { metaSkips, type SegmentMeta } from './SegmentMeta.ts';
import type { SegmentSource } from './segmentSource.ts';

// Re-exported so callers can import the read surface from one place.
export type { SegmentSource } from './segmentSource.ts';

/**
 * Aggregates numeric fields over [start, end] (both bounds inclusive).
 * Returns one `field_fn` entry per expression (null when no values).
 */
export function aggregate(
  src: SegmentSource,
  startTs: number | string,
  endTs: number | string,
  exprs: AggregateExpr[],
): Record<string, number | null> {
  if (!Array.isArray(exprs) || exprs.length === 0) throw ErrorManager.make('JRN_AGG_EXPRS');
  const fields: string[] = [];
  for (const e of exprs) {
    if (typeof e.field !== 'string' || e.field.length === 0) throw ErrorManager.make('JRN_AGG_FIELD');
    if (!isAggFn(e.fn)) throw ErrorManager.make('JRN_AGG_FN', { fn: String(e.fn) });
    if (!fields.includes(e.field)) fields.push(e.field);
  }
  const [start, end] = Interval.period(startTs, endTs);

  const accs: Record<string, AggAcc> = {};
  for (const f of fields) accs[f] = newAcc();

  const foldSegment = (seg: Segment): void => {
    const minTs = seg.minTs;
    const maxTs = seg.maxTs;
    if (minTs !== null && maxTs !== null && (maxTs < start || minTs > end)) return;
    if (minTs !== null && maxTs !== null && minTs >= start && maxTs <= end) {
      const slow: string[] = [];
      for (const f of fields) {
        const s = seg.summaries[f];
        if (s && s.count > 0) addSummary(accs[f], s);
        else slow.push(f);
      }
      if (slow.length > 0) scanAggregate(seg, start, end, slow, accs);
      return;
    }
    scanAggregate(seg, start, end, fields, accs);
  };

  for (const id of src.sortedClosedIds()) {
    const meta = src.metaOf(id);
    if (metaSkips(meta?.minTs ?? null, meta?.maxTs ?? null, start, end, true)) continue;
    foldSegment(src.loadClosed(id));
  }
  const active = src.activeSegment;
  if (active && active.rowCount > 0) foldSegment(active);

  const out: Record<string, number | null> = {};
  for (const e of exprs) out[`${e.field}_${e.fn}`] = aggValue(accs[e.field], e.fn);
  return out;
}

/**
 * Downsamples a numeric field to per-bucket aggregates over [start, end).
 * Buckets are aligned to the bucket grid (epoch multiples of `bucketMs`);
 * the first bucket starts at `start`, the last ends at `end`.
 * Only the requested functions are present (and always `count`).
 */
export function downsample(
  src: SegmentSource,
  startTs: number | string,
  endTs: number | string,
  bucketMs: number | string,
  field: string,
  fns: AggFn[],
): DownsampleBucket[] {
  if (typeof field !== 'string' || field.length === 0) throw ErrorManager.make('JRN_DS_FIELD');
  if (!Array.isArray(fns) || fns.length === 0) throw ErrorManager.make('JRN_DS_FNS');
  for (const fn of fns) {
    if (!isAggFn(fn)) throw ErrorManager.make('JRN_DS_FN', { fn: String(fn) });
  }
  let bucket: number;
  if (typeof bucketMs === 'string') {
    bucket = Interval.parseInterval(bucketMs);
    if (!Number.isFinite(bucket) || bucket <= 0) throw ErrorManager.make('JRN_DS_BUCKET');
  } else {
    bucket = bucketMs;
    if (!Number.isInteger(bucket) || bucket <= 0) throw ErrorManager.make('JRN_DS_BUCKET_POS');
  }
  const [start, end] = Interval.period(startTs, endTs);

  const first = Math.floor(start / bucket) * bucket;
  const n = Math.max(1, Math.ceil((end - first) / bucket));
  const accs: AggAcc[] = new Array(n);
  for (let i = 0; i < n; i++) accs[i] = newAcc();

  const bin = (ts: number, v: number): void => {
    let i = Math.floor((ts - first) / bucket);
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    addValue(accs[i], v);
  };

  const scanSegment = (seg: Segment): void => {
    if (!seg.columns[field]) return;
    for (let i = 0; i < seg.rowCount; i++) {
      const ts = seg.get('ts', i);
      if (typeof ts !== 'number' || ts < start || ts >= end) continue;
      const v = seg.get(field, i);
      if (typeof v === 'number' && Number.isFinite(v)) bin(ts, v);
    }
  };

  for (const id of src.sortedClosedIds()) {
    const meta = src.metaOf(id);
    if (metaSkips(meta?.minTs ?? null, meta?.maxTs ?? null, start, end, false)) continue;
    scanSegment(src.loadClosed(id));
  }
  const active = src.activeSegment;
  if (active && active.rowCount > 0) scanSegment(active);

  const out: DownsampleBucket[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const bStart = first + i * bucket;
    const bEnd = first + (i + 1) * bucket;
    const b: DownsampleBucket = {
      start: i === 0 ? Math.max(bStart, start) : bStart,
      end: i === n - 1 ? Math.min(bEnd, end) : bEnd,
      count: accs[i].count,
      hasData: accs[i].count > 0,
    };
    for (const fn of fns) {
      if (fn === 'count') b.count = accs[i].count;
      else b[fn] = aggValue(accs[i], fn);
    }
    out[i] = b;
  }
  return out;
}

/**
 * Quantiles for a value list. `levels` are 0..1 (e.g. 0.95).
 * Returns {pNN: value|null} — null when the list is empty.
 */
export function percentileOf(vals: number[], levels: number[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const sorted = vals.length > 0 ? [...vals].sort((a, b) => a - b) : [];
  for (const level of levels) {
    const key = Percentile.key(level);
    out[key] = sorted.length > 0 ? Percentile.of(sorted, level) : null;
  }
  return out;
}

/**
 * Events per interval bucket. `interval` — ms (number) or a string like
 * '1d'/'30m' (VRackDB-compatible); `period` — [start, end) or "start:end".
 * Buckets are aligned to the period start; a period shorter than the
 * interval is a single bucket; a zero-length period returns [].
 */
export function timeline(
  src: SegmentSource,
  interval: number | string,
  period: [number, number] | string,
): TimelineBucket[] {
  let step: number;
  if (typeof interval === 'string') {
    step = Interval.parseInterval(interval);
    if (!Number.isFinite(step) || step <= 0) throw ErrorManager.make('JRN_TL_INTERVAL');
  } else {
    step = interval;
    if (!Number.isInteger(step) || step <= 0) throw ErrorManager.make('JRN_TL_INTERVAL_POS');
  }
  const [start, end] = Array.isArray(period)
    ? (Interval.period(period[0], period[1]) as [number, number])
    : Interval.period(period);

  const span = end - start;
  if (span <= 0) return [];
  const n = Math.max(1, Math.ceil(span / step));
  const counts = new Array<number>(n).fill(0);

  const bin = (ts: number): void => {
    const i = Math.floor((ts - start) / step);
    if (i >= 0 && i < n) counts[i]++;
  };

  const scanSegment = (seg: Segment): void => {
    if (!seg.columns['ts']) return;
    for (let i = 0; i < seg.rowCount; i++) {
      const ts = seg.get('ts', i);
      if (typeof ts === 'number' && ts >= start && ts < end) bin(ts);
    }
  };

  for (const id of src.sortedClosedIds()) {
    const meta = src.metaOf(id);
    if (metaSkips(meta?.minTs ?? null, meta?.maxTs ?? null, start, end, false)) continue;
    scanSegment(src.loadClosed(id));
  }
  const active = src.activeSegment;
  if (active && active.rowCount > 0) scanSegment(active);

  const out: TimelineBucket[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = start + i * step;
    const e = i === n - 1 ? end : s + step;
    out[i] = { start: s, end: e, count: counts[i], hasData: counts[i] > 0 };
  }
  return out;
}