// Фаза 2 — rollup: агрегация строк тонкого тира в строки грубого разрешения.
//
// Чистые функции (без IO): группировка по (бакет грубого разрешения, размеры
// dims) + agg по числам. Запись результата в журнал делает вызывающий
// (Tier/MergeTree). Эти же функции использует Table (src/table.ts), чтобы
// логика агрегации была в одном месте.

import { Interval } from '../interval.ts';
import type { AggFn, JsonValue, Row } from '../types.ts';

/** Примени агрегационную функцию к списку чисел. */
export function applyAgg(fn: AggFn, vals: number[]): number {
  switch (fn) {
    case 'count':
      return vals.length;
    case 'sum':
      return vals.reduce((a, b) => a + b, 0);
    case 'min':
      return Math.min(...vals);
    case 'max':
      return Math.max(...vals);
    case 'avg':
      return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
}

/**
 * Агрегирует `rows` (из тонкого тира) в строки разрешения `toResMs` (грубый
 * тир). Группировка по (бакет toResMs, dims); для каждого agg-поля — applyAgg
 * по собранным числам; строки без чисел по полю дают null.
 *
 * Порядок вывода — порядок первой встречи группы (стабильно для теста).
 * Чистая функция: журнал не трогает.
 */
export function promote(
  rows: Row[],
  agg: Record<string, AggFn>,
  dims: string[],
  toResMs: number
): Row[] {
  const aggFields = Object.keys(agg);
  const groups = new Map<
    string,
    { bucket: number; dims: Record<string, JsonValue>; values: Record<string, number[]> }
  >();

  for (const row of rows) {
    const bucket = Interval.roundTime(row['ts'] as number, toResMs);
    const dimVals: Record<string, JsonValue> = {};
    for (const d of dims) dimVals[d] = row[d] ?? null;
    const dimKey = dims.map(d => JSON.stringify(dimVals[d])).join('\u001f');
    const key = `${bucket}\u001e${dimKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { bucket, dims: dimVals, values: {} };
      for (const f of aggFields) g.values[f] = [];
      groups.set(key, g);
    }
    for (const f of aggFields) {
      const v = row[f];
      if (typeof v === 'number' && Number.isFinite(v)) g.values[f].push(v);
    }
  }

  const out: Row[] = [];
  for (const g of groups.values()) {
    const outRow: Row = { ts: g.bucket, ...g.dims };
    for (const f of aggFields) {
      outRow[f] = g.values[f].length > 0 ? applyAgg(agg[f], g.values[f]) : null;
    }
    out.push(outRow);
  }
  return out;
}
