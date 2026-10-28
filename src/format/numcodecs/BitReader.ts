// numcodecs/BitReader.ts — Bit reading, MSB-first (internal)

export class BitReader {
  private bytePos = 0;
  private bitPos = 0; // bit offset within the current byte
  private buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Read `n` bits (MSB-first) → number (n: 1..32). */
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
