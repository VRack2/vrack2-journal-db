// ============================================================
// engines/types.ts — Базовые типы движков (стратегии слияния при compact())
//
// Движок = именованная стратегия того, КАК compact() объединяет строки
// из нескольких сегментов. Это отдельное от retention понятие:
//   • log        — просто слить сегменты (дефолт, как раньше)
//   • upsert     — по key оставить строку с max(version)
//   • summing    — по key суммировать числовые колонки
//   • collapsing — по key гасить пары +1/-1
// ============================================================

import type { JsonObject, Row } from '../types.ts';

// Row — базовый тип строки журнала; ре-экспортируем, чтобы API движков
// (Engine.merge) было самодостаточным.
export type { Row } from '../types.ts';

/** Идентификаторы движков. */
export type EngineKind = 'log' | 'upsert' | 'summing' | 'collapsing';

/**
 * Нормализованное описание движка — ровно то, что нужно compact() для слияния.
 * Хранится в metadata журнала под ключом {@link ENGINE_META_KEY} и в манифесте
 * `_store.json`. Обязательные поля зависят от `kind` (см. define.ts).
 */
export interface EngineDescriptor {
  kind: EngineKind;
  /** identity-ключ строки (upsert/summing/collapsing) — поля, по которым группируются строки. */
  key?: string[];
  /** колонка «новизны» (upsert обязательна): строка с max(version) побеждает. */
  version?: string;
  /** числовые колонки, которые суммируются (summing). */
  sum?: string[];
  /** колонка знака +1/-1 (collapsing). */
  sign?: string;
}

/** Движок: имя + функция слияния строк при компактизации. */
export interface Engine {
  kind: EngineKind;
  /**
   * Применяет стратегию к строкам (в порядке записи) и возвращает строки,
   * которые попадут в слитый сегмент. Должна быть детерминированной.
   */
  merge(rows: Row[], desc: EngineDescriptor): Row[];
}

/** Ключ в metadata журнала, под которым лежит описание движка. */
export const ENGINE_META_KEY = '_engine';

/**
 * Сериграфически-чистое представление движка в metadata/манифесте:
 * только присутствующие поля (без undefined) — валидный JsonObject.
 */
export function descriptorToMeta(desc: EngineDescriptor): JsonObject {
  const o: JsonObject = { kind: desc.kind };
  if (desc.key) o.key = desc.key;
  if (desc.version) o.version = desc.version;
  if (desc.sum) o.sum = desc.sum;
  if (desc.sign) o.sign = desc.sign;
  return o;
}

/** Обратное: metadata-объект → EngineDescriptor (или undefined, если движка нет). */
export function metaToDescriptor(raw: unknown): EngineDescriptor | undefined {
  if (raw === null || typeof raw !== 'object' || !('kind' in raw)) return undefined;
  const d = raw as Record<string, unknown>;
  if (d.kind !== 'log' && d.kind !== 'upsert' && d.kind !== 'summing' && d.kind !== 'collapsing') {
    return undefined;
  }
  return {
    kind: d.kind as EngineKind,
    key: Array.isArray(d.key) && d.key.every(k => typeof k === 'string') ? (d.key as string[]) : undefined,
    version: typeof d.version === 'string' ? d.version : undefined,
    sum: Array.isArray(d.sum) && d.sum.every(s => typeof s === 'string') ? (d.sum as string[]) : undefined,
    sign: typeof d.sign === 'string' ? d.sign : undefined,
  };
}
