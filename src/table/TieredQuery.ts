// table/TieredQuery.ts — tier-window read paths for Table (query/timeline).
//
// Tier mode splits [start, end] by age into per-tier windows: the finest
// tier is the source over the whole range (moved data is already purged
// from it — no dups), coarser tiers cover only their TTL span.

import type { Journal } from '../journal/Journal.ts';
import { keyOf } from '../journal/scan/plan.ts';
import { Aggregation, type AggAcc } from '../metric/Aggregation.ts';
import type { AggFn, JsonValue, ResolutionTier, Row, ScanOptions, TimelineBucket } from '../core/types.ts';

export class TieredQuery {
  private readonly journals: Journal[];
  private readonly tiers: ResolutionTier[];

  constructor(journals: Journal[], tiers: ResolutionTier[]) {
    this.journals = journals;
    this.tiers = tiers;
  }

  /** Read [startTs, endTs] (inclusive), by ts ↑, from the right tiers. */
  query(startTs: number, endTs: number, now: number): Row[] {
    const lists: Row[][] = [];
    const nullTs: Row[] = [];
    for (let i = 0; i < this.tiers.length; i++) {
      const win = this.window(i, startTs, endTs, now);
      if (win === null) continue;
      const rows = this.journals[i].scan({ start: win.start, end: win.end });
      const numeric: Row[] = [];
      for (const r of rows) {
        if (TieredQuery.tsOf(r) === null) nullTs.push(r);
        else numeric.push(r);
      }
      if (numeric.length > 0) lists.push(numeric);
    }
    const merged = TieredQuery.mergeAsc(lists);
    if (nullTs.length > 0) merged.unshift(...nullTs);
    return merged;
  }

  /**
   * scan() over the tier windows with where/select pushed down to every
   * journal (zone-map + per-row filtering + projection happen there). For asc
   * order the row budget (offset + limit) is pushed down too: the first N rows
   * of the merged stream always live inside the first N of each tier.
   */
  scan(startTs: number, endTs: number, now: number, opts: ScanOptions): Row[] {
    const asc = opts.order !== 'desc';
    const pushSelect = opts.select && opts.select.length > 0
      ? Array.from(new Set([...opts.select, 'ts']))
      : undefined;
    const cap = asc && opts.limit !== undefined && opts.limit >= 0
      ? (opts.offset ?? 0) + opts.limit
      : undefined;

    const lists: Row[][] = [];
    const nullTs: Row[] = [];
    for (let i = 0; i < this.tiers.length; i++) {
      const win = this.window(i, startTs, endTs, now);
      if (win === null) continue;
      const rows = this.journals[i].scan({
        start: win.start,
        end: win.end,
        where: opts.where,
        ...(pushSelect ? { select: pushSelect } : {}),
        ...(cap !== undefined ? { limit: cap } : {}),
        order: 'asc',
      });
      const numeric: Row[] = [];
      for (const r of rows) {
        if (TieredQuery.tsOf(r) === null) nullTs.push(r);
        else numeric.push(r);
      }
      if (numeric.length > 0) lists.push(numeric);
    }
    const merged = TieredQuery.mergeAsc(lists);
    if (nullTs.length > 0) merged.unshift(...nullTs);
    return merged;
  }

