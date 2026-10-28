// SegmentMeta.ts — the per-segment .meta sidecar: min/max ts + row counts.
// Time-range queries use it to skip whole files without loading them.

import type { ColumnSummary } from '../core/types.ts';
import type { Segment } from '../format/Segment.ts';

/** Data shape of one sidecar (the interface merges with the class below). */
export interface SegmentMeta {
  minTs: number | null;
  maxTs: number | null;
  rowCount: number;
  physicalRowCount: number;
  tsCount: number | null;
  summaries: Record<string, ColumnSummary> | null;
  /** WAL watermark (highest WAL seq covered by the segment); null = unwatermarked. */
  walSeq: number | null;
  /** Byte size of the segment file; null on old sidecars (info() falls back to stat). */
  bytes: number | null;
}

export class SegmentMeta {
  /**
   * Build a sidecar from an in-memory segment (used by both persist/writeMeta
   * and loadClosed so the on-disk and rebuilt-from-file shapes cannot drift).
   */
  static fromSegment(seg: Segment, bytes: number): SegmentMeta {
    return {
      minTs: seg.minTs,
      maxTs: seg.maxTs,
      rowCount: seg.rowCount,
      physicalRowCount: seg.physicalRowCount || seg.rowCount,
      tsCount: seg.tsCount,
      summaries: seg.summaries,
      walSeq: seg.walSeq || null,
      bytes
    };
  }

  /** Parse a .meta sidecar; null when absent/corrupt (segment stays meta-less). */
  static parse(raw: unknown): SegmentMeta | null {
    const m = raw as Record<string, unknown> | null;
    if (!m || typeof m.rowCount !== 'number') return null;
    return {
      minTs: typeof m.minTs === 'number' ? m.minTs : null,
      maxTs: typeof m.maxTs === 'number' ? m.maxTs : null,
      rowCount: m.rowCount,
      physicalRowCount: typeof m.physicalRowCount === 'number' ? m.physicalRowCount : m.rowCount,
      tsCount: typeof m.tsCount === 'number' ? m.tsCount : null,
      summaries: (m.summaries && typeof m.summaries === 'object') ? m.summaries as Record<string, ColumnSummary> : null,
      walSeq: typeof m.walSeq === 'number' ? m.walSeq : null,
      bytes: typeof m.bytes === 'number' ? m.bytes : null
    };
  }

  /** True when a segment with [minTs, maxTs] cannot overlap [start, end]. */
  static skips(minTs: number | null, maxTs: number | null, start: number, end: number, endInclusive: boolean): boolean {
    if (minTs === null || maxTs === null) return false;
    return maxTs < start || (endInclusive ? minTs > end : minTs >= end);
  }

  /**
   * Zone-map pushdown: true when summaries prove NO row can pass ALL where
   * conditions, so the segment can be skipped without loading it.
   *
   * Conservatism rules (summaries cover only rows with a numeric ts and only
   * finite numbers, and columns may mix types):
   *  - numeric comparisons need hasTsFilter (rows without numeric ts are
   *    already rejected by the ts gate, so every passing row is covered);
   *  - eq/in only with an entirely numeric target (non-numeric values are
   *    never === to a number, and never counted in a numeric summary);
   *  - isNull only when count === rowCount (every logical value is a finite
   *    number, so no row can be null);
   *  - ne/nin/isNotNull/missing summary — never skip.
   */
  static skipsWhere(
    meta: SegmentMeta | null,
    conds: { field: string; op: string; value: unknown }[],
    hasTsFilter: boolean
  ): boolean {
    const summaries = meta?.summaries;
    if (!summaries) return false;
    const rowCount = meta!.rowCount;

    for (const c of conds) {
      const s = summaries[c.field];
      if (!s) continue;
      switch (c.op) {
        case 'gt':
          if (hasTsFilter && typeof c.value === 'number' && s.max <= c.value) return true;
          break;
        case 'ge':
          if (hasTsFilter && typeof c.value === 'number' && s.max < c.value) return true;
          break;
        case 'lt':
          if (hasTsFilter && typeof c.value === 'number' && s.min >= c.value) return true;
          break;
        case 'le':
          if (hasTsFilter && typeof c.value === 'number' && s.min > c.value) return true;
          break;
        case 'eq':
          if (hasTsFilter && typeof c.value === 'number' && (s.max < c.value || s.min > c.value)) return true;
          break;
        case 'in':
          if (hasTsFilter && Array.isArray(c.value) && c.value.length > 0
            && c.value.every((v): v is number => typeof v === 'number')
            && !c.value.some((v) => v >= s.min && v <= s.max)) return true;
          break;
        case 'isNull':
          if (s.count === rowCount) return true;
          break;
      }
    }
    return false;
  }
}
