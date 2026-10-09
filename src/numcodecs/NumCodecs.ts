// ============================================================
// numcodecs/NumCodecs.ts — Реестр числовых кодексов + авто-выбор
//
// Все кодексы — без потери точности (lossless): полный double /
// целое восстанавливается точно. Ценность кодексов — в плотности
// битов, которую потом «дожимает» сжатие (gzip/zstd).
//
//   f64          — 8 байт на значение (базовая линия)
//   doubleDelta  — вторые разности (время, счётчики: почти все нули)
//   gorilla      — XOR соседних double (осциллирующие метрики)
//   rle          — run-length для целых (коды, счётчики)
// ============================================================

import { F64Codec } from './F64Codec.ts';
import { DoubleDeltaCodec } from './DoubleDeltaCodec.ts';
import { GorillaCodec } from './GorillaCodec.ts';
import { RleCodec } from './RleCodec.ts';
import type { NumCodec } from './types.ts';

export class NumCodecs {
  /** Реестр: имя кодека → экземпляр. */
  static readonly registry: Record<string, NumCodec> = {
    f64: new F64Codec(),
    doubleDelta: new DoubleDeltaCodec(),
    gorilla: new GorillaCodec(),
    rle: new RleCodec()
  };

  /** Кодек по имени (RangeError на неизвестном). */
  static get(name: string): NumCodec {
    const c = this.registry[name];
    if (!c) throw new RangeError(`Неизвестный числовой кодек: ${name} (доступно: ${Object.keys(this.registry).join(', ')})`);
    return c;
  }

  /**
   * Выбирает числовой кодек по значениям. Всегда lossless:
   *  - целые с низкой кардинальностью → rle;
   *  - регулярные (тихие вторые разности) → doubleDelta;
   *  - осциллирующие float → gorilla;
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
    if (!allNum) return 'f64'; // не-числа обрабатывает v3 как dict/raw

    // rle — только для длинных «пробегов» (средняя длина run > 3):
    // низкая кардинальность без пробега (0,1,2,3,4,0,1,…) rle'ом хуже, чем gorilla.
    const rs = Math.min(n, 512);
    if (allInt && rs >= 4) {
      let runs = 1;
      for (let i = 1; i < rs; i++) if (values[i] !== values[i - 1]) runs++;
      if (runs / rs < 0.33) return 'rle';
    }

    // Тихие вторые разности (регулярный ряд) → doubleDelta
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
