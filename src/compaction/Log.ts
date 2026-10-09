// ============================================================
// compaction/Log.ts — log (MergeTree)
//
// Слияние без изменения строк: просто объединяет сегменты (дефолт). Порядок
// строк сохраняется (хронологический). Это поведение compact() до появления
// движков — совместимо со старыми журналами.
// ============================================================

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
