// ============================================================
// columns/DictionaryColumn.ts — Словарное кодирование
// Уникальные значения хранятся один раз, в data — индексы
// ============================================================

import { Column } from './Column.ts';
import type { DictionaryColumnData, JsonValue, SerializedColumn } from '../types.ts';

export class DictionaryColumn extends Column {
  dictionary: JsonValue[] = [];
  /** value → index; после deserialize — null (строится лениво при первом append). */
  indexMap: Map<JsonValue, number> | null = new Map();
  data: number[] = [];

  private _map(): Map<JsonValue, number> {
    if (this.indexMap === null) {
      // Сегмент только что прочитан с диска: словарь уже собран при записи —
      // восстанавливаем карту индексов и не держим её в памяти зря на read-only данных.
      const map = new Map<JsonValue, number>();
      for (let i = 0; i < this.dictionary.length; i++) {
        map.set(this.dictionary[i], i);
      }
      this.indexMap = map;
    }
    return this.indexMap;
  }

  append(value: JsonValue): void {
    const map = this._map();
    let idx = map.get(value);
    if (idx === undefined) {
      idx = this.dictionary.length;
      this.dictionary.push(value);
      map.set(value, idx);
    }
    this.data.push(idx);
    this._length++;
  }

  get(i: number): JsonValue {
    return this.dictionary[this.data[i]];
  }

  serialize(): SerializedColumn {
    return { type: 'dictionary', dictionary: this.dictionary, data: this.data };
  }

  deserialize(data: SerializedColumn): void {
    const s = data as DictionaryColumnData;
    this.dictionary = s.dictionary;
    this.data = s.data;
    this.indexMap = null; // лениво в _map() при первом append — экономия памяти на read-only сегментах
    this._length = this.data.length;
  }
}
