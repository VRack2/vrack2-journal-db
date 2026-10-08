// ============================================================
// engines/upsert.ts — upsert (ReplacingMergeTree)
//
// По identity-ключу `key` оставляет строку с max(version); при равенстве
// version побеждает более поздняя по порядку записи. Результат сортируется
// по version (хронологически), чтобы compact не перемешивал порядок.
//
// Типичный случай: состояние-метрика, где по (host, metric) важна последняя
// версия:
//   upsert({ key:['host','metric'], version:'ts' })
//   append { host:'web-1', metric:'cpu', ts:10, value:42 }
//   append { host:'web-1', metric:'cpu', ts:20, value:55 }  // ← эта побеждает
//   compact() → одна строка { host:'web-1', metric:'cpu', ts:20, value:55 }
// ============================================================

import type { Engine, EngineDescriptor } from './types.ts';
import { asNum, keyTuple } from './util.ts';

export const upsertEngine: Engine = {
  kind: 'upsert',
  merge(rows, desc: EngineDescriptor) {
    const key = desc.key ?? [];
    const version = desc.version;
    if (!version) {
      throw new RangeError('upsert: требуется version (колонка «новизны»)');
    }
    const best = new Map<string, { row: typeof rows[number]; v: number; order: number }>();
    rows.forEach((row, order) => {
      const k = keyTuple(key, row);
      const v = asNum(row[version]);
      const cur = best.get(k);
      // max(version); при равенстве — более поздний порядок записи
      if (cur === undefined || v > cur.v || (v === cur.v && order > cur.order)) {
        best.set(k, { row, v, order });
      }
    });
    return [...best.values()].sort((a, b) => a.v - b.v).map(e => e.row);
  },
};
