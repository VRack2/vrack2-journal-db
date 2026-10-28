// columns/DeltaColumn.ts — Delta encoding for numbers.
// On disk: baseValue + delta array.
// In memory: a single value array (O(1) access; deltas
// are computed at serialization time).

import { Column } from './Column.ts';
import type { DeltaColumnData, JsonValue, SerializedColumn } from '../../core/types.ts';
import ErrorManager from '../../errors/ErrorManager.ts';

ErrorManager.registerMany('DeltaColumn', [
  { short: 'COL_DELTA_TYPE', description: 'DeltaColumn.append: a number is expected', rules: { value: 'string' } },
]);

export class DeltaColumn extends Column {
  values: number[] = [];

  append(value: JsonValue): void {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw ErrorManager.make('COL_DELTA_TYPE', { value: String(value) });
    }
    this.values.push(value);
    this._length++;
  }

  get(i: number): JsonValue {
    return this.values[i];
  }

  serialize(): SerializedColumn {
    if (this.values.length === 0) {
      return { type: 'delta', baseValue: null, deltas: [] };
    }

    const baseValue = this.values[0];
    const deltas = new Array<number>(this.values.length - 1);
    for (let i = 1; i < this.values.length; i++) {
      deltas[i - 1] = this.values[i] - this.values[i - 1];
    }

    return { type: 'delta', baseValue, deltas };
  }

  deserialize(data: SerializedColumn): void {
    const s = data as DeltaColumnData;
    if (s.baseValue === null || s.baseValue === undefined) {
      this.values = [];
    } else {
      let v = s.baseValue;
      const values: number[] = [v];
      for (const d of s.deltas) {
        v += d;
        values.push(v);
      }
      this.values = values;
    }
    this._length = this.values.length;
  }
}
