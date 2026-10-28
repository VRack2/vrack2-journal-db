// SegmentStore.ts — the on-disk registry of an open journal's closed segments:
// id→file index, .meta sidecars, LRU segment cache, atomic persist/load/drop,
// and the merge/reencode operations built on top.
//
// Self-contained: it gets the journal directory (pathOf), the segment encoder,
// the cache size and a segment factory — no reference to the Journal.

import fs from 'node:fs';
import path from 'node:path';
import { Segment } from '../format/Segment.ts';
import { LRUCache } from '../core/LRUCache.ts';
import { AtomicJson } from '../core/AtomicJson.ts';
import { SegmentFile } from '../format/SegmentFile.ts';
import ErrorManager from '../errors/ErrorManager.ts';
import type { Row } from '../core/types.ts';
import { LOCK_FILE, META_SUFFIX, SEG_V3_EXT, WAL_FILE, idFromFile, isSegmentFile } from './constants.ts';
import { parseSegmentMeta, type SegmentMeta } from './SegmentMeta.ts';
import type { SegmentEncoder } from './SegmentEncoder.ts';

export interface MergeResult {
  id: string;
  merged: Segment;
  logicalRows: number;
  physicalBefore: number;
  keptRows: number;
}

export class SegmentStore {
  private readonly pathOf: () => string;
  private readonly encoder: SegmentEncoder;
  private readonly makeSegment: (id: string) => Segment;
  /** Segment id → Segment object (LRU) */
  private readonly cache: LRUCache<string, Segment>;
  /** Segment ID → disk file name */
  private readonly index = new Map<string, string>();
  /** segment id → min/max ts + counts from the .meta sidecar (no file load) */
  private readonly meta = new Map<string, SegmentMeta>();
  /** Segment ID counter (also the seed for newId()). */
  counter = 0;
  /** Unique segment ID suffix: prevents two open instances (lock:'off') in the same ms from overwriting a file. */
  private readonly nonce = Math.random().toString(16).slice(2, 8);

  constructor(
    pathOf: () => string,
    encoder: SegmentEncoder,
    cacheSize: number,
    makeSegment: (id: string) => Segment,
  ) {
    this.pathOf = pathOf;
    this.encoder = encoder;
    this.makeSegment = makeSegment;
    this.cache = new LRUCache<string, Segment>(cacheSize);
  }

