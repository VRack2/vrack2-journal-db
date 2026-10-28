// numcodecs/BitWriter.ts — Bit writing, MSB-first (internal)

export class BitWriter {
  private bytes: number[] = [0];
  private bitPos = 0; // bits occupied in the current (last) byte, 0..7

  /** Write the lower `n` bits of a value (MSB-first). n must be 1..32. */
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
    // The last byte may be partially unfilled (low bits = 0) —
    // correct alignment, left as-is.
    return Buffer.from(this.bytes);
  }
}
