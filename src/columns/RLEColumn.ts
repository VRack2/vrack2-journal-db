// columns/RLEColumn.ts — Run-Length Encoding.
// runs — [{value, count}], offsets — cumulative bounds
// for O(log n) access to an arbitrary position

import { Column } from './Column.ts';
import type { JsonValue, RLEColumnData, RLERun, SerializedColumn } from '../types.ts';
import ErrorManager from '../errors/ErrorManager.ts';

ErrorManager.registerMany('RLEColumn', [
  { short: 'COL_RLE_BOUNDS', description: 'RLEColumn: index out of range', rules: { index: 'number' } },
]);

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
      throw ErrorManager.make('COL_RLE_BOUNDS', { index: i });
    }
    // Binary search: first offset strictly greater than i
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
