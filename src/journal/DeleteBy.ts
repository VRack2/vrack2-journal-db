// ============================================================
// DeleteBy — row-level deletion by arbitrary where-predicates.
// Structurally identical to Purge but with a ScanWhere[] predicate
// instead of a ts boundary. Zone-map skip via SegmentMeta.skipsWhere
// avoids reading segments that provably contain no matching rows.
// Crash-safe: each segment is rewritten atomically (tmp+rename);
// a partial run is idempotent — re-invoking with the same predicate
// finishes the job without duplicating or losing data.
// ============================================================

import type { Metadata, PurgeResult, Row, ScanWhere, Schema } from '../core/types.ts';
import { Segment } from '../format/Segment.ts';
import { whereOne } from './scan/plan.ts';
import { SegmentMeta } from './SegmentMeta.ts';
import type { SegmentStore } from './SegmentStore.ts';
import type { JournalWriter } from './JournalWriter.ts';

export class DeleteBy {
  private readonly store: SegmentStore;
  private readonly writer: JournalWriter;
  private readonly schemaProvider: () => Schema;
  private readonly metadataProvider: () => Metadata | null;

  constructor(
    store: SegmentStore,
    writer: JournalWriter,
    schemaProvider: () => Schema,
    metadataProvider: () => Metadata | null,
  ) {
    this.store = store;
    this.writer = writer;
    this.schemaProvider = schemaProvider;
    this.metadataProvider = metadataProvider;
  }

  /**
   * Removes all rows matching the given conditions (AND-joined).
   * Returns the same shape as PurgeResult.
   */
  run(conds: ScanWhere[]): PurgeResult {
    if (this.writer.activeSegment) {
      this.writer.drain();
      if (this.writer.activeSegment.rowCount > 0) this.writer.flush();
      else this.writer.truncateWAL();
    }

    let removedRows = 0;
    let removedSegments = 0;
    let rewrittenSegments = 0;

    // Normalize conds for SegmentMeta.skipsWhere (it expects {field, op, value}[]).
    const metaConds = conds.map(c => ({ field: c.field, op: c.op, value: c.value ?? null }));

    for (const id of [...this.store.sortedIds()]) {
      const meta = this.store.metaOf(id);

      // Zone-map skip: if the segment's .meta proves no row can match, skip entirely.
      if (meta && SegmentMeta.skipsWhere(meta, metaConds, false)) continue;

      const seg = this.store.loadClosed(id);
      const kept: Row[] = [];
      for (let i = 0; i < seg.rowCount; i++) {
        const row = seg.getRow(i);
        if (!this._matches(row, conds)) kept.push(row);
      }
      const dropped = seg.rowCount - kept.length;
      if (dropped === 0) continue;

      // All rows matched → drop the segment whole.
      if (kept.length === 0) {
        removedRows += dropped;
        this.store.drop(id);
        removedSegments++;
        continue;
      }

      removedRows += dropped;
      const fresh = new Segment(seg.id, this.schemaProvider(), this.metadataProvider() ?? {});
      fresh.clusterKey = seg.clusterKey ? seg.clusterKey.slice() : null;
      for (const row of kept) fresh.append(row);
      fresh.walSeq = seg.walSeq;
      this.store.persist(fresh, undefined, this.store.fileOf(id) ?? null);
      rewrittenSegments++;
    }

    this.writer.createActiveSegment();
    return { removedRows, removedSegments, rewrittenSegments };
  }

  /** Returns true if the row matches ALL conditions (AND). */
  private _matches(row: Row, conds: ScanWhere[]): boolean {
    for (const c of conds) {
      if (!whereOne(row[c.field] ?? null, c.op, c.value ?? null)) return false;
    }
    return true;
  }
}
