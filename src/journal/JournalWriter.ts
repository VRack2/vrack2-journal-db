// JournalWriter.ts — the journal's write path: the active in-memory segment,
// the batched write-ahead log, and the flush that makes the active segment
// durable and rolls to a fresh one.

import path from 'node:path';
import type { Segment } from '../format/Segment.ts';
import type { Row } from '../core/types.ts';
import { WAL_FILE } from './constants.ts';
import { Wal } from './Wal.ts';

export class JournalWriter {
  /** The active in-memory segment (null between open and the first append). */
  activeSegment: Segment | null = null;
  /** The write-ahead log (batched buffer + append-only file). */
  readonly wal: Wal;

  private readonly pathOf: () => string;
  private readonly makeSegment: (id: string) => Segment;
  private readonly newId: () => string;
  private readonly rowsPerSegment: number;
  private readonly persist: (seg: Segment) => void;

  constructor(
    pathOf: () => string,
    makeSegment: (id: string) => Segment,
    newId: () => string,
    rowsPerSegment: number,
    walBatchSize: number,
    persist: (seg: Segment) => void,
  ) {
    this.pathOf = pathOf;
    this.makeSegment = makeSegment;
    this.newId = newId;
    this.rowsPerSegment = rowsPerSegment;
    this.persist = persist;
    this.wal = new Wal(() => path.join(this.pathOf(), WAL_FILE), walBatchSize);
  }

  /**
   * Appends a row: WAL line first, then the active segment (the WAL line is
   * rolled back when the segment rejects the row). Returns true when the
   * segment filled up and was flushed.
   */
  append(row: Row): boolean {
    const seg = this.activeSegment!;
    const line = JSON.stringify(row) + '\n';
    const drained = this.wal.push(line);
    try {
      seg.append(row);
    } catch (e) {
      if (drained) this.wal.undoDrained(line);
      else this.wal.undoBuffered(line);
      throw e;
    }
    if (seg.rowCount >= this.rowsPerSegment) {
      this.flush();
      return true;
    }
    return false;
  }

  /** Replays WAL lines into the active segment (crash recovery), then clears the WAL. */
  replay(lines: string[]): void {
    for (const line of lines) this.appendInMemory(JSON.parse(line) as Row);
    this.wal.truncate();
  }

  /**
   * Makes the active segment durable (WAL drain → persist → fresh segment →
   * WAL truncate). No-op for an empty segment.
   */
  flush(): void {
    const segment = this.activeSegment;
    if (!segment || segment.rowCount === 0) return;
    this.wal.drain();
    this.persist(segment);
    this.createActiveSegment();
    this.wal.truncate();
  }

  /** A fresh empty active segment. */
  createActiveSegment(): void {
    this.activeSegment = this.makeSegment(this.newId());
  }

  /** Drop the WAL buffer and roll to a fresh active segment (after clear()). */
  reset(): void {
    this.wal.reset();
    this.createActiveSegment();
  }

  /** Drain the WAL buffer to disk (also called from the process exit hook). */
  drain(): void {
    this.wal.drain();
  }

  /** Drop the active segment without persisting (journal close). */
  end(): void {
    this.activeSegment = null;
  }

  /** Remove the WAL file (all its rows are durable in segments). */
  truncateWAL(): void {
    this.wal.truncate();
  }

  /** Append without a WAL line (WAL replay only). */
  private appendInMemory(row: Row): void {
    const seg = this.activeSegment!;
    seg.append(row);
    if (seg.rowCount >= this.rowsPerSegment) this.flush();
  }
}
