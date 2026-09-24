// ============================================================
// segment.ts — Сегмент данных с дедупликацией строк
// ============================================================

import { createColumn, type Column } from './columns.ts';
import type { JsonValue, Metadata, Row, Schema, SerializedColumn, SerializedSegment } from './types.ts';

export class Segment {
  readonly id: string;
  readonly schema: Schema;
  metadata: Metadata;

  columns: Record<string, Column> = {};
  rowMap: number[] = [];       // логический индекс → физический индекс
  rowCount = 0;
  physicalRowCount = 0;
  minTs: number | null = null;
  maxTs: number | null = null;

  /** Имя поля-«корзины» (тип catchall) для полей вне схемы, либо null */
  private _catchAllField: string | null = null;

  /** Имена полей схемы — считаются один раз вместо Object.keys() в hot-путях. */
  private readonly _fields: string[];

  constructor(id: string, schema: Schema, metadata: Metadata = {}) {
    this.id = id;
    this.schema = schema;
    this.metadata = metadata;
    this._fields = Object.keys(schema);

    for (const [fieldName, type] of Object.entries(schema)) {
      this.columns[fieldName] = createColumn(type);
    }

    const catchAll = Object.entries(schema).find(([, t]) => t === 'catchall');
    this._catchAllField = catchAll ? catchAll[0] : null;
  }

  append(row: Row): void {
    const ts = row.ts;
    if (typeof ts === 'number') {
      if (this.minTs === null || ts < this.minTs) this.minTs = ts;
      if (this.maxTs === null || ts > this.maxTs) this.maxTs = ts;
    }

    // Нормализация строки под схему:
    //  - объявленные поля, отсутствующие в строке → null-падинг;
    //  - лишние поля → в catchall-колонку (если объявлена), иначе отбрасываются.
    const values: Record<string, JsonValue> = {};
    const extras: Row = {};
    for (const [key, value] of Object.entries(row)) {
      if (key in this.schema) {
        values[key] = value === undefined ? null : value;
      } else {
        extras[key] = value;
      }
    }
    for (const fieldName of this._fields) {
      if (!(fieldName in values)) values[fieldName] = null;
    }
    if (this._catchAllField && Object.keys(extras).length > 0) {
      values[this._catchAllField] = extras;
    }

    // Дедупликация: последняя уникальная строка всегда лежит под
    // физическим индексом physicalRowCount - 1 (новые строки нумеруются
    // по порядку, дубли не инкрементируют счётчик)
    if (this.physicalRowCount > 0 && this._equalsValues(values, this.physicalRowCount - 1)) {
      this.rowMap.push(this.physicalRowCount - 1);
      this.rowCount++;
      return;
    }

    // Новая уникальная строка
    for (const fieldName of this._fields) {
      this.columns[fieldName].append(values[fieldName]);
    }

    this.rowMap.push(this.physicalRowCount);
    this.physicalRowCount++;
    this.rowCount++;
  }

  get(fieldName: string, logicalIndex: number): JsonValue {
    if (logicalIndex < 0 || logicalIndex >= this.rowCount) {
      throw new RangeError(`Row index ${logicalIndex} out of bounds (0..${this.rowCount - 1})`);
    }
    const column = this.columns[fieldName];
    // Поле появилось в схеме позже — старые сегменты его не знают.
    if (!column) return null;
    const physicalIndex = this.rowMap[logicalIndex];
    return column.get(physicalIndex);
  }

  getRow(logicalIndex: number): Row {
    const result: Row = {};
    for (const fieldName of this._fields) {
      result[fieldName] = this.get(fieldName, logicalIndex);
    }
    return result;
  }

  private _equalsValues(values: Record<string, JsonValue>, physicalIndex: number): boolean {
    for (const fieldName of this._fields) {
      if (!this._valueEqual(values[fieldName], this.columns[fieldName].get(physicalIndex))) {
        return false;
      }
    }
    return true;
  }

  /** Сравнение значений: примитивы — строго, объекты — по содержимому */
  private _valueEqual(a: JsonValue, b: JsonValue): boolean {
    if (a === b) return true;
    if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }
    return false;
  }

  serialize(): SerializedSegment {
    const serializedColumns: Record<string, SerializedColumn> = {};
    for (const [fieldName, column] of Object.entries(this.columns)) {
      serializedColumns[fieldName] = column.serialize();
    }

    return {
      formatVersion: 2,
      id: this.id,
      schema: this.schema,
      metadata: this.metadata,
      rowCount: this.rowCount,
      physicalRowCount: this.physicalRowCount,
      minTs: this.minTs,
      maxTs: this.maxTs,
      rowMap: this.rowMap,
      columns: serializedColumns
    };
  }

  static deserialize(data: SerializedSegment): Segment {
    if (data.formatVersion !== undefined && data.formatVersion > 2) {
      throw new Error(`Неподдерживаемая версия формата сегмента: ${data.formatVersion}`);
    }

    const segment = new Segment(data.id, data.schema, data.metadata);
    segment.rowCount = data.rowCount;
    segment.physicalRowCount = data.physicalRowCount;
    segment.minTs = data.minTs;
    segment.maxTs = data.maxTs;
    segment.rowMap = data.rowMap;

    for (const [fieldName, serializedData] of Object.entries(data.columns)) {
      segment.columns[fieldName].deserialize(serializedData);
    }

    return segment;
  }
}
