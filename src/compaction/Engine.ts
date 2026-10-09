// ============================================================
// compaction/Engine.ts — Базовый класс движков компактизации
//
// Общее для всех движков: дескриптор (параметры слияния) и типовая логика —
// числовое значение поля, группировка по identity-ключу, выбор «свежей»
// строки в группе. Конкретика — abstract merge() — у каждого наследника.
//
// Новый движок = класс, наследующий Engine и реализующий merge() (Log/Upsert/
// Summing/Collapsing — примеры). Маршрутизация kind→класс — в journal.ts.
// ============================================================

import type { Row, EngineKind } from './types.ts';
import type { Descriptor } from './Descriptor.ts';

/** Все виды движков (для ошибок/документации). */
export const ENGINE_KINDS: readonly EngineKind[] = ['log', 'upsert', 'summing', 'collapsing'];

export abstract class Engine {
  readonly kind: EngineKind;
  protected readonly desc: Descriptor;

  constructor(kind: EngineKind, desc: Descriptor) {
    this.kind = kind;
    this.desc = desc;
  }

  /** Применяет стратегию к строкам (в порядке записи) и возвращает строки для слитого сегмента. */
  abstract merge(rows: Row[]): Row[];

  // --- общее (ранее engines/util.ts) --------------------------------------

  /** Числовое значение поля; не-число/NaN → 0. */
  protected num(row: Row, field: string): number {
    const v = row[field];
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Числовое значение «новизны»; без версии → 0. */
  protected versionOf(row: Row): number {
    return this.desc.version ? this.num(row, this.desc.version) : 0;
  }

  /** Стабильная строка-ключ из полей desc.key (различает типы и вложенные значения). */
  protected keyOf(row: Row): string {
    const key = this.desc.key ?? [];
    if (key.length === 0) return '';
    return key.map(f => JSON.stringify(row[f] ?? null)).join('\u0000');
  }

  /** Сгруппировать строки по identity-ключу (порядкосохраняющие группы). */
  protected groupByKey(rows: Row[]): Map<string, Row[]> {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const k = this.keyOf(row);
      const arr = groups.get(k);
      if (arr) arr.push(row);
      else groups.set(k, [row]);
    }
    return groups;
  }

  /** Строка-«база» в группе: max(version), либо последняя по порядку (если версии нет). */
  protected baseRow(group: Row[]): Row | undefined {
    if (group.length === 0) return undefined;
    if (!this.desc.version) return group[group.length - 1];
    let best = group[0];
    let bestV = this.versionOf(best);
    for (let i = 1; i < group.length; i++) {
      const v = this.versionOf(group[i]);
      if (v > bestV) {
        best = group[i];
        bestV = v;
      }
    }
    return best;
  }
}
