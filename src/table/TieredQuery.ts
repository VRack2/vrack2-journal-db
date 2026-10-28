// table/TieredQuery.ts — tier-window read paths for Table (query/timeline).
//
// Tier mode splits [start, end] by age into per-tier windows: the finest
// tier is the source over the whole range (moved data is already purged
// from it — no dups), coarser tiers cover only their TTL span.

import type { Journal } from '../journal/Journal.ts';
import type { ResolutionTier, Row, TimelineBucket } from '../core/types.ts';

export class TieredQuery {
  private readonly journals: Journal[];
  private readonly tiers: ResolutionTier[];

  constructor(journals: Journal[], tiers: ResolutionTier[]) {
    this.journals = journals;
    this.tiers = tiers;
  }

  /** Read [startTs, endTs] (inclusive), by ts ↑, from the right tiers. */
  query(startTs: number, endTs: number, now: number): Row[] {
    const out: Row[] = [];
    for (let i = 0; i < this.tiers.length; i++) {
      const ttl = this.tiers[i].ttlMs;
      let winStart: number;
      let winEnd: number;
      if (i === 0) {
        winStart = startTs;
        winEnd = Math.min(endTs, now);
      } else {
        winStart = Math.max(startTs, now - ttl);
        winEnd = Math.min(endTs, now - this.tiers[i - 1].ttlMs);
      }
      if (winStart > winEnd) continue;
      const rows = this.journals[i].scan({ start: winStart, end: winEnd });
      for (const r of rows) out.push(r);
    }
    out.sort(TieredQuery.tsCmp);
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
