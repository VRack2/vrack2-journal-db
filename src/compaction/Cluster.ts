// compaction/Cluster.ts — dimension clustering for compaction.
//
// Cluster.sort orders rows by the table's cluster columns (dimension
// primitives first, ts ascending as the tiebreaker) so a compacted segment
// stores same-dimension rows adjacently. Self-contained: it never imports
// journal/scan internals — compaction only gets plain rows and column names.

import type { Row } from '../core/types.ts';

/** Nullish values sort last within a dimension column. */
function compareValues(a: unknown, b: unknown): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  // Mixed or structured types: a stable total order by serialized form.
  const sa = JSON.stringify(a) ?? String(a);
  const sb = JSON.stringify(b) ?? String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export class Cluster {
  /** Compare two rows: cluster columns in order, then ts ascending. */
  static compare(a: Row, b: Row, cols: string[]): number {
    for (const c of cols) {
      const d = compareValues(a[c], b[c]);
      if (d !== 0) return d;
    }
    const ta = typeof a.ts === 'number' ? a.ts : 0;
    const tb = typeof b.ts === 'number' ? b.ts : 0;
    return ta - tb;
  }

  /** Stable sort of rows by the cluster key (dimensions, then ts ↑). */
  static sort(rows: Row[], cols: string[]): Row[] {
    return [...rows].sort((a, b) => Cluster.compare(a, b, cols));
  }
}
