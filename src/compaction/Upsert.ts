// ============================================================
// compaction/Upsert.ts — upsert (ReplacingMergeTree)
//
// По identity-ключу desc.key оставляет строку с max(version); при равенстве
// version побеждает более поздняя по порядку записи. Результат сортируется по
// version (хронологически), чтобы compact не перемешивал порядок.
//
// Типичный случай: состояние-метрика, где по (host, metric) важна последняя
// версия:
//   new Upsert({ key:['host','metric'], version:'ts' })
//   append { host:'web-1', metric:'cpu', ts:10, value:42 }
//   append { host:'web-1', metric:'cpu', ts:20, value:55 }  // ← эта побеждает
//   compact() → одна строка { host:'web-1', metric:'cpu', ts:20, value:55 }
// ============================================================

import type { Row } from './types.ts';
import type { Descriptor } from './Descriptor.ts';
import { Engine } from './Engine.ts';

export class Upsert extends Engine {
  constructor(desc: Descriptor) {
    super('upsert', desc);
  }

  merge(rows: Row[]): Row[] {
    if (!this.desc.version) {
      throw new RangeError('upsert: требуется version (колонка «новизны»)');
    }
    const best = new Map<string, { row: Row; v: number; order: number }>();
    rows.forEach((row, order) => {
      const k = this.keyOf(row);
      const v = this.versionOf(row);
      const cur = best.get(k);
      // max(version); при равенстве — более поздний порядок записи
      if (cur === undefined || v > cur.v || (v === cur.v && order > cur.order)) {
        best.set(k, { row, v, order });
      }
    });
    return [...best.values()].sort((a, b) => a.v - b.v).map(e => e.row);
  }
}
