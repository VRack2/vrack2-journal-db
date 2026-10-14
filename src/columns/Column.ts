// columns/Column.ts — Base abstract column class

import type { JsonValue, SerializedColumn } from '../types.ts';

/** Base column class. */
export abstract class Column {
  protected _length = 0;

  get length(): number {
    return this._length;
  }

  abstract append(value: JsonValue): void;
  abstract get(index: number): JsonValue;
  abstract serialize(): SerializedColumn;
  abstract deserialize(data: SerializedColumn): void;
}
