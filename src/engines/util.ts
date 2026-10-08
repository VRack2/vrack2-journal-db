// ============================================================
// engines/util.ts — Общие утилиты для движков
// ============================================================

import type { Row } from '../types.ts';

/**
 * Стабильная строка-ключ из полей `key` строки. JSON-кодирует каждое значение,
 * чтобы различать типы (`1` vs `"1"`) и вложенные структуры; null → "null".
 * Поля разделяются \u0000, чтобы не было коллизий с содержимым.
 */
export function keyTuple(key: string[], row: Row): string {
  if (key.length === 0) return '';
  return key.map(f => JSON.stringify(row[f] ?? null)).join('\u0000');
}

/** Числовое значение для сравнения «новизны»; не-число → 0. */
export function asNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Индекс строки-«базы» в группе: строка с max(version) (или последняя по
 * порядку, если version не задан). Используется summing/collapsing для
 * выбора «свежей» версии описательных полей.
 */
export function baseIndex(group: Row[], version?: string): number {
  if (group.length === 0) return -1;
  if (!version) return group.length - 1;
  let best = 0;
  for (let i = 1; i < group.length; i++) {
    if (asNum(group[i][version]) > asNum(group[best][version])) best = i;
  }
  return best;
}
