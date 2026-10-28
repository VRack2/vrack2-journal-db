// columns/Column.ts — Base abstract column class.
//
// Owns BOTH encodings of column values:
//   - v2 (JSON): serialize()/deserialize() per subclass;
//   - v3 (binary blobs): encodeBlob()/decodeBlob() — shared here, because the
//     v3 layout depends only on the VALUES (numeric mask+codec vs dictionary),
//     not on the in-memory representation. SegmentFileV3 is just the container.

import { NumCodecs } from '../numcodecs/NumCodecs.ts';
import type { JsonValue, SerializedColumn } from '../../core/types.ts';

/** v3 blob layout kind. */
export type BlobKind = 'numeric' | 'dict';

interface BlobCodecOptions {
  /** Explicit numeric codec for this column; omitted → auto-pick from data. */
  codec?: string;
}

interface BlobResult {
  kind: BlobKind;
  buf: Buffer;
  /** Numeric blob: the codec ACTUALLY used (requested one may fall back to f64). */
  codecUsed?: string;
}

/** Base column class. */
export abstract class Column {
  protected _length = 0;

  get length(): number {
    return this._length;
  }

  abstract append(value: JsonValue): void;
  abstract get(index: number): JsonValue;
  abstract serialize(): SerializedColumn;
  abstract deserialize(data: SerializedColumn): void;

  // --------------------------------------------------
  // v3 binary blob encoding (values-driven, format-neutral)
  // --------------------------------------------------

  /** Encode this column's values as a v3 blob. */
  encodeBlob(opts: BlobCodecOptions = {}): BlobResult {
    const values: JsonValue[] = new Array(this._length);
    for (let i = 0; i < this._length; i++) values[i] = this.get(i);

    if (Column.pickKind(values) === 'numeric') {
      const numeric = values.filter((v): v is number => typeof v === 'number');
      const requested = opts.codec ?? NumCodecs.autoPick(numeric);
      const { buf, codecUsed } = Column.encodeNumericBlob(values, requested);
      return { kind: 'numeric', buf, codecUsed };
    }
    return { kind: 'dict', buf: Column.encodeDictBlob(values) };
  }

  /** Decode a v3 blob into this column. */
  decodeBlob(kind: BlobKind, blob: Buffer, codec: string | undefined, physicalRowCount: number): void {
    const values = kind === 'numeric'
      ? Column.decodeNumericBlob(blob, codec ?? 'f64', physicalRowCount)
      : Column.decodeDictBlob(blob);
    for (const v of values) this.append(v);
  }

  private static pickKind(values: JsonValue[]): BlobKind {
    if (values.length === 0) return 'numeric';
    for (const v of values) {
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'dict';
    }
    return 'numeric';
  }

  private static dictKey(v: JsonValue): string {
    if (v === null || v === undefined) return '\0null';
    if (typeof v === 'object') return 'o' + JSON.stringify(v);
    return typeof v + ':' + String(v);
  }

  private static encodeNumericBlob(
    values: JsonValue[],
    codecName: string
  ): { buf: Buffer; codecUsed: string } {
    const n = values.length;
    const maskBytes = Math.ceil(n / 8);
    const mask = new Uint8Array(maskBytes);
    const nonNull: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || v === undefined) {
        mask[i >> 3] |= 1 << (7 - (i & 7));
      } else {
        nonNull.push(v as number);
      }
    }

    // Unknown codec name — error (typos must not silently fall into f64).
    const codec = NumCodecs.get(codecName);
    // Requested codec didn't fit the data (e.g. rle on fractions — throws) →
    // fall back to f64 and record the ACTUALLY USED codec in the header.
    let codecUsed = codecName;
    let codecBuf: Buffer;
    try {
      codecBuf = codec.encode(nonNull);
    } catch {
      codecUsed = 'f64';
      codecBuf = NumCodecs.get('f64').encode(nonNull);
    }

    const head = Buffer.alloc(4);
    head.writeUInt32LE(nonNull.length, 0);
    const buf = Buffer.concat([head, Buffer.from(mask), codecBuf]);
    return { buf, codecUsed };
  }

  private static encodeDictBlob(values: JsonValue[]): Buffer {
    const dict: JsonValue[] = [];
    const map = new Map<string, number>();
    const indices: number[] = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i] === undefined ? null : values[i];
      const key = Column.dictKey(v);
      let idx = map.get(key);
      if (idx === undefined) {
        idx = dict.length;
        dict.push(v);
        map.set(key, idx);
      }
      indices[i] = idx;
    }

    const parts: Buffer[] = [];
    const head = Buffer.alloc(8);
    head.writeUInt32LE(values.length, 0);
    head.writeUInt32LE(dict.length, 4);
    parts.push(head);
    for (const entry of dict) {
      const enc = Buffer.from(JSON.stringify(entry), 'utf-8');
      const len = Buffer.alloc(4);
      len.writeUInt32LE(enc.length, 0);
      parts.push(len, enc);
    }
    const idxBuf = Buffer.alloc(indices.length * 4);
    for (let i = 0; i < indices.length; i++) idxBuf.writeUInt32LE(indices[i], i * 4);
    parts.push(idxBuf);
    return Buffer.concat(parts);
  }

  private static decodeNumericBlob(blob: Buffer, codecName: string, physicalRowCount: number): JsonValue[] {
    let off = 0;
    const nonNullCount = blob.readUInt32LE(off); off += 4;
    const maskBytes = Math.ceil(physicalRowCount / 8);
    const mask = blob.subarray(off, off + maskBytes); off += maskBytes;
    const codecBuf = blob.subarray(off);

    const codec = NumCodecs.get(codecName);
    const vals = codec.decode(codecBuf, nonNullCount);

    const out: JsonValue[] = new Array(physicalRowCount);
    let vi = 0;
    for (let i = 0; i < physicalRowCount; i++) {
      const isNull = (mask[i >> 3] >> (7 - (i & 7))) & 1;
      if (isNull) out[i] = null;
      else out[i] = vals[vi++];
    }
    return out;
  }

  private static decodeDictBlob(blob: Buffer): JsonValue[] {
    let off = 0;
    const rowCnt = blob.readUInt32LE(off); off += 4;
    const dictCnt = blob.readUInt32LE(off); off += 4;
    const dict: JsonValue[] = new Array(dictCnt);
    for (let i = 0; i < dictCnt; i++) {
      const len = blob.readUInt32LE(off); off += 4;
      dict[i] = JSON.parse(blob.subarray(off, off + len).toString('utf-8'));
      off += len;
    }
    const out: JsonValue[] = new Array(rowCnt);
    for (let i = 0; i < rowCnt; i++) {
      const idx = blob.readUInt32LE(off); off += 4;
      out[i] = dict[idx];
    }
    return out;
  }
}
