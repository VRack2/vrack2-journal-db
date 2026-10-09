// ============================================================
// columns/Column.ts — Базовый абстрактный класс колонки
// ============================================================

import type { JsonValue, SerializedColumn } from '../types.ts';

/**
 * Базовый класс колонки.
 */
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
