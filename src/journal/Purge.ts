// ============================================================
// Purge — row-level deletion before a timestamp (Фаза 4).
// Segments entirely older than the bound are dropped whole;
// segments straddling it are rewritten keeping rows with ts >= bound.
// Works on the closed-segment store; the active segment is drained
// and replaced around the sweep.
// ============================================================

import type { Metadata, PurgeResult, Row, Schema } from '../core/types.ts';
import { Segment } from '../format/Segment.ts';
import type { SegmentStore } from './SegmentStore.ts';
import type { JournalWriter } from './JournalWriter.ts';

export class Purge {
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

  /** Deletes all rows with ts < before. `before` is an absolute ms timestamp. */
  run(before: number): PurgeResult {
    if (this.writer.activeSegment) {
      this.writer.drain();
      if (this.writer.activeSegment.rowCount > 0) this.writer.flush();
      else this.writer.truncateWAL();
    }

    let removedRows = 0;
    let removedSegments = 0;
    let rewrittenSegments = 0;

    for (const id of [...this.store.sortedIds()]) {
      const meta = this.store.metaOf(id);
      const minTs = meta?.minTs ?? null;
      const maxTs = meta?.maxTs ?? null;
      const rowCount = meta?.rowCount ?? null;
      const tsCount = meta?.tsCount ?? null;

      if (maxTs !== null && maxTs < before && rowCount !== null && tsCount !== null && tsCount === rowCount) {
        removedRows += rowCount;
        this.store.drop(id);
        removedSegments++;
        continue;
      }
      if (minTs !== null && minTs >= before) continue;

      const seg = this.store.loadClosed(id);
      const kept: Row[] = [];
      for (let i = 0; i < seg.rowCount; i++) {
        const row = seg.getRow(i);
        const ts = row.ts;
        if (typeof ts !== 'number' || ts >= before) kept.push(row);
      }
      const dropped = seg.rowCount - kept.length;
      if (dropped === 0) continue;

      removedRows += dropped;
      const fresh = new Segment(seg.id, this.schemaProvider(), this.metadataProvider() ?? {});
      for (const row of kept) fresh.append(row);
      this.store.persist(fresh, undefined, this.store.fileOf(id) ?? null);
      rewrittenSegments++;
    }

    this.writer.createActiveSegment();
    return { removedRows, removedSegments, rewrittenSegments };
  }
}
