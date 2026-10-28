// SegmentEncoder.ts — encodes segments with the journal's on-disk format:
// the JSDB binary container (column blobs with numeric codecs, gzip/zstd
// compression, CRC32). Owns the compression/codecs config so SegmentStore,
// RetentionEngine and the journal never reach into the Journal for it.

import { SegmentFileV3 } from '../format/SegmentFileV3.ts';
import type { Segment } from '../format/Segment.ts';
import type { CompressionMode } from '../core/types.ts';
import { SEG_V3_EXT } from './constants.ts';

export class SegmentEncoder {
  readonly compression: CompressionMode;
  readonly codecs: Record<string, string>;

  constructor(compression: CompressionMode, codecs: Record<string, string>) {
    this.compression = compression;
    this.codecs = codecs;
  }

  /** Encode a segment with this encoder's compression/codecs. */
  encode(seg: Segment): Buffer {
    return SegmentFileV3.encode(seg, { compression: this.compression, codecs: this.codecs });
  }

  /** Segment file extension for writes. */
  ext(): string {
    return SEG_V3_EXT;
  }
}