  /** Index all closed segments in the directory (index + .meta maps); returns the count. */
  scanDir(journalPath: string): number {
    const files = fs.readdirSync(journalPath).filter(isSegmentFile).sort();
    this.index.clear();
    this.meta.clear();
    for (const file of files) {
      const id = idFromFile(file);
      this.index.set(id, file);
      try {
        const metaPath = path.join(journalPath, `${file}${META_SUFFIX}`);
        const parsed = parseSegmentMeta(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
        if (parsed) this.meta.set(id, parsed);
      } catch { /* no .meta or corrupt */ }
    }
    this.counter = files.length;
    return files.length;
  }

  /**
   * Delete all closed-segment files (segments, .meta sidecars, stray .tmp,
   * the WAL — the lock file is kept) and clear all in-memory state.
   */
  clearDir(): void {
    const dir = this.pathOf();
    for (const f of fs.readdirSync(dir)) {
      if (f === LOCK_FILE) continue;
      if (isSegmentFile(f) || f.endsWith(META_SUFFIX) || f.endsWith('.tmp') || f === WAL_FILE) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }
    this.index.clear();
    this.meta.clear();
    this.cache.clear();
  }

  /** Number of closed segments. */
  get size(): number { return this.index.size; }

  /** Disk file name of a closed segment — null if unknown. */
  fileOf(id: string): string | null {
    return this.index.get(id) ?? null;
  }

  /** .meta sidecar of a closed segment — undefined if unknown. */
  metaOf(id: string): SegmentMeta | undefined {
    return this.meta.get(id);
  }

  /** A new unique segment id. */
  newId(): string {
    return `seg_${Date.now()}_${this.counter++}_${this.nonce}`;
  }

  /** Closed segment ids in chronological order (minTs first, then id). */
  sortedIds(): string[] {
    const idKey = (id: string): [number, number, string] => {
      const m = id.match(/^seg_(\d+)_(\d+)_(.+)$/);
      return m ? [Number(m[1]), Number(m[2]), m[3]] : [0, 0, id];
    };
    const minTsOf = (id: string): number => {
      const m = this.meta.get(id);
      return (m && typeof m.minTs === 'number') ? m.minTs : Number.MAX_SAFE_INTEGER;
    };
    return [...this.index.keys()].sort((a, b) => {
      const ma = minTsOf(a), mb = minTsOf(b);
      if (ma !== mb) return ma - mb;
      const ka = idKey(a), kb = idKey(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
    });
  }

  /** Closed segment from the LRU cache or disk (refreshes its .meta entry). */
  loadClosed(id: string): Segment {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const fileName = this.index.get(id);
    if (!fileName) throw ErrorManager.make('JRN_SEG_UNKNOWN', { id });

    let seg: Segment;
    try {
      const buf = fs.readFileSync(path.join(this.pathOf(), fileName));
      seg = SegmentFile.read(buf);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw ErrorManager.make('JRN_SEG_READ', { file: fileName, message: String(message) });
    }
    this.meta.set(id, {
      minTs: seg.minTs,
      maxTs: seg.maxTs,
      rowCount: seg.rowCount,
      physicalRowCount: seg.physicalRowCount || seg.rowCount,
      tsCount: seg.tsCount,
      summaries: seg.summaries
    });
    this.cache.set(id, seg);
    return seg;
  }

  /** The cached segment object, without touching disk — undefined if not cached. */
  cached(id: string): Segment | undefined {
    return this.cache.get(id);
  }

  /**
   * Row totals over closed segments: logical and physical. Uses the .meta
   * sidecars when every segment has one (no file loads); otherwise loads.
   */
  sumRows(): { rowCount: number; physicalRowCount: number } {
    let rowCount = 0;
    let physicalRowCount = 0;
    const allMeta = this.size > 0 && [...this.index.keys()].every(id => this.meta.has(id));
    if (allMeta) {
      for (const m of this.meta.values()) {
        rowCount += m.rowCount;
        physicalRowCount += m.physicalRowCount || m.rowCount;
      }
    } else {
      for (const id of this.sortedIds()) {
        const seg = this.loadClosed(id);
        rowCount += seg.rowCount;
        physicalRowCount += seg.physicalRowCount || seg.rowCount;
      }
    }
    return { rowCount, physicalRowCount };
  }

  /**
   * Atomically persist a segment (tmp + rename), refresh its .meta sidecar,
   * cache and index entries, and drop a superseded file when one existed.
   */
  persist(
    seg: Segment,
    encode: (s: Segment) => Buffer = (s) => this.encoder.encode(s),
    oldFile: string | null = null,
    ext: string = this.encoder.ext(),
  ): void {
    const fileName = `${seg.id}${ext}`;
    const filePath = path.join(this.pathOf(), fileName);
    fs.writeFileSync(`${filePath}.tmp`, encode(seg));
    fs.renameSync(`${filePath}.tmp`, filePath);
    this.writeMeta(seg, fileName);
    this.cache.set(seg.id, seg);
    this.index.set(seg.id, fileName);
    if (oldFile && oldFile !== fileName) {
      fs.rmSync(path.join(this.pathOf(), oldFile), { force: true });
      fs.rmSync(path.join(this.pathOf(), `${oldFile}${META_SUFFIX}`), { force: true });
    }
  }

  private writeMeta(seg: Segment, fileName: string): void {
    const meta: SegmentMeta = {
      minTs: seg.minTs,
      maxTs: seg.maxTs,
      rowCount: seg.rowCount,
      physicalRowCount: seg.physicalRowCount || seg.rowCount,
      tsCount: seg.tsCount,
      summaries: seg.summaries
    };
    this.meta.set(seg.id, meta);
    const metaPath = path.join(this.pathOf(), `${fileName}${META_SUFFIX}`);
    AtomicJson.write(metaPath, meta);
  }

  /** Remove a closed segment (file + .meta) and all its in-memory state. */
  drop(id: string): void {
    const oldFile = this.index.get(id);
    if (oldFile) {
      fs.unlinkSync(path.join(this.pathOf(), oldFile));
      fs.rmSync(path.join(this.pathOf(), `${oldFile}${META_SUFFIX}`), { force: true });
    }
    this.index.delete(id);
    this.cache.delete(id);
    this.meta.delete(id);
  }

  /** Reencode a closed segment to v3 with the given encoder; returns the new file name. */
  reencode(id: string, encode: (seg: Segment) => Buffer): string {
    const seg = this.loadClosed(id);
    const fileName = `${id}${SEG_V3_EXT}`;
    this.persist(seg, encode, this.index.get(id) ?? null, SEG_V3_EXT);
    return fileName;
  }

  /**
   * Merges exactly the given closed segment ids into one new segment, applying
   * `transform` to the combined rows (e.g. an engine merge). Callers bound the
   * id set so peak memory stays proportional to the batch, not the table.
   */
  merge(
    ids: string[],
    transform: (rows: Row[]) => Row[] = (rows) => rows,
    encode: (seg: Segment) => Buffer = (s) => this.encoder.encode(s),
    ext: string = this.encoder.ext(),
  ): MergeResult {
    let logicalRows = 0;
    let physicalBefore = 0;
    const rows: Row[] = [];
    for (const id of ids) {
      const seg = this.loadClosed(id);
      for (let i = 0; i < seg.rowCount; i++) rows.push(seg.getRow(i));
      logicalRows += seg.rowCount;
      physicalBefore += seg.physicalRowCount;
    }

    const kept = transform(rows);
    const merged = this.makeSegment(this.newId());
    for (const row of kept) merged.append(row);

    this.persist(merged, encode, null, ext);
    for (const id of ids) this.drop(id);

    return { id: merged.id, merged, logicalRows, physicalBefore, keptRows: kept.length };
  }

  /** Bounds/counts/size of a closed segment — null when the id is unknown. */
  info(id: string): {
    minTs: number | null; maxTs: number | null;
    rowCount: number | null; physicalRowCount: number | null; bytes: number | null;
  } | null {
    const file = this.index.get(id);
    const meta = this.meta.get(id) ?? null;
    if (!file && !meta) return null;
    let bytes: number | null = null;
    if (file) {
      try { bytes = fs.statSync(path.join(this.pathOf(), file)).size; } catch { bytes = null; }
    }
    return {
      minTs: meta?.minTs ?? null,
      maxTs: meta?.maxTs ?? null,
      rowCount: meta?.rowCount ?? null,
      physicalRowCount: meta?.physicalRowCount ?? null,
      bytes
    };
  }
}
