// compaction/Log.ts — log (MergeTree).
//
// Merge without changing rows: just combines segments (default). Row order
// is preserved (chronological). This is the pre-engines compact() behavior —
// compatible with old journals.

import type { Row } from './types.ts';
import type { Descriptor } from './Descriptor.ts';
import { Engine } from './Engine.ts';

export class Log extends Engine {
  constructor(desc: Descriptor) {
    super('log', desc);
  }

  merge(rows: Row[]): Row[] {
    return rows;
  }
}
