// SegmentEncoder.ts — encodes segments with the journal's on-disk format:
// v2 (JSON) or v3 (JSDB binary with optional gzip/zstd and numeric codecs).
// Owns the format/compression/codecs config so SegmentStore, RetentionEngine
// and the v3 migration never reach into the Journal for it.

import { SegmentFileV2 } from '../SegmentFileV2.ts';
import { SegmentFileV3 } from '../SegmentFileV3.ts';
import type { Segment } from '../Segment.ts';
import type { CompressionMode, SegmentFormat } from '../types.ts';
import { SEG_V2_EXT, SEG_V3_EXT } from './constants.ts';

export class SegmentEncoder {
  readonly format: SegmentFormat;
  readonly compression: CompressionMode;
  readonly codecs: Record<string, string>;

  constructor(format: SegmentFormat, compression: CompressionMode, codecs: Record<string, string>) {
    this.format = format;
    this.compression = compression;
    this.codecs = codecs;
  }

  /** Encode a segment with this encoder's format/compression/codecs. */
  encode(seg: Segment): Buffer {
    return this.format === 'v3'
      ? SegmentFileV3.encode(seg, { compression: this.compression, codecs: this.codecs })
      : SegmentFileV2.encode(seg.serialize());
  }

  /** Segment file extension for writes. */
  ext(): string {
    return this.format === 'v3' ? SEG_V3_EXT : SEG_V2_EXT;
  }
}
