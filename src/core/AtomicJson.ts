// ============================================================
// AtomicJson — durable JSON file I/O (tmp + rename).
// Shared by the Store manifest, rollup checkpoints and segment
// .meta sidecars so the write protocol lives in one place.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

export interface AtomicJsonWriteOptions {
  /** Create parent directories (default false). */
  mkdir?: boolean;
  /** Suffix tmp with the pid so concurrent processes never collide (default false). */
  uniqueTmp?: boolean;
  /** Pretty-print with 2-space indent (default false — compact). */
  pretty?: boolean;
}

export class AtomicJson {
  /** Read a JSON file; null when missing, unreadable, corrupt or non-object. */
  static read(filePath: string): Record<string, unknown> | null {
    try {
      const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
    } catch {
      /* missing or corrupt — caller decides the fallback */
    }
    return null;
  }

  /** Write JSON atomically: tmp file, then rename over the target. */
  static write(filePath: string, value: unknown, opts: AtomicJsonWriteOptions = {}): void {
    if (opts.mkdir) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = opts.uniqueTmp ? `${filePath}.tmp.${process.pid}` : `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, opts.pretty ? 2 : 0));
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
      throw e;
    }
  }
}
