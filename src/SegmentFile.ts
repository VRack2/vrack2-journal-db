// ============================================================
// SegmentFile.ts — Файл сегмента (любой формат): чтение и распознавание
//
// Мульти-версионный reader: v1 (чистый JSON) / v2 (gzip+JSON) /
// v3 (бинарные блобы колонок) → единый в-памяти сегмент.
// ============================================================

import { Segment } from './Segment.ts';
import { SegmentFileV2 } from './SegmentFileV2.ts';
import { SegmentFileV3 } from './SegmentFileV3.ts';

export class SegmentFile {
  /** Буфер (v1/v2/v3) → в-памяти сегмент. */
  static read(buf: Buffer): Segment {
    if (SegmentFileV3.isV3(buf)) return SegmentFileV3.decode(buf);
    return Segment.deserialize(SegmentFileV2.decode(buf));
  }

  /** Является ли буфер файлом сегмента v2/v3 (по магическим байтам "JSDB"). */
  static isWrapped(buf: Buffer): boolean {
    return buf.length >= SegmentFileV2.MAGIC.length
      && buf.subarray(0, SegmentFileV2.MAGIC.length).equals(SegmentFileV2.MAGIC);
  }
}
