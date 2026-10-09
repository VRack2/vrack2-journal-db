// ============================================================
// columns/ColumnFactory.ts — Реестр типов колонок и фабрика
// ============================================================

import { RawColumn } from './RawColumn.ts';
import { DictionaryColumn } from './DictionaryColumn.ts';
import { DeltaColumn } from './DeltaColumn.ts';
import { RLEColumn } from './RLEColumn.ts';
import { AutoColumn } from './AutoColumn.ts';
import { CatchAllColumn } from './CatchAllColumn.ts';
import { Column } from './Column.ts';
import type { ColumnType } from '../types.ts';

export class ColumnFactory {
  /** Реестр: имя типа → класс. */
  static readonly types: Record<ColumnType, new () => Column> = {
    raw: RawColumn,
    dictionary: DictionaryColumn,
    delta: DeltaColumn,
    rle: RLEColumn,
    auto: AutoColumn,
    catchall: CatchAllColumn
  };

  /** Создаёт колонку по имени типа. */
  static create(type: ColumnType): Column {
    const C = this.types[type];
    if (!C) throw new Error(`Unknown column type: ${type}`);
    return new C();
  }
}
