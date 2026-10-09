// ============================================================
// numcodecs/BitWriter.ts — Битовые записи MSB-first (internal)
// ============================================================

export class BitWriter {
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
