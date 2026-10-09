// ============================================================
// Compression.ts — Сжатие блобов (gzip/zstd, без потерь)
//
// zstd по умолчанию при Node ≥ 23.8 (где он есть в zlib),
// иначе gzip. Явный выбор всегда переопределяет дефолт.
// ============================================================

import zlib from 'node:zlib';
import type { CompressionKind } from './types.ts';

export class Compression {
  /** Есть ли zstd в zlib (Node >= 23.8). */
  static zstdAvailable(): boolean {
    const z = zlib as unknown as { zstdCompressSync?: unknown };
    return typeof z.zstdCompressSync === 'function';
  }

  /** Дефолт сжатия: zstd при Node >= 23.8 (где он есть в zlib), иначе gzip. */
  static default(): 'gzip' | 'zstd' {
    if (this.zstdAvailable()) return 'zstd';
    return 'gzip';
  }

  /** Сжимает буфер выбранным способом ('none' — как есть). */
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

  /** Разжимает буфер выбранным способом ('none' — как есть). */
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
