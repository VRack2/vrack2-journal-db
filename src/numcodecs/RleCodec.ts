// ============================================================
// numcodecs/RleCodec.ts — run-length для целых (lossless, i64 + u32)
// [runsCount u32] [value i64][count u32] ...
// ============================================================

import type { NumCodec } from './types.ts';

export class RleCodec implements NumCodec {
  readonly name = 'rle';

  encode(values: ArrayLike<number>): Buffer {
    const n = values.length;
    if (n === 0) return Buffer.alloc(0);

    const runs: { value: number; count: number }[] = [];
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!Number.isInteger(v)) {
        throw new RangeError('RleCodec: значение не целое — rle только для целых');
      }
      const last = runs[runs.length - 1];
      if (last && last.value === v) {
        last.count++;
      } else {
        runs.push({ value: v, count: 1 });
      }
    }

    const buf = Buffer.alloc(4 + runs.length * 12);
    buf.writeUInt32LE(runs.length, 0);
    let off = 4;
    for (const r of runs) {
      buf.writeBigInt64LE(BigInt(r.value), off);
      buf.writeUInt32LE(r.count, off + 8);
      off += 12;
    }
    return buf;
  }

  decode(buf: Buffer, n: number): Int32Array | Float64Array {
    const runsCount = buf.readUInt32LE(0);
    let off = 4;
    const out = new Array<number>(n);
    let filled = 0;
    for (let r = 0; r < runsCount && filled < n; r++) {
      const value = Number(buf.readBigInt64LE(off));
      const count = buf.readUInt32LE(off + 8);
      off += 12;
      for (let k = 0; k < count && filled < n; k++) {
        out[filled++] = value;
      }
    }
    let fitsInt32 = true;
    for (let i = 0; i < n; i++) {
      if (Math.abs(out[i]) > 2147483647) { fitsInt32 = false; break; }
    }
    if (fitsInt32) {
      const arr = new Int32Array(n);
      for (let i = 0; i < n; i++) arr[i] = out[i];
      return arr;
    }
    const arr = new Float64Array(n);
    for (let i = 0; i < n; i++) arr[i] = out[i];
    return arr;
  }
}
