// ============================================================
// numcodecs/GorillaCodec.ts — XOR соседних double (lossless, битовый)
//
// Схема (само-консистентная, без потерь):
//   первое значение — 64 бита как есть (hi32, lo32);
//   далее x = prev XOR cur (64 бита):
//     x == 0        → 1 бит (0);
//     x != 0        → 1(1) + 6 бит L (ведущие нули, 0..63)
//                     + (64-L) бит значимой части:
//                       S = 64-L <= 32 → S бит lo32;
//                       S >  32        → (S-32) бит hi32, затем 32 бит lo32.
//   Медленно меняющиеся float (CPU/RAM) → малый x → мало бит.
// ============================================================

import { BitWriter } from './BitWriter.ts';
import { BitReader } from './BitReader.ts';
import type { NumCodec } from './types.ts';

export class GorillaCodec implements NumCodec {
  readonly name = 'gorilla';

  encode(values: ArrayLike<number>): Buffer {
    const n = values.length;
    if (n === 0) return Buffer.alloc(0);

    const w = new BitWriter();
    const [fhi, flo] = GorillaCodec.f64ToParts(values[0]);
    w.write(fhi, 32);
    w.write(flo, 32);

    let prev = values[0];
    for (let i = 1; i < n; i++) {
      const cur = values[i];
      const [xhi, xlo] = GorillaCodec.f64Xor(prev, cur);
      if (xhi === 0 && xlo === 0) {
        w.write(0, 1);
      } else {
        const L = GorillaCodec.leadingZeros64(xhi, xlo);
        const S = 64 - L;
        w.write(1, 1);
        w.write(L, 6);
        if (S <= 32) {
          w.write(xlo, S); // x < 2^S → значение в lo32
        } else {
          const hiBits = S - 32;
          w.write(xhi, hiBits); // xhi < 2^hiBits
          w.write(xlo, 32);
        }
      }
      prev = cur;
    }
    return w.finish();
  }

  decode(buf: Buffer, n: number): Float64Array {
    const out = new Float64Array(n);
    if (n === 0) return out;

    const r = new BitReader(buf);
    const fhi = r.read(32);
    const flo = r.read(32);
    out[0] = GorillaCodec.partsToF64(fhi, flo);

    let prev = out[0];
    for (let i = 1; i < n; i++) {
      const control = r.read(1);
      let xhi = 0, xlo = 0;
      if (control === 1) {
        const L = r.read(6);
        const S = 64 - L;
        if (S <= 32) {
          xlo = r.read(S);
        } else {
          xhi = r.read(S - 32);
          xlo = r.read(32);
        }
      }
      const [phi, plo] = GorillaCodec.f64ToParts(prev);
      const cur = GorillaCodec.partsToF64(phi ^ xhi, plo ^ xlo);
      out[i] = cur;
      prev = cur;
    }
    return out;
  }

  // --------------------------------------------------
  // double ⇆ 64-битное целое (без потери)
  // --------------------------------------------------

  private static f64ToParts(v: number): [number, number] {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(v, 0);
    return [buf.readUInt32LE(4), buf.readUInt32LE(0)];
  }

  private static partsToF64(hi: number, lo: number): number {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(hi >>> 0, 4);
    buf.writeUInt32LE(lo >>> 0, 0);
    return buf.readDoubleLE(0);
  }

  private static f64Xor(a: number, b: number): [number, number] {
    const [ahi, alo] = GorillaCodec.f64ToParts(a);
    const [bhi, blo] = GorillaCodec.f64ToParts(b);
    return [ahi ^ bhi, alo ^ blo];
  }

  /** Ведущие нули 64-битного числа (hi, lo): 0..64. */
  private static leadingZeros64(hi: number, lo: number): number {
    if (hi !== 0) {
      let c = 0;
      for (let i = 31; i >= 0; i--) {
        if ((hi >>> i) & 1) return c;
        c++;
      }
      return 32;
    }
    if (lo !== 0) {
      let c = 0;
      for (let i = 31; i >= 0; i--) {
        if ((lo >>> i) & 1) return 32 + c;
        c++;
      }
      return 64;
    }
    return 64;
  }
}
