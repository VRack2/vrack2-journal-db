// numcodecs/types.ts — Base interface for numeric codecs

/** Base interface for numeric codecs (Phase 2). */
export interface NumCodec {
  /** Codec name (for the v3 schema and auto-picking). */
  readonly name: string;
  /** Encode an array of numbers to bytes (no nulls — those go in the v3 mask). */
  encode(values: ArrayLike<number>): Buffer;
  /** Decode the first `n` values from the buffer. */
  decode(buf: Buffer, n: number): Float64Array | Int32Array;
}
