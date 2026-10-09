// ============================================================
// numcodecs/BitReader.ts — Битовое чтение MSB-first (internal)
// ============================================================

export class BitReader {
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