  /**
   * Aggregation over the tier windows: each tier journal runs an agg scan
   * (segment summaries fast path included), then identical groups are merged
   * through Aggregation accumulators — min/max/sum/count are additive, avg is
   * rebuilt from sum/count. Output shape matches a journal scan-agg row
   * (`<field>_<fn>` columns: one row per group, or a single row without groupBy).
   */
  aggregate(
    startTs: number, endTs: number, now: number,
    agg: Record<string, AggFn[]>,
    where?: ScanOptions['where'],
    groupBy?: string[],
  ): Row[] {
    const gb = groupBy ?? [];
    // 'count' is always requested per field — the merge needs per-tier counts
    // to fold partial min/max/sum correctly; avg additionally needs 'sum'.
    const req: Record<string, AggFn[]> = {};
    for (const [field, fns] of Object.entries(agg)) {
      const set = new Set<AggFn>(fns);
      set.add('count');
      if (set.has('avg')) set.add('sum');
      req[field] = [...set];
    }

    const groups = new Map<string, { row: Row; accs: Record<string, AggAcc> }>();
    for (let i = 0; i < this.tiers.length; i++) {
      const win = this.window(i, startTs, endTs, now);
      if (win === null) continue;
      const rows = this.journals[i].scan({
        start: win.start,
        end: win.end,
        ...(where && where.length > 0 ? { where } : {}),
        ...(gb.length > 0 ? { groupBy: gb } : {}),
        agg: req,
      });
      for (const r of rows) {
        let key = '';
        for (const g of gb) key += (key ? '\u0000' : '') + keyOf(r[g] as JsonValue);
        let g = groups.get(key);
        if (g === undefined) {
          const accs: Record<string, AggAcc> = {};
          for (const f of Object.keys(req)) accs[f] = Aggregation.newAcc();
          const grow: Row = {};
          for (const f of gb) grow[f] = r[f] ?? null;
          g = { row: grow, accs };
          groups.set(key, g);
        }
        for (const field of Object.keys(req)) {
          const ct = typeof r[`${field}_count`] === 'number' ? (r[`${field}_count`] as number) : 0;
          if (ct <= 0) continue;
          const acc = g.accs[field];
          const mn = r[`${field}_min`];
          const mx = r[`${field}_max`];
          const sm = r[`${field}_sum`];
          if (typeof mn === 'number' && mn < acc.min) acc.min = mn;
          if (typeof mx === 'number' && mx > acc.max) acc.max = mx;
          if (typeof sm === 'number') acc.sum += sm;
          acc.count += ct;
        }
      }
    }

    const out: Row[] = [];
    for (const g of groups.values()) {
      const row: Row = { ...g.row };
      for (const [field, fns] of Object.entries(agg)) {
        for (const fn of fns) row[`${field}_${fn}`] = Aggregation.value(g.accs[field], fn);
      }
      out.push(row);
    }
    const firstField = Object.keys(agg)[0];
    const sortKey = `${firstField}_${agg[firstField][0]}`;
    out.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av !== 'number') return 1;
      if (typeof bv !== 'number') return -1;
      return av - bv;
    });
    return out;
  }

  /** Tier window for [startTs, endTs]: finest covers everything, coarser only their TTL span. */
  private window(i: number, startTs: number, endTs: number, now: number): { start: number; end: number } | null {
    let winStart: number;
    let winEnd: number;
    if (i === 0) {
      winStart = startTs;
      winEnd = Math.min(endTs, now);
    } else {
      winStart = Math.max(startTs, now - this.tiers[i].ttlMs);
      winEnd = Math.min(endTs, now - this.tiers[i - 1].ttlMs);
    }
    return winStart > winEnd ? null : { start: winStart, end: winEnd };
  }

  /**
   * k-way merge of ascending-by-ts row lists (each already sorted by the
   * journal scan). Ties keep list order (tier order) — same relative order a
   * stable sort over the concatenated tiers would produce.
   */
  static mergeAsc(lists: Row[][]): Row[] {
    if (lists.length === 0) return [];
    if (lists.length === 1) return lists[0];

    let remaining = 0;
    for (const l of lists) remaining += l.length;
    const cursors = new Array<number>(lists.length).fill(0);
    const out: Row[] = new Array(remaining);
    let w = 0;

    while (remaining > 0) {
      let best = -1;
      let bestTs = 0;
      for (let i = 0; i < lists.length; i++) {
        const c = cursors[i];
        if (c >= lists[i].length) continue;
        const t = TieredQuery.tsOf(lists[i][c]) as number;
        if (best === -1 || t < bestTs) { best = i; bestTs = t; }
      }
      out[w++] = lists[best][cursors[best]];
      cursors[best]++;
      remaining--;
    }
    return out;
  }

  /** Dense buckets [startTs, endTs] (one per interval) over all tiers. */
  timeline(intervalMs: number, startTs: number, endTs: number, now: number): TimelineBucket[] {
    const rows = this.query(startTs, endTs, now);
    const n = Math.floor((endTs - startTs) / intervalMs);
    const counts = new Array<number>(n).fill(0);
    for (const r of rows) {
      const ts = TieredQuery.tsOf(r);
      if (ts === null) continue;
      const idx = Math.floor((ts - startTs) / intervalMs);
      if (idx >= 0 && idx < n) counts[idx]++;
    }
    const out: TimelineBucket[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const bStart = startTs + i * intervalMs;
      out[i] = {
        start: bStart,
        end: Math.min(bStart + intervalMs, endTs),
        count: counts[i],
        hasData: counts[i] > 0,
      };
    }
    return out;
  }

  static tsOf(row: Row): number | null {
    const v = row['ts'];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /** Ascending ts comparator for row lists (nulls first). */
  static tsCmp(a: Row, b: Row): number {
    return (TieredQuery.tsOf(a) ?? 0) - (TieredQuery.tsOf(b) ?? 0);
  }
}
