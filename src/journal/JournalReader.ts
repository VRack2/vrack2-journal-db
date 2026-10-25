// JournalReader.ts — row-level reads over a journal's segments:
// query / allRows / tail / page / getMarks / timeRange / scan.
//
// The time-series reads (timeline/aggregate/downsample/percentile) live in
// aggregator.ts as free functions over a SegmentSource; this class exposes
// them as methods so the reader object is a self-contained read facade.
//
// Self-contained: it works on the SegmentStore plus accessors for the active
// segment and schema — no reference to the Journal.

import { Interval } from '../Interval.ts';
import type { Segment } from '../Segment.ts';
import ErrorManager from '../errors/ErrorManager.ts';
import type {
  AggregateExpr, AggFn, DownsampleBucket, Row, ScanOptions, Schema, TimelineBucket,
} from '../types.ts';
import { aggregate, downsample, percentileOf, timeline } from './aggregator.ts';
import { metaSkips, type SegmentMeta } from './SegmentMeta.ts';
import type { SegmentSource } from './segmentSource.ts';
import type { SegmentStore } from './SegmentStore.ts';
import { compileScan, type ScanPlan } from './scan/plan.ts';
import { executeScan } from './scan/execute.ts';

export class JournalReader implements SegmentSource {
  private readonly store: SegmentStore;
  private readonly activeSegmentOf: () => Segment | null;
  private readonly schemaOf: () => Schema | null;

  constructor(
    store: SegmentStore,
    activeSegmentOf: () => Segment | null,
    schemaOf: () => Schema | null,
  ) {
    this.store = store;
    this.activeSegmentOf = activeSegmentOf;
    this.schemaOf = schemaOf;
  }

  // --- SegmentSource surface (for the scan executor) ---

  get activeSegment(): Segment | null { return this.activeSegmentOf(); }

  sortedClosedIds(): string[] { return this.store.sortedIds(); }

  metaOf(id: string): SegmentMeta | undefined { return this.store.metaOf(id); }

  loadClosed(id: string): Segment { return this.store.loadClosed(id); }

  // --- Row reads ---

  /** [minTs, maxTs] over all segments — null when there is no data. */
  timeRange(): [number, number] | null {
    let min = Infinity;
    let max = -Infinity;
    const consider = (minTs: number | null, maxTs: number | null): void => {
      if (minTs !== null && minTs < min) min = minTs;
      if (maxTs !== null && maxTs > max) max = maxTs;
    };

    const ids = this.sortedClosedIds();
    if (ids.length === 0 || ids.every(id => this.metaOf(id) !== undefined)) {
      for (const id of ids) {
        const m = this.metaOf(id)!;
        consider(m.minTs, m.maxTs);
      }
    } else {
      for (const id of ids) {
        const seg = this.loadClosed(id);
        consider(seg.minTs, seg.maxTs);
      }
    }
    const active = this.activeSegment;
    if (active && active.rowCount > 0) consider(active.minTs, active.maxTs);

    if (min === Infinity) return null;
    return [min, max];
  }

  /** All ts values over all segments, sorted ascending. */
  getMarks(): number[] {
    const marks: number[] = [];
    const collect = (seg: Segment): void => {
      if (!seg.columns['ts']) return;
      for (let i = 0; i < seg.rowCount; i++) {
        const v = seg.get('ts', i);
        if (typeof v === 'number') marks.push(v);
      }
    };
    for (const id of this.sortedClosedIds()) collect(this.loadClosed(id));
    const active = this.activeSegment;
    if (active && active.rowCount > 0) collect(active);
    return marks.sort((a, b) => a - b);
  }

  /** Rows with ts in [startTime, endTime] (inclusive). */
  query(startTime: number | string, endTime: number | string): Row[] {
    const [start, end] = Interval.period(startTime, endTime);
    const schema = this.schemaOf();
    const results: Row[] = [];

    for (const id of this.sortedClosedIds()) {
      const meta = this.metaOf(id);
      if (metaSkips(meta?.minTs ?? null, meta?.maxTs ?? null, start, end, true)) continue;
      const seg = this.loadClosed(id);
      if (metaSkips(seg.minTs, seg.maxTs, start, end, true)) continue;
      for (let i = 0; i < seg.rowCount; i++) {
        const ts = seg.get('ts', i);
        if (typeof ts === 'number' && ts >= start && ts <= end) results.push(this.normalizeRow(schema, seg.getRow(i)));
      }
    }

    const active = this.activeSegment;
    if (active && active.rowCount > 0) {
      for (let i = 0; i < active.rowCount; i++) {
        const ts = active.get('ts', i);
        if (typeof ts === 'number' && ts >= start && ts <= end) results.push(this.normalizeRow(schema, active.getRow(i)));
      }
    }
    return results;
  }

  /** Every row of the journal, oldest first. */
  allRows(): Row[] {
    const schema = this.schemaOf();
    const results: Row[] = [];
    for (const id of this.sortedClosedIds()) {
      const seg = this.loadClosed(id);
      for (let i = 0; i < seg.rowCount; i++) results.push(this.normalizeRow(schema, seg.getRow(i)));
    }
    const active = this.activeSegment;
    if (active && active.rowCount > 0) {
      for (let i = 0; i < active.rowCount; i++) results.push(this.normalizeRow(schema, active.getRow(i)));
    }
    return results;
  }

