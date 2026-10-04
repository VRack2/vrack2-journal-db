// ============================================================
// segment.ts — Сегмент данных с дедупликацией строк
// ============================================================

import { createColumn, type Column } from './columns.ts';
import type { ColumnSummary, JsonValue, Metadata, Row, Schema, SerializedColumn, SerializedSegment } from './types.ts';

export class Segment {
  readonly id: string;
  readonly schema: Schema;
  metadata: Metadata;

  columns: Record<string, Column> = {};
  rowMap: number[] = [];       // логический индекс → физический индекс
  rowCount = 0;
  physicalRowCount = 0;
  /** Сколько строк несёт числовой ts — нужно purge(), чтобы не удалять строки без ts. */
  tsCount = 0;
  minTs: number | null = null;
  maxTs: number | null = null;

  /** Сегментные саммари числовых колонок: поле → {min,max,sum,count}.
   *  Ведутся по логическим строкам (дубли учитываются, как в getRow).
   *  Используются aggregate()/downsample() как fast-path для сегментов,
   *  целиком лежащих в диапазоне. */
  summaries: Record<string, ColumnSummary> = {};

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
    const hasTs = typeof ts === 'number';
    if (hasTs) {
      this.tsCount++;
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

    // Саммари числовых колонок — по каждой логической строке (дубли учитываются),
    // чтобы совпадать с getRow()/aggregate(). Учитываются только строки с числовым
    // ts (aggregate() их исключает) и только конечные числа (null/не-числа — нет).
    if (hasTs) {
      for (const fieldName of this._fields) {
        const v = values[fieldName];
        if (typeof v === 'number' && Number.isFinite(v)) {
          this._updateSummary(fieldName, v);
        }
      }
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

  /** Прибавляет одно числовое значение к саммари колонки (создаёт при первом). */
  private _updateSummary(fieldName: string, value: number): void {
    let s = this.summaries[fieldName];
    if (!s) {
      this.summaries[fieldName] = { min: value, max: value, sum: value, count: 1 };
      return;
    }
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;
    s.sum += value;
    s.count++;
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
      tsCount: this.tsCount,
      minTs: this.minTs,
      maxTs: this.maxTs,
      rowMap: this.rowMap,
      columns: serializedColumns,
      summaries: this.summaries
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

    // tsCount берём из файла; для старых сегментов (до этого поля) считаем сами —
    // purge() опирается на него, чтобы не удалить строки без ts.
    segment.tsCount = typeof data.tsCount === 'number' ? data.tsCount : segment._countTsRows();

    // Саммари числовых колонок: из файла, либо пересчёт (старые сегменты).
    segment.summaries = (data.summaries && typeof data.summaries === 'object')
      ? data.summaries
      : segment._computeSummaries();
    return segment;
  }

  /** Сколько строк несёт числовой ts (строки без ts не учитываются). */
  private _countTsRows(): number {
    const tsCol = this.columns['ts'];
    if (!tsCol) return 0;
    let n = 0;
    for (let i = 0; i < this.rowCount; i++) {
      if (typeof this.get('ts', i) === 'number') n++;
    }
    return n;
  }

  /** Пересчитывает саммари числовых колонок по логическим строкам,
   *  как aggregate(): только строки с числовым ts, только конечные числа.
   *  Для сегментов, записанных до появления поля summaries. */
  private _computeSummaries(): Record<string, ColumnSummary> {
    const out: Record<string, ColumnSummary> = {};
    for (let i = 0; i < this.rowCount; i++) {
      const ts = this.get('ts', i);
      if (typeof ts !== 'number') continue; // строки без ts вне агрегаций
      for (const fieldName of this._fields) {
        const v = this.get(fieldName, i);
        if (typeof v === 'number' && Number.isFinite(v)) {
          let s = out[fieldName];
          if (!s) {
            out[fieldName] = { min: v, max: v, sum: v, count: 1 };
          } else {
            if (v < s.min) s.min = v;
            if (v > s.max) s.max = v;
            s.sum += v;
            s.count++;
          }
        }
      }
    }
    return out;
  }
}
