// ============================================================
// columns.ts — Типы колонок для оптимизированного хранения
// ============================================================

import type {
  AutoColumnData,
  ColumnType,
  DictionaryColumnData,
  DeltaColumnData,
  JsonValue,
  RLEColumnData,
  RLERun,
  RawColumnData,
  SerializedColumn,
} from './types.ts';

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

// --------------------------------------------------
// RawColumn — хранение «как есть»
// --------------------------------------------------
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

// --------------------------------------------------
// CatchAllColumn — «корзина» для полей, не вошедших в схему.
// Хранение идентично raw; роль определяется схемой журнала:
// Segment.append() маршрутизирует сюда лишние поля строки.
// --------------------------------------------------
export class CatchAllColumn extends RawColumn {}

// --------------------------------------------------
// DictionaryColumn — словарное кодирование
// Уникальные значения хранятся один раз, в data — индексы
// --------------------------------------------------
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

// --------------------------------------------------
// DeltaColumn — дельта-кодирование для чисел
// На диске: baseValue + массив приращений.
// В памяти: один массив значений (O(1) доступ, дельты
// вычисляются при сериализации).
// --------------------------------------------------
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

// --------------------------------------------------
// RLEColumn — Run-Length Encoding
// runs — [{value, count}], offsets — накопленные границы
// для O(log n) доступа к произвольной позиции
// --------------------------------------------------
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

// --------------------------------------------------
// AutoColumn — автоматически выбирает стратегию по сэмплу
// Порядок эвристик: константа → RLE, неубывающие числа → Delta,
// доля уникальных < 50% → Dictionary, иначе Raw.
// --------------------------------------------------
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

// --------------------------------------------------
// Утилиты
// --------------------------------------------------
export const COLUMN_TYPES: Record<ColumnType, new () => Column> = {
  raw: RawColumn,
  dictionary: DictionaryColumn,
  delta: DeltaColumn,
  rle: RLEColumn,
  auto: AutoColumn,
  catchall: CatchAllColumn
};

export function createColumn(type: ColumnType): Column {
  const C = COLUMN_TYPES[type];
  if (!C) throw new Error(`Unknown column type: ${type}`);
  return new C();
}
