// ============================================================
// numcodecs.ts — Числовые кодексы (Фаза 2, «путь движков»)
//
// Интерфейс:
//   encode(values: ArrayLike<number>): Buffer
//   decode(buf: Buffer, n: number): Float64Array | Int32Array
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

/** Базовый интерфейс числового кодека (см. план, Фаза 2). */
export interface NumCodec {
  /** Имя кодека (для схемы v3 и авто-выбора). */
  readonly name: string;
  /** Кодит массив чисел в байты (без null — их хранит маска в v3). */
  encode(values: ArrayLike<number>): Buffer;
  /** Раскодирует первые `n` значений из буфера. */
  decode(buf: Buffer, n: number): Float64Array | Int32Array;
}

// --------------------------------------------------
// BitWriter / BitReader — битовые операции MSB-first
// --------------------------------------------------

class BitWriter {
  private bytes: number[] = [0];
  private bitPos = 0; // занятые биты в текущем (последнем) байте, 0..7

  /** Записать `n` младших бит значения (MSB-first). n должно быть 1..32. */
  write(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      if (bit) {
        this.bytes[this.bytes.length - 1] |= 1 << (7 - this.bitPos);
      }
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bytes.push(0);
        this.bitPos = 0;
      }
    }
  }

  finish(): Buffer {
    // Последний байт может быть частично не заполнен (низшие биты = 0) —
    // это корректное выравнивание, оставляем как есть.
    return Buffer.from(this.bytes);
  }
}

class BitReader {
  private bytePos = 0;
  private bitPos = 0; // смещение бита в текущем байте
  private buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Прочитать `n` бит (MSB-first) → число (n: 1..32). */
  read(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const bit = (this.buf[this.bytePos] >> (7 - this.bitPos)) & 1;
      value = (value << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bytePos++;
        this.bitPos = 0;
      }
    }
    return value;
  }
}

// --------------------------------------------------
// double ⇆ 64-битное целое (без потери)
// --------------------------------------------------

function f64ToParts(v: number): [number, number] {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(v, 0);
  return [buf.readUInt32LE(4), buf.readUInt32LE(0)];
}

function partsToF64(hi: number, lo: number): number {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(hi >>> 0, 4);
  buf.writeUInt32LE(lo >>> 0, 0);
  return buf.readDoubleLE(0);
}

function f64Xor(a: number, b: number): [number, number] {
  const [ahi, alo] = f64ToParts(a);
  const [bhi, blo] = f64ToParts(b);
  return [ahi ^ bhi, alo ^ blo];
}

/** Ведущие нули 64-битного числа (hi, lo): 0..64. */
function leadingZeros64(hi: number, lo: number): number {
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

// --------------------------------------------------
// f64 — базовая линия, 8 байт на значение
// --------------------------------------------------
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

// --------------------------------------------------
// doubleDelta — вторые разности (lossless, f64)
// v0, v1 как есть; далее d2[i] = (v[i]-v[i-1]) - (v[i-1]-v[i-2])
// ==================================================
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

// --------------------------------------------------
// gorilla — XOR соседних double (lossless, битовый)
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
// ==================================================
export class GorillaCodec implements NumCodec {
  readonly name = 'gorilla';

  encode(values: ArrayLike<number>): Buffer {
    const n = values.length;
    if (n === 0) return Buffer.alloc(0);

    const w = new BitWriter();
    const [fhi, flo] = f64ToParts(values[0]);
    w.write(fhi, 32);
    w.write(flo, 32);

    let prev = values[0];
    for (let i = 1; i < n; i++) {
      const cur = values[i];
      const [xhi, xlo] = f64Xor(prev, cur);
      if (xhi === 0 && xlo === 0) {
        w.write(0, 1);
      } else {
        const L = leadingZeros64(xhi, xlo);
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
    out[0] = partsToF64(fhi, flo);

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
      const [phi, plo] = f64ToParts(prev);
      const cur = partsToF64(phi ^ xhi, plo ^ xlo);
      out[i] = cur;
      prev = cur;
    }
    return out;
  }
}

// --------------------------------------------------
// rle — run-length для целых (lossless, i64 + u32)
// [runsCount u32] [value i64][count u32] ...
// ==================================================
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

// --------------------------------------------------
// Реестр кодексов
// --------------------------------------------------
export const NUM_CODECS: Record<string, NumCodec> = {
  f64: new F64Codec(),
  doubleDelta: new DoubleDeltaCodec(),
  gorilla: new GorillaCodec(),
  rle: new RleCodec()
};

export function getNumCodec(name: string): NumCodec {
  const c = NUM_CODECS[name];
  if (!c) throw new RangeError(`Неизвестный числовой кодек: ${name} (доступно: ${Object.keys(NUM_CODECS).join(', ')})`);
  return c;
}

// --------------------------------------------------
// Авто-выбор кодека по значениям (lossless-safe)
// --------------------------------------------------

/**
 * Выбирает числовой кодек по значениям. Всегда lossless:
 *  - целые с низкой кардинальностью → rle;
 *  - регулярные (тихие вторые разности) → doubleDelta;
 *  - осциллирующие float → gorilla;
 *  - fallback → f64.
 */
export function autoPickNumCodec(values: ArrayLike<number>): string {
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
