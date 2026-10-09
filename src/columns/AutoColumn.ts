// ============================================================
// columns/AutoColumn.ts — Автоматически выбирает стратегию по сэмплу
// Порядок эвристик: константа → RLE, неубывающие числа → Delta,
// доля уникальных < 50% → Dictionary, иначе Raw.
// ============================================================

import { Column } from './Column.ts';
import { RawColumn } from './RawColumn.ts';
import { DictionaryColumn } from './DictionaryColumn.ts';
import { DeltaColumn } from './DeltaColumn.ts';
import { RLEColumn } from './RLEColumn.ts';
import type { AutoColumnData, JsonValue, SerializedColumn } from '../types.ts';

export class AutoColumn extends Column {
  samples: JsonValue[] = [];
  delegate: Column | null = null;
  decided = false;
  readonly SAMPLE_SIZE = 50;

  append(value: JsonValue): void {
    if (!this.decided) {
      this.samples.push(value);
      if (this.samples.length >= this.SAMPLE_SIZE) {
        this._decide();
      }
      this._length++;
      return;
    }
    this.delegate!.append(value);
    this._length++;
  }

  private _isNonDecreasing(): boolean {
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1];
      const b = this.samples[i];
      if (typeof a !== 'number' || typeof b !== 'number' || b < a) {
        return false;
      }
    }
    return true;
  }

  private _decide(): void {
    const uniqueCount = new Set(this.samples).size;

    let delegate: Column;
    if (uniqueCount === 1) {
      delegate = new RLEColumn();
    } else if (this._isNonDecreasing()) {
      delegate = new DeltaColumn();
    } else if (uniqueCount / this.samples.length < 0.5) {
      delegate = new DictionaryColumn();
    } else {
      delegate = new RawColumn();
    }

    this.delegate = delegate;
    for (const v of this.samples) {
      delegate.append(v);
    }
    this.samples = [];
    // _length не меняется: сэмпл уже учтён при append()
    this.decided = true;
  }

  get(i: number): JsonValue {
    if (!this.decided) {
      return this.samples[i];
    }
    return this.delegate!.get(i);
  }

  serialize(): SerializedColumn {
    if (!this.decided) {
      return { type: 'auto', decided: false, samples: this.samples };
    }
    return {
      type: 'auto',
      decided: true,
      delegate: this.delegate!.serialize()
    };
  }

  deserialize(data: SerializedColumn): void {
    const s = data as AutoColumnData;
    if (!s.decided) {
      this.samples = s.samples;
      this._length = this.samples.length;
      this.decided = false;
      this.delegate = null;
      return;
    }

    this.decided = true;
    const d = s.delegate;
    let delegate: Column;
    switch (d.type) {
      case 'raw':        delegate = new RawColumn(); break;
      case 'dictionary': delegate = new DictionaryColumn(); break;
      case 'delta':      delegate = new DeltaColumn(); break;
      case 'rle':        delegate = new RLEColumn(); break;
      default:           delegate = new RawColumn();
    }
    delegate.deserialize(d);
    this.delegate = delegate;
    this._length = delegate.length;
  }
}
