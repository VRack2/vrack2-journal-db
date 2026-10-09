// ============================================================
// numcodecs/F64Codec.ts — базовая линия, 8 байт на значение
// ============================================================

import type { NumCodec } from './types.ts';

export class F64Codec implements NumCodec {
  readonly name = 'f64';

  encode(values: ArrayLike<number>): Buffer {
    const n = values.length;
    const buf = Buffer.alloc(n * 8);
    for (let i = 0; i < n; i++) buf.writeDoubleLE(values[i], i * 8);
    return buf;
  }

  decode(buf: Buffer, n: number): Float64Array {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readDoubleLE(i * 8);
    return out;
  }
}
