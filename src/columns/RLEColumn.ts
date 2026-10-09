// ============================================================
// columns/RLEColumn.ts — Run-Length Encoding
// runs — [{value, count}], offsets — накопленные границы
// для O(log n) доступа к произвольной позиции
// ============================================================

import { Column } from './Column.ts';
import type { JsonValue, RLEColumnData, RLERun, SerializedColumn } from '../types.ts';

export class RLEColumn extends Column {
  runs: RLERun[] = [];
  offsets: number[] = [];

  append(value: JsonValue): void {
    const last = this.runs.length - 1;
    if (last >= 0 && this.runs[last].value === value) {
      this.runs[last].count++;
      this.offsets[last]++;
    } else {
      this.runs.push({ value, count: 1 });
      this.offsets.push(this._length + 1);
    }
    this._length++;
  }

  get(i: number): JsonValue {
    if (i < 0 || i >= this._length) {
      throw new RangeError(`Index ${i} out of bounds`);
    }
    // Бинарный поиск: первый offset, строго больше i
    let lo = 0;
    let hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid] > i) hi = mid;
      else lo = mid + 1;
    }
    return this.runs[lo].value;
  }

  serialize(): SerializedColumn {
    return { type: 'rle', runs: this.runs };
  }

  deserialize(data: SerializedColumn): void {
    const s = data as RLEColumnData;
    this.runs = s.runs;
    this.offsets = [];
    let total = 0;
    for (const r of this.runs) {
      total += r.count;
      this.offsets.push(total);
    }
    this._length = total;
  }
}
