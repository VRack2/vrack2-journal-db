// engineFactory.ts — kind → engine class; the single dispatch point by kind.

import type { Descriptor } from '../compaction/Descriptor.ts';
import { Log } from '../compaction/Log.ts';
import { Upsert } from '../compaction/Upsert.ts';
import { Summing } from '../compaction/Summing.ts';
import { Collapsing } from '../compaction/Collapsing.ts';
import type { Engine } from '../compaction/Engine.ts';

export function makeEngine(desc: Descriptor): Engine {
  switch (desc.kind) {
    case 'log': return new Log(desc);
    case 'upsert': return new Upsert(desc);
    case 'summing': return new Summing(desc);
    case 'collapsing': return new Collapsing(desc);
  }
}
