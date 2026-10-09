// ============================================================
// columns/DeltaColumn.ts — Дельта-кодирование для чисел
// На диске: baseValue + массив приращений.
// В памяти: один массив значений (O(1) доступ, дельты
// вычисляются при сериализации).
// ============================================================

import { Column } from './Column.ts';
import type { DeltaColumnData, JsonValue, SerializedColumn } from '../types.ts';

export class DeltaColumn extends Column {
  values: number[] = [];

  append(value: JsonValue): void {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError(
        `DeltaColumn.append: ожидается число, получено ${String(value)} (${value === null ? 'null' : typeof value})`
      );
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
