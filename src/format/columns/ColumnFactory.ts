// columns/ColumnFactory.ts — Registry of column types and factory

import { RawColumn } from './RawColumn.ts';
import { DictionaryColumn } from './DictionaryColumn.ts';
import { DeltaColumn } from './DeltaColumn.ts';
import { RLEColumn } from './RLEColumn.ts';
import { AutoColumn } from './AutoColumn.ts';
import { CatchAllColumn } from './CatchAllColumn.ts';
import { Column } from './Column.ts';
import type { ColumnType } from '../../core/types.ts';
import ErrorManager from '../../errors/ErrorManager.ts';

ErrorManager.registerMany('ColumnFactory', [
  { short: 'COL_TYPE_UNKNOWN', description: 'Unknown column type', rules: { type: 'string' } },
]);

export class ColumnFactory {
  /** Registry: type name → class. */
  static readonly types: Record<ColumnType, new () => Column> = {
    raw: RawColumn,
    dictionary: DictionaryColumn,
    delta: DeltaColumn,
    rle: RLEColumn,
    auto: AutoColumn,
    catchall: CatchAllColumn
  };

  /** Create a column by type name. */
  static create(type: ColumnType): Column {
    const C = this.types[type];
    if (!C) throw ErrorManager.make('COL_TYPE_UNKNOWN', { type: String(type) });
    return new C();
  }
}
