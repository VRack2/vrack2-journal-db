// ============================================================
// engines/summing.ts — summing (SummingMergeTree)
//
// По identity-ключу `key` суммирует числовые колонки из `sum` (не-числа
// игнорируются, как 0). Остальные поля (ключ и описательные) берутся из
// строки с max(version) группы (последняя версия); если version не задан —
// из последней строки по порядку.
//
// Типичный случай: счётчики/показания, которые нужно просуммировать по
// (host, metric) за период:
//   summing({ key:['host','metric'], sum:['value'] })
//   append { host:'web-1', metric:'req', ts:1, value:100 }
//   append { host:'web-1', metric:'req', ts:2, value:200 }
//   compact() → { host:'web-1', metric:'req', ts:2, value:300 }
// ============================================================

import type { Engine, EngineDescriptor } from './types.ts';
import { baseIndex, keyTuple } from './util.ts';

export const summingEngine: Engine = {
  kind: 'summing',
  merge(rows, desc: EngineDescriptor) {
    const key = desc.key ?? [];
    const sumCols = desc.sum ?? [];
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
      const base = group[baseIndex(group, version)];
      const res: typeof rows[number] = { ...base };
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
  },
};
