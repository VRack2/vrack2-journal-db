// SegmentFile.ts — Segment file (any format): reading and detection.
// Multi-version reader: v1 (plain JSON) / v2 (gzip+JSON) /
// v3 (binary column blobs) → a single in-memory segment.

import { Segment } from './Segment.ts';
import { SegmentFileV2 } from './SegmentFileV2.ts';
import { SegmentFileV3 } from './SegmentFileV3.ts';

export class SegmentFile {
  /** Buffer (v1/v2/v3) → in-memory segment. */
  static read(buf: Buffer): Segment {
    if (SegmentFileV3.isV3(buf)) return SegmentFileV3.decode(buf);
    return Segment.deserialize(SegmentFileV2.decode(buf));
  }

  /** Whether the buffer is a v2/v3 segment file (by the "JSDB" magic bytes). */
  static isWrapped(buf: Buffer): boolean {
    return buf.length >= SegmentFileV2.MAGIC.length
      && buf.subarray(0, SegmentFileV2.MAGIC.length).equals(SegmentFileV2.MAGIC);
  }
}
