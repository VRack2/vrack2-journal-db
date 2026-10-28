// segmentFormat.ts — sniff the on-disk format of a segment file from its magic.

import fs from 'node:fs';

type DetectedFormat = 'v1' | 'v2' | 'v3';

/** Detect the format of a segment file by reading its 5-byte magic header. */
export function detectSegmentFormat(filePath: string): DetectedFormat {
  let buf: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      buf = Buffer.alloc(5);
      if (fs.readSync(fd, buf, 0, 5, 0) < 5) return 'v1';
    } finally { fs.closeSync(fd); }
  } catch { return 'v1'; }
  if (buf.subarray(0, 4).toString('ascii') === 'JSDB') return buf[4] === 3 ? 'v3' : 'v2';
  return 'v1';
}
