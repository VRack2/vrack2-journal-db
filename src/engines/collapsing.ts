// ============================================================
// engines/collapsing.ts — collapsing (CollapsingMergeTree)
//
// По identity-ключу `key` строки с знаком в колонке `sign` гасят друг друга:
// sign > 0 — «добавление», sign < 0 — «отмена». В пределах ключа (по возрастанию
// version, или по порядку записи) каждая единица отрицательного знака гасит
// самую старую неотменённую единицу положительного (FIFO). Остаются
// неотменённые добавления и неотменённые отмены (delete без insert).
//
// Типичный случай: outbox/CDC — «insert, потом delete»:
//   collapsing({ key:['id'], sign:'sign', version:'ts' })
//   append { id:1, sign:+1, ts:1 }   // insert
//   append { id:1, sign:-1, ts:2 }   // delete  → гасит insert
//   compact() → пусто (строка id=1 отменена)
// ============================================================

import type { Engine, EngineDescriptor } from './types.ts';
import { asNum, keyTuple } from './util.ts';

export const collapsingEngine: Engine = {
  kind: 'collapsing',
  merge(rows, desc: EngineDescriptor) {
    const key = desc.key ?? [];
    const sign = desc.sign;
    if (!sign) {
      throw new RangeError('collapsing: требуется sign (колонка знака +1/-1)');
    }
    const version = desc.version;

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const k = keyTuple(key, row);
      const arr = groups.get(k);
      if (arr) arr.push(row);
      else groups.set(k, [row]);
    }

    const out: typeof rows = [];
    for (const group of groups.values()) {
      const ordered = version
        ? [...group].sort((a, b) => asNum(a[version]) - asNum(b[version]))
        : group;

      const live: typeof rows = [];   // неотменённые «добавления»
      const keptNeg: typeof rows = []; // «отмены» без соответствующего добавления
      for (const row of ordered) {
        const s = asNum(row[sign]);
        if (s > 0) {
          for (let i = 0; i < Math.round(s); i++) live.push(row);
        } else if (s < 0) {
          let need = Math.round(-s);
          while (need > 0 && live.length > 0) {
            live.shift();
            need--;
          }
          if (need > 0) keptNeg.push(row);
        }
      }
      out.push(...keptNeg, ...live);
    }
    return out;
  },
};
