// Segment.ts — Data segment with row deduplication

import { Column } from './columns/Column.ts';
import { ColumnFactory } from './columns/ColumnFactory.ts';
import type { ColumnSummary, JsonValue, Metadata, Row, Schema } from '../core/types.ts';
import ErrorManager from '../errors/ErrorManager.ts';

ErrorManager.registerMany('Segment', [
  { short: 'SEG_ROW_OOB', description: 'Segment: logical row index out of range', rules: { index: 'number', max: 'number' } },
]);

/** Adds one numeric value to the column summary (created on first call). */
function updateSummary(summaries: Record<string, ColumnSummary>, fieldName: string, value: number): void {
  let s = summaries[fieldName];
  if (!s) {
    summaries[fieldName] = { min: value, max: value, sum: value, count: 1 };
    return;
  }
  if (value < s.min) s.min = value;
  if (value > s.max) s.max = value;
  s.sum += value;
  s.count++;
}

export class Segment {
  readonly id: string;
  readonly schema: Schema;
  metadata: Metadata;

  columns: Record<string, Column> = {};
  rowMap: number[] = [];       // logical index → physical index
  rowCount = 0;
  physicalRowCount = 0;
  /** How many rows carry a numeric ts — purge() relies on it to not delete rows without ts. */
  tsCount = 0;
  minTs: number | null = null;
  maxTs: number | null = null;

  /** Segment-level summaries of numeric columns: field → {min,max,sum,count}.
   *  Kept over logical rows (duplicates counted, as in getRow).
   *  Used by aggregate()/downsample() as a fast-path for segments
   *  lying entirely inside the range. */
  summaries: Record<string, ColumnSummary> = {};

  /** WAL watermark: the highest WAL sequence covered by this segment's rows.
   *  Replay skips WAL lines with seq <= the max watermark across closed
   *  segments, so a crash between persist and WAL truncate cannot duplicate. */
  walSeq = 0;

  /** Name of the "catch-all" field (catchall type) for fields outside the schema, or null */
  private _catchAllField: string | null = null;

  /** Schema field names — computed once instead of Object.keys() in hot paths. */
  private readonly _fields: string[];

  constructor(id: string, schema: Schema, metadata: Metadata = {}) {
    this.id = id;
    this.schema = schema;
    this.metadata = metadata;
    this._fields = Object.keys(schema);

    for (const [fieldName, type] of Object.entries(schema)) {
      this.columns[fieldName] = ColumnFactory.create(type);
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

    // Normalize the row against the schema:
    //  - declared fields missing from the row → null padding;
    //  - extra fields → the catchall column (if declared), otherwise dropped.
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

    // Summaries of numeric columns — per logical row (duplicates counted),
    // to match getRow()/aggregate(). Only rows with a numeric ts are counted
    // (aggregate() excludes them) and only finite numbers (null/non-numeric are not).
    if (hasTs) {
      for (const fieldName of this._fields) {
        const v = values[fieldName];
        if (typeof v === 'number' && Number.isFinite(v)) {
          updateSummary(this.summaries, fieldName, v);
        }
      }
    }

    // Deduplication: the last unique row always sits at physical index
    // physicalRowCount - 1 (new rows are numbered in order, duplicates do not
    // increment the counter)
    if (this.physicalRowCount > 0 && this._equalsValues(values, this.physicalRowCount - 1)) {
      this.rowMap.push(this.physicalRowCount - 1);
      this.rowCount++;
      return;
    }

    // New unique row
    for (const fieldName of this._fields) {
      this.columns[fieldName].append(values[fieldName]);
    }

    this.rowMap.push(this.physicalRowCount);
    this.physicalRowCount++;
    this.rowCount++;
  }

  get(fieldName: string, logicalIndex: number): JsonValue {
    if (logicalIndex < 0 || logicalIndex >= this.rowCount) {
      throw ErrorManager.make('SEG_ROW_OOB', { index: logicalIndex, max: this.rowCount - 1 });
    }
    const column = this.columns[fieldName];
    // The field appeared in the schema later — older segments do not know it.
    if (!column) return null;
    const physicalIndex = this.rowMap[logicalIndex];
    return column.get(physicalIndex);
  }

  getRow(logicalIndex: number): Row {
    if (logicalIndex < 0 || logicalIndex >= this.rowCount) {
      throw ErrorManager.make('SEG_ROW_OOB', { index: logicalIndex, max: this.rowCount - 1 });
    }
    // Bounds check and rowMap lookup once per row, not once per field (hot path).
    const physicalIndex = this.rowMap[logicalIndex];
    const result: Row = {};
    for (const fieldName of this._fields) {
      const column = this.columns[fieldName];
      result[fieldName] = column ? column.get(physicalIndex) : null;
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

  /** Value comparison: primitives — strict, objects — by content */
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
}
