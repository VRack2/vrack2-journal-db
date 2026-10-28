// SegmentFileV3.ts — Binary segment container (version 4). Container only:
// header, blob framing, compression and CRC32 live here; per-column value
// encoding lives in Column.encodeBlob/decodeBlob (single codec layer).
//
//   [0..3]     "JSDB"
//   [4]        4  (container version; anything else → SFW3_BAD_VERSION)
//   [5..7]     0
//   [8..11]    headerLen (u32 LE)
//   [12 ..]    header JSON (UTF-8): schema, summaries, column kind/codec/type,
//              column order, compression method
//   then, for each column (in columnOrder):
//     [blobLen u32]
//     [compressed blob]   (gzip by default, zstd — option)
//   then:
//     [rowMapLen × u32 LE]  — binary logical→physical map
//   [N-4..N-1] CRC32 of all preceding bytes
//
// Columns:
//   numeric — null mask + numeric codec (f64|doubleDelta|gorilla|rle)
//   dict    — dictionary of distinct values + index per row
//
// Lossless: all values are restored exactly. This is the only readable
// on-disk format — older generations are rejected with a coded error.

import zlib from 'node:zlib';
import { Segment } from './Segment.ts';
import { ColumnFactory } from './columns/ColumnFactory.ts';
import type { BlobKind } from './columns/Column.ts';
import { Compression } from '../core/Compression.ts';
import type {
  ColumnSummary,
  ColumnType,
  CompressionKind,
  Metadata,
  Schema,
} from '../core/types.ts';
import ErrorManager from '../errors/ErrorManager.ts';

ErrorManager.registerMany('SegmentFileV3', [
  { short: 'SFW3_NOT_V3', description: 'decode: buffer is not a JSDB segment file' },
  { short: 'SFW3_BAD_VERSION', description: 'Unsupported segment container version', rules: { version: 'number' } },
  { short: 'SFW3_TOO_SMALL', description: 'Corrupted segment: file too small' },
  { short: 'SFW3_CRC', description: 'Corrupted segment: checksum mismatch' },
  { short: 'SFW3_NO_ROWMAP', description: 'Corrupted segment: binary rowMap tail missing from header' },
  { short: 'SFW3_ZSTD_REQUIRED', description: 'Segment uses zstd: requires Node.js >= 23.8' },
]);

/** Container version written and read (the only supported one). */
const V4 = 4;

export interface V3EncodeOptions {
  /** Blob compression: 'zstd' (default on Node ≥ 23.8) or 'gzip'. */
  compression?: CompressionKind;
  /** Explicit numeric codec for a column (field → codec name).
   *  Omitted columns — every codec is tried and the smallest result is kept. */
  codecs?: Record<string, string>;
}

interface V3ColSpec {
  kind: BlobKind;
  codec?: string;
  /** Schema column type of this field (declared representation).
   *  Absent in files written before this field existed — decode falls
   *  back to the header schema / 'auto'. */
  type?: ColumnType;
}

interface V3Header {
  v: number;
  id: string;
  schema: Schema;
  metadata: Metadata;
  rowCount: number;
  physicalRowCount: number;
  tsCount: number;
  /** WAL watermark (highest WAL seq covered); 0/absent = unwatermarked. */
  walSeq?: number;
  minTs: number | null;
  maxTs: number | null;
  /** Length of the binary logical→physical map tail. */
  rowMapLen: number;
  summaries: Record<string, ColumnSummary>;
  compression: CompressionKind;
  columnOrder: string[];
  columns: Record<string, V3ColSpec>;
}

