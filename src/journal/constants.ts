// constants.ts — on-disk file naming and defaults for a journal.

/** Single-owner lock file name. */
export const LOCK_FILE = '.lock';
/** WAL file name (batched appends, replayed after a crash). */
export const WAL_FILE = 'wal.log';
/** Suffix of the per-segment .meta sidecar. */
export const META_SUFFIX = '.meta';
/** Extension of v3 segment files. */
export const SEG_V3_EXT = '.seg';
/** Extension of v1–v2 segment files. */
export const SEG_V2_EXT = '.json';

/** True for closed-segment file names (`.seg` v3 / `.json` v1–v2). */
export const isSegmentFile = (f: string): boolean => f.endsWith(SEG_V3_EXT) || f.endsWith(SEG_V2_EXT);
/** Segment id from its file name (extension stripped). */
export const idFromFile = (f: string): string =>
  f.endsWith(SEG_V3_EXT) ? f.slice(0, -SEG_V3_EXT.length) :
  f.endsWith(SEG_V2_EXT) ? f.slice(0, -SEG_V2_EXT.length) : f;

/** Default rows per segment before flush. Deliberately large: fewer files/unlinks on SSD. */
export const DEFAULT_ROWS_PER_SEGMENT = 10_000;
/** Default WAL batch (rows buffered in memory before a disk append). */
export const DEFAULT_WAL_BATCH_ROWS = 512;
/** WAL buffer byte threshold that forces a drain. */
export const WAL_FLUSH_BYTES = 1_000_000;
/** Default number of closed segments that arms auto-compaction. */
export const DEFAULT_COMPACT_MIN_SEGMENTS = 4;
