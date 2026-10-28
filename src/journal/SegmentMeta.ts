// SegmentMeta.ts — the per-segment .meta sidecar: min/max ts + row counts.
// Time-range queries use it to skip whole files without loading them.

import type { ColumnSummary, DimPrimitive, DimSummary } from '../core/types.ts';
import type { Column } from '../format/columns/Column.ts';
import type { Segment } from '../format/Segment.ts';

/** Cap for an exact 'set' DimSummary; larger domains fall back to 'range'. */
export const DIM_SET_LIMIT = 64;

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
  /** Dimension fields the segment is clustered by; null = append/ts order. */
  cluster: string[] | null;
  /** True when segment rows are in ts order (early-stop and ts-skip rely on it;
   *  false for clustered segments). Missing on old sidecars → assumed true. */
  tsOrdered: boolean;
  /** Value-domain summaries for cluster dimension columns; null = none. */
  dims: Record<string, DimSummary> | null;
}

/**
 * DimSummary per cluster dimension column: exact primitive set when the
 * column exposes one within DIM_SET_LIMIT (dictionary/RLE backing — free),
 * otherwise min/max over numeric values across ALL physical rows.
 * Derived data: recomputed deterministically from the columns, like the rest
 * of the sidecar, so decoded segments rebuild it without format changes.
 */
function dimsOfSegment(seg: Segment): Record<string, DimSummary> | null {
  if (!seg.clusterKey) return null;
  let dims: Record<string, DimSummary> | null = null;
  for (const field of seg.clusterKey) {
    const col = seg.columns[field];
    if (!col) continue;
    const set = col.distinct(DIM_SET_LIMIT);
    if (set !== null) {
      (dims ??= {})[field] = { t: 'set', v: set };
      continue;
    }
    const scanned = scanDomain(col);
    if (scanned !== null) (dims ??= {})[field] = scanned;
  }
  return dims;
}

/**
 * One-pass domain scan for columns without free distinct metadata: exact
 * primitive set when |set| ≤ DIM_SET_LIMIT, otherwise numeric min/max when
 * the whole domain is numeric. Null when neither applies (objects, mixed
 * non-numeric domain over the cap).
 */
function scanDomain(col: Column): DimSummary | null {
  const set = new Set<DimPrimitive>();
  let setOverflow = false;
  let min: number | null = null;
  let max: number | null = null;
  let anyNumeric = false;
  let nonNumeric = false;
  for (let i = 0; i < col.length; i++) {
    const v = col.get(i);
    if (v === null || v === undefined) {
      if (!setOverflow) set.add(null);
      continue;
    }
    if (typeof v === 'object' || typeof v === 'bigint') return null;
    if (!setOverflow) {
      set.add(v as DimPrimitive);
      if (set.size > DIM_SET_LIMIT) setOverflow = true;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      anyNumeric = true;
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
    } else {
      nonNumeric = true;
    }
  }
  if (!setOverflow) return { t: 'set', v: [...set] };
  if (anyNumeric && !nonNumeric && min !== null && max !== null) return { t: 'range', min, max };
  return null;
}

/** Validate parsed sidecar dims; drops the field summary when malformed. */
function parseDims(raw: unknown): Record<string, DimSummary> | null {
  if (!raw || typeof raw !== 'object') return null;
  let dims: Record<string, DimSummary> | null = null;
  for (const [field, d] of Object.entries(raw as Record<string, unknown>)) {
    if (!d || typeof d !== 'object') continue;
    const s = d as Record<string, unknown>;
    if (s.t === 'set' && Array.isArray(s.v)) {
      const v = (s.v as unknown[]).filter(
        (x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)
      ) as DimPrimitive[];
      if (v.length === (s.v as unknown[]).length) (dims ??= {})[field] = { t: 'set', v };
    } else if (s.t === 'range' && typeof s.min === 'number' && typeof s.max === 'number') {
      (dims ??= {})[field] = { t: 'range', min: s.min, max: s.max };
    }
  }
  return dims;
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
      bytes,
      cluster: seg.clusterKey ? seg.clusterKey.slice() : null,
      tsOrdered: seg.clusterKey === null,
      dims: dimsOfSegment(seg),
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
      bytes: typeof m.bytes === 'number' ? m.bytes : null,
      cluster: Array.isArray(m.cluster) && m.cluster.every((f) => typeof f === 'string' && f.length > 0)
        ? (m.cluster as string[])
        : null,
      tsOrdered: typeof m.tsOrdered === 'boolean' ? m.tsOrdered : true,
      dims: parseDims(m.dims)
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
   *
   * Dimension branch (separate and stronger): dims cover ALL logical rows of
   * the segment — including rows without a numeric ts — so skips on a
   * clustered dimension field do NOT require hasTsFilter. The set is built
   * from PHYSICAL column values, a superset of the logical values, so "value
   * not in set" still proves absence. Non-ts dims with no dims summary fall
   * back to the conservative summaries rules above (numeric comparisons there
   * still need hasTsFilter).
   */
  static skipsWhere(
    meta: SegmentMeta | null,
    conds: { field: string; op: string; value: unknown }[],
    hasTsFilter: boolean
  ): boolean {
    const summaries = meta?.summaries;
    const dims = meta?.dims;
    if (!summaries && !dims) return false;
    const rowCount = meta!.rowCount;

    for (const c of conds) {
      const d = dims?.[c.field];
      if (d) {
        if (d.t === 'set') {
          switch (c.op) {
            case 'eq':
              if (!d.v.some((v) => v === c.value)) return true;
              break;
            case 'in':
              if (Array.isArray(c.value) && c.value.length > 0
                && !c.value.some((v) => d.v.some((x) => x === v))) return true;
              break;
            case 'isNull':
              if (!d.v.some((v) => v === null)) return true;
              break;
          }
        } else {
          switch (c.op) {
            case 'eq':
              if (typeof c.value === 'number' && (c.value < d.min || c.value > d.max)) return true;
              break;
            case 'in':
              if (Array.isArray(c.value) && c.value.length > 0
                && c.value.every((v): v is number => typeof v === 'number')
                && !c.value.some((v) => v >= d.min && v <= d.max)) return true;
              break;
          }
        }
        continue;
      }
      const s = summaries?.[c.field];
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
