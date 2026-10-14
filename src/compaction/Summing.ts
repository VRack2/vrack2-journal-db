// compaction/Summing.ts — summing (SummingMergeTree).
//
// By the identity key desc.key sums the numeric columns from desc.sum
// (non-numbers are ignored, as 0). The remaining fields (key and descriptive)
// come from the row with max(version) in the group; if version is unset — from the last one by order.
//
// Typical case: counters/readings to be summed over a period
// for (host, metric):
//   new Summing({ key:['host','metric'], sum:['value'] })
//   append { host:'web-1', metric:'req', ts:1, value:100 }
//   append { host:'web-1', metric:'req', ts:2, value:200 }
//   compact() → { host:'web-1', metric:'req', ts:2, value:300 }

import type { Row } from './types.ts';
import type { Descriptor } from './Descriptor.ts';
import { Engine } from './Engine.ts';

export class Summing extends Engine {
  constructor(desc: Descriptor) {
    super('summing', desc);
  }

  merge(rows: Row[]): Row[] {
    const sumCols = this.desc.sum ?? [];
    const out: Row[] = [];
    for (const group of this.groupByKey(rows).values()) {
      const base = this.baseRow(group);
      if (!base) continue;
      const res: Row = { ...base };
      for (const col of sumCols) {
        let s = 0;
        let any = false;
        for (const row of group) {
          const v = row[col];
          if (typeof v === 'number' && Number.isFinite(v)) {
            s += v;
            any = true;
          }
        }
        if (any) res[col] = s;
      }
      out.push(res);
    }
    return out;
  }
}
