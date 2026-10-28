// AutoCompactor.ts — background auto-compaction. append() only *arms* a pass;
// the work runs in bounded batches off the hot path so the heap never holds
// the whole table at once. A pass self-chains while compaction debt remains
// and self-adapts its row budget to the machine's load.
//
// Self-contained: it works on the SegmentStore directly and gets the merge
// operation as a callback — no reference to the Journal.

import type { SegmentStore } from './SegmentStore.ts';

interface AutoCompactorOptions {
  /** Minimum number of closed segments before a pass runs. */
  minSegments: number;
  /** Row-count fallback for segments without a .meta sidecar. */
  fallbackRows: number;
  /** Whether compaction may run right now (journal open + feature enabled). */
  shouldRun: () => boolean;
  /** Merges exactly the given closed segment ids into one new segment. */
  mergeBatch: (ids: string[]) => void;
}

export class AutoCompactor {
  private readonly store: SegmentStore;
  private readonly opts: AutoCompactorOptions;
  private armed = false;    // a pass is scheduled (de-duplicates scheduling)
  private compacting = false; // a pass is running (reentrancy guard)
  /** Adaptive rows-per-pass budget (the memory bound). */
  private rowsPerPass = 200_000;
  /** Target wall-time for one pass; drives adapt(). */
  private readonly passTimeBudgetMs = 25;
  private readonly minRowsPerPass = 20_000;
  private readonly maxRowsPerPass = 500_000;

  constructor(store: SegmentStore, opts: AutoCompactorOptions) {
    this.store = store;
    this.opts = opts;
  }

  /**
   * Runs ONE bounded compaction pass, then self-chains while compaction debt
   * remains. No-op when disabled / no debt / already busy.
   */
  tick(): void {
    if (!this.opts.shouldRun()) return;
    if (this.armed || this.compacting) return;
    if (this.store.size < this.opts.minSegments) return;

    this.armed = true;
    this.compacting = true;
    let dt = 0;
    try {
      const closed = this.store.sortedIds();
      if (closed.length >= 2) {
        const batch = this.pickBatch(closed, this.rowsPerPass);
        const t0 = Date.now();
        this.opts.mergeBatch(batch);
        dt = Date.now() - t0;
      }
    } finally {
      this.armed = false;
      this.compacting = false;
    }

    this.adapt(dt);

    // Drain the remaining debt in the background, yielding to the event loop
    // (and the GC) between passes so the writer is never blocked on a
    // full-table merge.
    if (this.opts.shouldRun() && this.store.size >= this.opts.minSegments) {
      setImmediate(() => this.tick());
    }
  }

  /** A pass is running (reentrancy guard). */
  get busy(): boolean { return this.compacting; }

  /** Reset scheduling state (on journal close). */
  reset(): void {
    this.armed = false;
    this.compacting = false;
  }

  /**
   * Chooses the oldest closed segments up to `budgetRows` (the memory bound).
   * Always returns at least 2 ids (a merge needs >= 2) and never more than
   * the budget, so peak memory tracks the budget, not the table size.
   */
  private pickBatch(closed: string[], budgetRows: number): string[] {
    if (closed.length < 2) return closed;
    let rows = 0;
    const out: string[] = [];
    for (const id of closed) {
      out.push(id);
      rows += this.store.metaOf(id)?.rowCount ?? this.opts.fallbackRows;
      if (out.length >= 2 && rows >= budgetRows) break;
    }
    return out;
  }

  /**
   * Adapts the rows-per-pass budget to the machine's load. A pass that took
   * too long shrinks the next batch (more frequent, smaller, gentler on the
   * writer); one that was fast grows it (fewer passes, less churn).
   */
  private adapt(dt: number): void {
    if (dt <= 0) return;
    if (dt >= this.passTimeBudgetMs) {
      this.rowsPerPass = Math.max(this.minRowsPerPass, this.rowsPerPass >> 1);
    } else if (dt <= this.passTimeBudgetMs / 4) {
      this.rowsPerPass = Math.min(this.maxRowsPerPass, Math.floor(this.rowsPerPass * 1.5));
    }
  }
}
