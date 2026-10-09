// ============================================================
// numcodecs/DoubleDeltaCodec.ts — вторые разности (lossless, f64)
// v0, v1 как есть; далее d2[i] = (v[i]-v[i-1]) - (v[i-1]-v[i-2])
// ============================================================

import type { NumCodec } from './types.ts';

export class DoubleDeltaCodec implements NumCodec {
  readonly name = 'doubleDelta';

  encode(values: ArrayLike<number>): Buffer {
    const n = values.length;
    if (n === 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(n * 8);
    buf.writeDoubleLE(values[0], 0);
    if (n === 1) return buf;
    buf.writeDoubleLE(values[1], 8);
    let prevD1 = values[1] - values[0];
    for (let i = 2; i < n; i++) {
      const d1 = values[i] - values[i - 1];
      const d2 = d1 - prevD1;
      buf.writeDoubleLE(d2, i * 8);
      prevD1 = d1;
    }
    return buf;
  }

  decode(buf: Buffer, n: number): Float64Array {
    const out = new Float64Array(n);
    if (n === 0) return out;
    out[0] = buf.readDoubleLE(0);
    if (n === 1) return out;
    out[1] = buf.readDoubleLE(8);
    let cur = out[1];
    let prevD1 = cur - out[0];
    for (let i = 2; i < n; i++) {
      const d2 = buf.readDoubleLE(i * 8);
      const d1 = d2 + prevD1;
      cur = cur + d1;
      out[i] = cur;
      prevD1 = d1;
    }
    return out;
  }
}
