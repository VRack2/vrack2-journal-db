// columns/DictionaryColumn.ts — Dictionary encoding.
// Distinct values are stored once; data holds indices.

import { Column } from './Column.ts';
import type { DictionaryColumnData, JsonValue, SerializedColumn } from '../types.ts';

export class DictionaryColumn extends Column {
  dictionary: JsonValue[] = [];
  /** value → index; null after deserialize (built lazily on first append). */
  indexMap: Map<JsonValue, number> | null = new Map();
  data: number[] = [];

  private _map(): Map<JsonValue, number> {
    if (this.indexMap === null) {
      // Segment just read from disk: the dictionary was already built on write —
      // restore the index map instead of keeping it in memory needlessly for read-only data.
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
    this.indexMap = null; // lazily in _map() on first append — saves memory on read-only segments
    this._length = this.data.length;
  }
}
