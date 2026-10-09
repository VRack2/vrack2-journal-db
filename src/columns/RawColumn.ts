// ============================================================
// columns/RawColumn.ts — Хранение «как есть»
// ============================================================

import { Column } from './Column.ts';
import type { JsonValue, RawColumnData, SerializedColumn } from '../types.ts';

export class RawColumn extends Column {
  data: JsonValue[] = [];

  append(value: JsonValue): void {
    this.data.push(value);
    this._length++;
  }

  get(i: number): JsonValue {
    return this.data[i];
  }

  serialize(): SerializedColumn {
    return { type: 'raw', data: this.data };
  }

  deserialize(data: SerializedColumn): void {
    const s = data as RawColumnData;
    this.data = s.data;
    this._length = this.data.length;
  }
}
