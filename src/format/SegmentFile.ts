// SegmentFile.ts — Segment file: reading and detection.
// The only on-disk format is the binary column-blob container (JSDB v4);
// older generations (v1/v2 JSON, legacy v3) are not readable — see PLAN
// ground rule "no backward compatibility".

import { Segment } from './Segment.ts';
import { SegmentFileV3 } from './SegmentFileV3.ts';

export class SegmentFile {
  /** Buffer (JSDB v4 container) → in-memory segment. */
  static read(buf: Buffer): Segment {
    return SegmentFileV3.decode(buf);
  }

  /** Whether the buffer is a JSDB segment file (by the "JSDB" magic bytes). */
  static isWrapped(buf: Buffer): boolean {
    return SegmentFileV3.hasMagic(buf);
  }
}
