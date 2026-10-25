// compaction/Collapsing.ts — collapsing (CollapsingMergeTree).
//
// By the identity key desc.key, rows with a sign in column desc.sign cancel
// each other: sign > 0 — "add", sign < 0 — "revert". Within a key (by
// ascending version, or by write order) each unit of negative sign cancels
// the oldest not-yet-reverted positive unit (FIFO).
// What remains: un-reverted adds and un-reverted reverts (delete without insert).
//
// Typical case: outbox/CDC — "insert, then delete":
//   new Collapsing({ key:['id'], sign:'sign', version:'ts' })
//   append { id:1, sign:+1, ts:1 }   // insert
//   append { id:1, sign:-1, ts:2 }   // delete  → reverts the insert
//   compact() → empty (row id=1 was reverted)

import type { Row } from './types.ts';
import type { Descriptor } from './Descriptor.ts';
import { Engine } from './Engine.ts';
import ErrorManager from '../errors/ErrorManager.ts';

ErrorManager.registerMany('Collapsing', [
  { short: 'DEF_COLLAPSING_SIGN', description: 'collapsing: sign is required (the +1/-1 sign column)' },
]);

export class Collapsing extends Engine {
  constructor(desc: Descriptor) {
    super('collapsing', desc);
  }

  merge(rows: Row[]): Row[] {
    const sign = this.desc.sign;
    if (!sign) {
      throw ErrorManager.make('DEF_COLLAPSING_SIGN');
    }
    const out: Row[] = [];
    for (const group of this.groupByKey(rows).values()) {
      const ordered = this.desc.version
        ? [...group].sort((a, b) => this.versionOf(a) - this.versionOf(b))
        : group;

      const live: Row[] = [];      // not-yet-reverted "adds"
      const keptNeg: Row[] = [];   // "reverts" with no matching add
      let head = 0;                // first not-yet-reverted position in live
      for (const row of ordered) {
        const s = this.num(row, sign);
        if (s > 0) {
          for (let i = 0; i < Math.round(s); i++) live.push(row);
        } else if (s < 0) {
          let need = Math.round(-s);
          while (need > 0 && head < live.length) {
            head++;
            need--;
          }
          if (need > 0) keptNeg.push(row);
        }
      }
      out.push(...keptNeg, ...live.slice(head));
    }
    return out;
  }
}
