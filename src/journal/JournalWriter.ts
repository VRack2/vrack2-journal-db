// JournalWriter.ts — the journal's write path: the active in-memory segment,
// the batched write-ahead log, and the flush that makes the active segment
// durable and rolls to a fresh one.

import path from 'node:path';
import ErrorManager from '../errors/ErrorManager.ts';
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
  /** WAL strategy: 'off' skips every WAL write (no per-row cost, no crash replay). */
  private readonly walEnabled: boolean;

  /** Monotonic WAL sequence counter; seeded from the closed-segment watermark at open. */
  private walSeq = 0;

  constructor(
    pathOf: () => string,
    makeSegment: (id: string) => Segment,
    newId: () => string,
    rowsPerSegment: number,
    walBatchSize: number,
    walMode: 'on' | 'off',
    persist: (seg: Segment) => void,
  ) {
    this.pathOf = pathOf;
    this.makeSegment = makeSegment;
    this.newId = newId;
    this.rowsPerSegment = rowsPerSegment;
    this.persist = persist;
    this.walEnabled = walMode === 'on';
    this.wal = new Wal(() => path.join(this.pathOf(), WAL_FILE), walBatchSize);
  }

  /**
   * Seed the sequence counter from the closed segments' watermarks after open,
   * so new WAL lines continue the numbering and replay can skip covered seqs.
   */
  seedWalSeq(seq: number): void {
    if (seq > this.walSeq) this.walSeq = seq;
  }

  /**
   * Appends a row: WAL line first, then the active segment (the WAL line is
   * rolled back when the segment rejects the row). Returns true when the
   * segment filled up and was flushed.
   */
  append(row: Row): boolean {
    const seg = this.activeSegment!;
    if (this.walEnabled) {
      const seq = ++this.walSeq;
      const line = `${seq} ${JSON.stringify(row)}\n`;
      const drained = this.wal.push(line);
      try {
        seg.append(row);
      } catch (e) {
        if (drained) this.wal.undoDrained(line);
        else this.wal.undoBuffered(line);
        throw e;
      }
    } else {
      seg.append(row);
    }
    if (seg.rowCount >= this.rowsPerSegment) {
      this.flush();
      return true;
    }
    return false;
  }

  /**
   * Replays WAL lines into the active segment (crash recovery), then clears
   * the WAL. Lines carry a `<seq> <json>` prefix: everything at or below the
   * closed-segment watermark is already durable and skipped. A corrupt final
   * line (torn write at crash point) is dropped; corruption mid-file throws.
   * Lines without the prefix that parse as JSON are pre-watermark (legacy)
   * WAL entries: no seq, no watermark — they are replayed whole, exactly as
   * before the watermark feature. A seq prefix must be a safe integer and
   * strictly increasing: anything else is corruption (a bogus huge seq would
   * poison the watermark and silently skip later rows).
   */
  replay(lines: string[], covered: number): void {
    let prevSeq = 0;
    for (let i = 0; i < lines.length; i++) {
      const last = i === lines.length - 1;
      const match = /^(\d+) (.+)$/.exec(lines[i]);
      if (!match) {
        if (lines[i].startsWith('{')) {
          // Legacy pre-watermark line: plain JSON, replayed without seq dedup.
          let legacy: Row;
          try {
            legacy = JSON.parse(lines[i]) as Row;
          } catch {
            if (last) break;
            throw ErrorManager.make('JRN_WAL_CORRUPT', { line: i + 1 });
          }
          this.appendInMemory(legacy);
          continue;
        }
        if (last) break;
        throw ErrorManager.make('JRN_WAL_CORRUPT', { line: i + 1 });
      }
      const seq = Number(match[1]);
      if (!Number.isSafeInteger(seq) || seq <= prevSeq) {
        // Not a torn byte sequence (that breaks JSON parsing) — a logically
        // invalid prefix is corruption wherever it sits.
        throw ErrorManager.make('JRN_WAL_CORRUPT', { line: i + 1 });
      }
      prevSeq = seq;
      if (seq <= covered) continue;
      let row: Row;
      try {
        row = JSON.parse(match[2]) as Row;
      } catch {
        if (last) break;
        throw ErrorManager.make('JRN_WAL_CORRUPT', { line: i + 1 });
      }
      this.walSeq = seq; // a flush during replay must stamp this watermark
      this.appendInMemory(row);
    }
    this.wal.truncate();
  }

  /**
   * Makes the active segment durable (WAL drain → persist → fresh segment →
   * WAL truncate). No-op for an empty segment. The segment carries the WAL
   * watermark, so a crash between persist and truncate cannot duplicate rows.
   */
  flush(): void {
    const segment = this.activeSegment;
    if (!segment || segment.rowCount === 0) return;
    if (this.walEnabled) this.wal.drain();
    segment.walSeq = this.walSeq;
    this.persist(segment);
    this.createActiveSegment();
    if (this.walEnabled) this.wal.truncate();
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
