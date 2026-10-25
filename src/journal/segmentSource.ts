// segmentSource.ts — the minimal segment surface the read paths work on.
// Implemented by JournalReader; kept in a shared file so scan/execute.ts and
// aggregator.ts can depend on it without importing JournalReader (no cycle).

import type { Segment } from '../Segment.ts';
import type { SegmentMeta } from './SegmentMeta.ts';

export interface SegmentSource {
  readonly activeSegment: Segment | null;
  /** Closed segment ids in chronological order. */
  sortedClosedIds(): string[];
  /** .meta sidecar of a closed segment — undefined if unknown. */
  metaOf(id: string): SegmentMeta | undefined;
  /** Closed segment from the LRU cache or disk. */
  loadClosed(id: string): Segment;
}