  /** The last `count` rows, oldest of them first. */
  tail(count: number): Row[] {
    if (count <= 0) return [];
    const schema = this.schemaOf();

    const takeFromSegment = (seg: Segment, n: number): Row[] => {
      const rows: Row[] = [];
      for (let i = seg.rowCount - n; i < seg.rowCount; i++) rows.push(this.normalizeRow(schema, seg.getRow(i)));
      return rows;
    };

    let result: Row[] = [];
    const active = this.activeSegment;
    if (active && active.rowCount > 0) result = takeFromSegment(active, Math.min(count, active.rowCount));

    if (result.length < count) {
      for (const id of this.sortedClosedIds().reverse()) {
        if (result.length >= count) break;
        const seg = this.loadClosed(id);
        const chunk = takeFromSegment(seg, Math.min(count - result.length, seg.rowCount));
        result = [...chunk, ...result];
      }
    }
    return result;
  }

  /** A window of `limit` rows at `offset`, oldest-first or newest-first. */
  page(limit: number, offset = 0, order: 'asc' | 'desc' = 'asc'): Row[] {
    if (!Number.isInteger(limit) || limit < 1) return [];
    const schema = this.schemaOf();
    let skip = Number.isInteger(offset) && offset > 0 ? offset : 0;

    const result: Row[] = [];
    const closedIds = this.sortedClosedIds();

    const takeFrom = (seg: Segment): void => {
      if (result.length >= limit) return;
      const r = seg.rowCount;
      if (r === 0) return;
      if (skip >= r) {
        skip -= r;
        return;
      }
      const k = Math.min(limit - result.length, r - skip);
      if (order === 'asc') {
        for (let i = skip; i < skip + k; i++) result.push(this.normalizeRow(schema, seg.getRow(i)));
      } else {
        const startIdx = r - 1 - skip;
        for (let i = 0; i < k; i++) result.push(this.normalizeRow(schema, seg.getRow(startIdx - i)));
      }
      skip = 0;
    };

    if (order === 'asc') {
      for (const id of closedIds) {
        const meta = this.metaOf(id);
        if (meta && skip >= meta.rowCount) {
          skip -= meta.rowCount;
          continue;
        }
        takeFrom(this.loadClosed(id));
      }
      if (this.activeSegment) takeFrom(this.activeSegment);
    } else {
      if (this.activeSegment) takeFrom(this.activeSegment);
      for (const id of closedIds.reverse()) {
        const meta = this.metaOf(id);
        if (meta && skip >= meta.rowCount) {
          skip -= meta.rowCount;
          continue;
        }
        takeFrom(this.loadClosed(id));
      }
    }
    return result;
  }

  /** Vectorized scan: compile the options, then run the plan over the segments. */
  scan(opts: ScanOptions): Row[] {
    const plan = compileScan(opts, this.schemaOf());
    return executeScan(plan, this);
  }

  // --- Time-series reads (delegate to the shared free functions) ---

  /**
   * Events per interval bucket. `interval` — ms or '1d'/'30m'-style string;
   * `period` — [start, end) or "start:end".
   */
  timeline(interval: number | string, period: [number, number] | string): TimelineBucket[] {
    return timeline(this, interval, period);
  }

  /** Aggregates numeric fields over [startTs, endTs] (inclusive). */
  aggregate(startTs: number | string, endTs: number | string, exprs: AggregateExpr[]): Record<string, number | null> {
    return aggregate(this, startTs, endTs, exprs);
  }

  /**
   * Quantiles (e.g. p95/p99) of a numeric field over [startTs, endTs].
   * Returns {pNN: value|null}.
   */
  percentile(
    startTs: number | string,
    endTs: number | string,
    field: string,
    levels: number | number[],
  ): Record<string, number | null> {
    if (typeof field !== 'string' || field.length === 0) throw ErrorManager.make('JRN_PCTL_FIELD');
    const lv = Array.isArray(levels) ? levels.slice() : [levels];
    for (const q of lv) {
      if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0 || q >= 1) throw ErrorManager.make('JRN_PCTL_LEVEL', { level: String(q) });
    }
    const [start, end] = Interval.period(startTs, endTs);
    const rows = this.scan({ start, end, select: [field] });
    const vals: number[] = [];
    for (const r of rows) {
      const v = r[field];
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    return percentileOf(vals, lv);
  }

  /** Downsamples a numeric field to per-bucket aggregates over [startTs, endTs). */
  downsample(
    startTs: number | string,
    endTs: number | string,
    bucketMs: number | string,
    field: string,
    fns: AggFn[],
  ): DownsampleBucket[] {
    return downsample(this, startTs, endTs, bucketMs, field, fns);
  }

  // --- Private helpers ---

  /** Fill missing schema fields with null (in place). */
  private normalizeRow(schema: Schema | null, row: Row): Row {
    if (!schema) return row;
    for (const f of Object.keys(schema)) {
      if (!(f in row)) row[f] = null;
    }
    return row;
  }
}
