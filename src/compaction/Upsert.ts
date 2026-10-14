// compaction/Upsert.ts — upsert (ReplacingMergeTree).
//
// By the identity key desc.key keeps the row with max(version); on ties the
// later write order wins. The result is sorted by version (chronologically)
// so compact doesn't shuffle the order.
//
// Typical case: a stateful metric where the latest version matters per (host, metric):
//   new Upsert({ key:['host','metric'], version:'ts' })
//   append { host:'web-1', metric:'cpu', ts:10, value:42 }
//   append { host:'web-1', metric:'cpu', ts:20, value:55 }  // ← this one wins
//   compact() → one row { host:'web-1', metric:'cpu', ts:20, value:55 }

import type { Row } from './types.ts';
import type { Descriptor } from './Descriptor.ts';
import { Engine } from './Engine.ts';
import ErrorManager from '../errors/ErrorManager.ts';

ErrorManager.registerMany('Upsert', [
  { short: 'DEF_UPSERT_VERSION', description: 'upsert: version is required (the "newness" column)' },
]);

export class Upsert extends Engine {
  constructor(desc: Descriptor) {
    super('upsert', desc);
  }

  merge(rows: Row[]): Row[] {
    if (!this.desc.version) {
      throw ErrorManager.make('DEF_UPSERT_VERSION');
    }
    const best = new Map<string, { row: Row; v: number; order: number }>();
    rows.forEach((row, order) => {
      const k = this.keyOf(row);
      const v = this.versionOf(row);
      const cur = best.get(k);
      // max(version); on ties — the later write order
      if (cur === undefined || v > cur.v || (v === cur.v && order > cur.order)) {
        best.set(k, { row, v, order });
      }
    });
    return [...best.values()].sort((a, b) => a.v - b.v).map(e => e.row);
  }
}
