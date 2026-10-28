// SegmentMeta.ts — the per-segment .meta sidecar: min/max ts + row counts.
// Time-range queries use it to skip whole files without loading them.

import type { ColumnSummary } from '../core/types.ts';

/** Data shape of one sidecar (the interface merges with the class below). */
export interface SegmentMeta {
  minTs: number | null;
  maxTs: number | null;
  rowCount: number;
  physicalRowCount: number;
  tsCount: number | null;
  summaries: Record<string, ColumnSummary> | null;
}

export class SegmentMeta {
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
      summaries: (m.summaries && typeof m.summaries === 'object') ? m.summaries as Record<string, ColumnSummary> : null
    };
  }

  /** True when a segment with [minTs, maxTs] cannot overlap [start, end]. */
  static skips(minTs: number | null, maxTs: number | null, start: number, end: number, endInclusive: boolean): boolean {
    if (minTs === null || maxTs === null) return false;
    return maxTs < start || (endInclusive ? minTs > end : minTs >= end);
  }
}
