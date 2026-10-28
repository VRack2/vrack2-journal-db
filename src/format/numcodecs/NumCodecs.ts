// numcodecs/NumCodecs.ts — Numeric codec registry + auto-picking.
//
// All codecs are lossless: a full double / integer is restored exactly.
// Their value is in bit density, which compression (gzip/zstd) then squeezes.
//
//   f64          — 8 bytes per value (baseline)
//   doubleDelta  — second differences (time, counters: mostly zeros)
//   gorilla      — XOR of adjacent doubles (oscillating metrics)
//   rle          — run-length for integers (codes, counters)

import { F64Codec } from './F64Codec.ts';
import { DoubleDeltaCodec } from './DoubleDeltaCodec.ts';
import { GorillaCodec } from './GorillaCodec.ts';
import { RleCodec } from './RleCodec.ts';
import type { NumCodec } from './types.ts';
import ErrorManager from '../../errors/ErrorManager.ts';

ErrorManager.registerMany('NumCodecs', [
  { short: 'NC_CODEC_UNKNOWN', description: 'Unknown numeric codec', rules: { name: 'string' } },
]);

export class NumCodecs {
  /** Registry: codec name → instance. */
  static readonly registry: Record<string, NumCodec> = {
    f64: new F64Codec(),
    doubleDelta: new DoubleDeltaCodec(),
    gorilla: new GorillaCodec(),
    rle: new RleCodec()
  };

  /** Codec by name (NC_CODEC_UNKNOWN when unknown). */
  static get(name: string): NumCodec {
    const c = this.registry[name];
    if (!c) throw ErrorManager.make('NC_CODEC_UNKNOWN', { name, available: Object.keys(this.registry).join(', ') });
    return c;
  }

  /**
   * Pick a numeric codec by the values. Always lossless:
   *  - integers with low cardinality → rle;
   *  - regular (quiet second differences) → doubleDelta;
   *  - oscillating floats → gorilla;
   *  - fallback → f64.
   */
  static autoPick(values: ArrayLike<number>): string {
    const n = values.length;
    if (n === 0) return 'f64';

    let allNum = true;
    let allInt = true;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) { allNum = false; break; }
      if (!Number.isInteger(v)) allInt = false;
    }
    if (!allNum) return 'f64'; // non-numbers are handled by v3 as dict/raw

    // rle — only for long "runs" (average run length > 3):
    // low cardinality without runs (0,1,2,3,4,0,1,…) is worse with rle than gorilla.
    const rs = Math.min(n, 512);
    if (allInt && rs >= 4) {
      let runs = 1;
      for (let i = 1; i < rs; i++) if (values[i] !== values[i - 1]) runs++;
      if (runs / rs < 0.33) return 'rle';
    }

    // Quiet second differences (regular series) → doubleDelta
    const s = Math.min(n, 512);
    if (s >= 3) {
      let quiet = 0;
      for (let i = 2; i < s; i++) {
        const d2 = (values[i] - values[i - 1]) - (values[i - 1] - values[i - 2]);
        if (d2 === 0) quiet++;
      }
      if (quiet / (s - 2) > 0.5) return 'doubleDelta';
    }

    return 'gorilla';
  }
}