export class SegmentFileV3 {
  /** Whether the buffer starts with the "JSDB" magic bytes. */
  static hasMagic(buf: Buffer): boolean {
    return buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from('JSDB', 'ascii'));
  }

  /** Whether the buffer is the current (v4) segment container. */
  static isV3(buf: Buffer): boolean {
    return buf.length >= 5 && this.hasMagic(buf) && buf[4] === V4;
  }

  /** Serialize a segment to a v3 buffer (binary blobs + compression + CRC32). */
  static encode(segment: Segment, opts: V3EncodeOptions = {}): Buffer {
    // Record the kind actually applied — an explicit 'zstd' on a Node without
    // zstd compresses as gzip, and the header must say 'gzip' so any Node
    // can read the file back.
    const compression: CompressionKind = Compression.resolve(opts.compression ?? Compression.default());
    const columnOrder = Object.keys(segment.schema);

    const specs: Record<string, V3ColSpec> = {};
    const blobs: Buffer[] = new Array(columnOrder.length);

    for (let ci = 0; ci < columnOrder.length; ci++) {
      const field = columnOrder[ci];
      const col = segment.columns[field];
      const blob = col.encodeBlob({ codec: opts.codecs?.[field] });
      specs[field] = { kind: blob.kind, codec: blob.codecUsed, type: segment.schema[field] };
      blobs[ci] = Compression.compress(blob.buf, compression);
    }

    const header: V3Header = {
      v: V4,
      id: segment.id,
      schema: segment.schema,
      metadata: segment.metadata,
      rowCount: segment.rowCount,
      physicalRowCount: segment.physicalRowCount,
      tsCount: segment.tsCount,
      walSeq: segment.walSeq,
      minTs: segment.minTs,
      maxTs: segment.maxTs,
      rowMapLen: segment.rowMap.length,
      summaries: segment.summaries,
      compression,
      columnOrder,
      columns: specs
    };

    const headerBuf = Buffer.from(JSON.stringify(header), 'utf-8');
    const headLen = Buffer.alloc(4);
    headLen.writeUInt32LE(headerBuf.length, 0);

    const magic = Buffer.alloc(8);
    magic.write('JSDB', 0, 'ascii');
    magic[4] = V4;

    const parts: Buffer[] = [magic, headLen, headerBuf];
    for (let ci = 0; ci < columnOrder.length; ci++) {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(blobs[ci].length, 0);
      parts.push(len, blobs[ci]);
    }

    // Binary rowMap tail: one u32 per logical row (JSON numbers cost ~4x).
    const rowMapBuf = Buffer.alloc(segment.rowMap.length * 4);
    for (let i = 0; i < segment.rowMap.length; i++) rowMapBuf.writeUInt32LE(segment.rowMap[i], i * 4);
    parts.push(rowMapBuf);

    const body = Buffer.concat(parts);
    const crc = zlib.crc32(body) >>> 0;
    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(crc, 0);
    return Buffer.concat([body, tail]);
  }

  /** Segment buffer → in-memory segment. */
  static decode(buf: Buffer): Segment {
    if (!this.hasMagic(buf)) {
      throw ErrorManager.make('SFW3_NOT_V3');
    }
    // Container version first — an older/unknown generation gets a clean
    // coded error instead of a CRC/decode failure on its own layout.
    if (buf[4] !== V4) {
      throw ErrorManager.make('SFW3_BAD_VERSION', { version: buf[4] });
    }
    if (buf.length < 12) {
      throw ErrorManager.make('SFW3_TOO_SMALL');
    }

    // CRC32 before decompression — corrupt files are rejected
    const body = buf.subarray(0, buf.length - 4);
    const storedCrc = buf.readUInt32LE(buf.length - 4);
    const actualCrc = zlib.crc32(body) >>> 0;
    if (storedCrc !== actualCrc) {
      throw ErrorManager.make('SFW3_CRC');
    }

    const headerLen = buf.readUInt32LE(8);
    const headerBuf = buf.subarray(12, 12 + headerLen);
    const header = JSON.parse(headerBuf.toString('utf-8')) as V3Header;
    let off = 12 + headerLen;

    const compression: CompressionKind = header.compression ?? 'gzip';
    if (compression === 'zstd' && !Compression.zstdAvailable()) {
      throw ErrorManager.make('SFW3_ZSTD_REQUIRED');
    }
    const blobMap = new Map<string, Buffer>();
    for (const field of header.columnOrder) {
      const blobLen = buf.readUInt32LE(off); off += 4;
      const blobBuf = buf.subarray(off, off + blobLen); off += blobLen;
      blobMap.set(field, Compression.decompress(blobBuf, compression));
    }

    // rowMap: a binary u32 tail, always present in a v4 file (its length is
    // in the header); a missing tail is caught as corruption.
    if (typeof header.rowMapLen !== 'number') {
      throw ErrorManager.make('SFW3_NO_ROWMAP');
    }
    const rowMap = new Array<number>(header.rowMapLen);
    for (let i = 0; i < header.rowMapLen; i++) { rowMap[i] = buf.readUInt32LE(off); off += 4; }

    const seg = new Segment(header.id, header.schema, header.metadata);
    seg.rowCount = header.rowCount;
    seg.physicalRowCount = header.physicalRowCount;
    seg.minTs = header.minTs;
    seg.maxTs = header.maxTs;
    // v3 writes always store tsCount and summaries (see encode) — no fallback needed
    seg.tsCount = typeof header.tsCount === 'number' ? header.tsCount : 0;
    seg.walSeq = typeof header.walSeq === 'number' ? header.walSeq : 0;
    seg.rowMap = rowMap;
    seg.summaries = header.summaries && typeof header.summaries === 'object'
      ? header.summaries
      : {};

    for (const field of header.columnOrder) {
      const spec = header.columns[field];
      const blob = blobMap.get(field)!;
      // Recreate the column with its declared type (header "type"; old files
      // without it fall back to the header schema, then 'auto').
      const declared: ColumnType | undefined = spec.type ?? header.schema[field] ?? 'auto';
      const col = ColumnFactory.create(declared);
      seg.columns[field] = col;
      col.decodeBlob(spec.kind, blob, spec.codec, header.physicalRowCount);
    }

    return seg;
  }
}
