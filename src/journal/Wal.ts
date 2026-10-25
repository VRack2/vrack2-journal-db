// Wal.ts — the journal's write-ahead log: a batched line buffer in memory
// plus an append-only file. Drained on flush/close/exit, replayed after a crash.

import fs from 'node:fs';
import { WAL_FLUSH_BYTES } from './constants.ts';

export class Wal {
  private readonly pathOf: () => string;
  private readonly batchSize: number;
  private buf: string[] = [];
  private bufBytes = 0;

  constructor(pathOf: () => string, batchSize: number) {
    this.pathOf = pathOf;
    this.batchSize = batchSize;
  }

  /** Buffer one line; drains to file when the batch is full. True when it drained. */
  push(line: string): boolean {
    this.buf.push(line);
    this.bufBytes += line.length;
    if (this.buf.length >= this.batchSize || this.bufBytes >= WAL_FLUSH_BYTES) {
      this.drain();
      return true;
    }
    return false;
  }

  /** Undo a line that was already drained (truncate it off the WAL file). */
  undoDrained(line: string): void {
    try {
      const p = this.pathOf();
      const size = fs.statSync(p).size;
      const bytes = Buffer.byteLength(line, 'utf-8');
      if (size >= bytes) fs.truncateSync(p, size - bytes);
    } catch { /* WAL might have already been truncated */ }
  }

  /** Undo a line that is still in the in-memory buffer. */
  undoBuffered(line: string): void {
    this.buf.pop();
    this.bufBytes -= line.length;
  }

  /** Append the buffered lines to the WAL file in a single append. */
  drain(): void {
    if (this.buf.length === 0) return;
    const chunk = this.buf.join('');
    this.buf = [];
    this.bufBytes = 0;
    fs.appendFileSync(this.pathOf(), chunk, 'utf-8');
  }

  /** Remove the WAL file (all its rows are durable in segments). */
  truncate(): void {
    fs.rmSync(this.pathOf(), { force: true });
  }

  /** WAL lines since the last crash; empty when the file is absent/empty. */
  readLines(): string[] {
    let content: string;
    try {
      content = fs.readFileSync(this.pathOf(), 'utf-8');
    } catch {
      return [];
    }
    return content.split('\n').filter(l => l.length > 0);
  }

  /** Drop the in-memory buffer (e.g. after clear()). */
  reset(): void {
    this.buf = [];
    this.bufBytes = 0;
  }
}
