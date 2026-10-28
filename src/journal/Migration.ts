// ============================================================
// Migration — one-time v2→v3 re-encode of closed segments per open.
// Legacy .json (v2) segment files are re-encoded with the journal's
// encoder into .seg (v3); v3 files and v2 journals are skipped.
// ============================================================

import path from 'node:path';
import type { SegmentStore } from './SegmentStore.ts';
import type { SegmentEncoder } from './SegmentEncoder.ts';
import { detectSegmentFormat } from './segmentFormat.ts';

export class Migration {
  private done = false;
  private readonly store: SegmentStore;
  private readonly encoder: SegmentEncoder;
  private readonly journalPath: () => string;

  constructor(
    store: SegmentStore,
    encoder: SegmentEncoder,
    journalPath: () => string,
  ) {
    this.store = store;
    this.encoder = encoder;
    this.journalPath = journalPath;
  }

  /** Re-encodes all legacy segments once per open; repeats return zeros. */
  run(): { migrated: number; logicalRows: number } {
    if (this.done) return { migrated: 0, logicalRows: 0 };
    this.done = true;

    let migrated = 0;
    let logicalRows = 0;
    for (const id of this.store.sortedIds()) {
      const file = this.store.fileOf(id);
      if (!file || detectSegmentFormat(this.journalPath() + '/' + file) === 'v3') continue;
      this.store.reencode(id, (seg) => this.encoder.encode(seg));
      migrated++;
      const seg = this.store.cached(id);
      if (seg) logicalRows += seg.rowCount;
    }
    return { migrated, logicalRows };
  }
}
