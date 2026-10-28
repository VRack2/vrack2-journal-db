// Compression.ts — Blob compression (gzip/zstd, lossless).
// zstd is the default when present in zlib (Node ≥ 23.8), otherwise gzip.
// An explicit choice always overrides the default.

import zlib from 'node:zlib';
import type { CompressionKind } from './types.ts';

export class Compression {
  /** Whether zstd is present in zlib (Node >= 23.8). */
  static zstdAvailable(): boolean {
    const z = zlib as unknown as { zstdCompressSync?: unknown };
    return typeof z.zstdCompressSync === 'function';
  }

  /** Default compression: zstd if available, else gzip. */
  static default(): 'gzip' | 'zstd' {
    if (this.zstdAvailable()) return 'zstd';
    return 'gzip';
  }

  /** Compress a buffer with the selected method ('none' — as-is). */
  static compress(buf: Buffer, mode: CompressionKind): Buffer {
    if (mode === 'none') return buf;
    if (mode === 'zstd') {
      const z = zlib as unknown as { zstdCompressSync?: (b: Buffer, o?: unknown) => Buffer };
      if (typeof z.zstdCompressSync === 'function') {
        return z.zstdCompressSync(buf, { level: 3 });
      }
    }
    return zlib.gzipSync(buf, { level: 6 });
  }

  /** Decompress a buffer with the selected method ('none' — as-is). */
  static decompress(buf: Buffer, mode: CompressionKind): Buffer {
    if (mode === 'none') return buf;
    if (mode === 'zstd') {
      const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
      if (typeof z.zstdDecompressSync === 'function') {
        return z.zstdDecompressSync(buf);
      }
    }
    return zlib.gunzipSync(buf);
  }
}
