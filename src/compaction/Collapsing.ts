// ============================================================
// compaction/Collapsing.ts — collapsing (CollapsingMergeTree)
//
// По identity-ключу desc.key строки с знаком в колонке desc.sign гасят друг
// друга: sign > 0 — «добавление», sign < 0 — «отмена». В пределах ключа (по
// возрастанию version, или по порядку записи) каждая единица отрицательного
// знака гасит самую старую неотменённую единицу положительного (FIFO).
// Остаются неотменённые добавления и неотменённые отмены (delete без insert).
//
// Типичный случай: outbox/CDC — «insert, потом delete»:
//   new Collapsing({ key:['id'], sign:'sign', version:'ts' })
//   append { id:1, sign:+1, ts:1 }   // insert
//   append { id:1, sign:-1, ts:2 }   // delete  → гасит insert
//   compact() → пусто (строка id=1 отменена)
// ============================================================

import type { Row } from './types.ts';
import type { Descriptor } from './Descriptor.ts';
import { Engine } from './Engine.ts';

export class Collapsing extends Engine {
  constructor(desc: Descriptor) {
    super('collapsing', desc);
  }

  merge(rows: Row[]): Row[] {
    const sign = this.desc.sign;
    if (!sign) {
      throw new RangeError('collapsing: требуется sign (колонка знака +1/-1)');
    }
    const out: Row[] = [];
    for (const group of this.groupByKey(rows).values()) {
      const ordered = this.desc.version
        ? [...group].sort((a, b) => this.versionOf(a) - this.versionOf(b))
        : group;

      const live: Row[] = [];      // неотменённые «добавления»
      const keptNeg: Row[] = [];   // «отмены» без соответствующего добавления
      for (const row of ordered) {
        const s = this.num(row, sign);
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
  }
}
