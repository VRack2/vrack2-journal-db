// numcodecs/GorillaCodec.ts — XOR of adjacent doubles (lossless, bit-level).
//
// Scheme (self-consistent, lossless):
//   first value — 64 bits as-is (hi32, lo32);
//   then x = prev XOR cur (64 bits):
//     x == 0        → 1 bit (0);
//     x != 0        → 1(1) + 6 bits L (leading zeros, 0..63)
//                     + (64-L) bits of the significant part:
//                       S = 64-L <= 32 → S bits of lo32;
//                       S >  32        → (S-32) bits of hi32, then 32 bits of lo32.
//   Slowly changing floats (CPU/RAM) → small x → few bits.

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
           w.write(xlo, S); // x < 2^S → value in lo32
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
  // double ⇆ 64-bit integer (lossless)
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

  /** Leading zeros of a 64-bit number (hi, lo): 0..64. */
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
