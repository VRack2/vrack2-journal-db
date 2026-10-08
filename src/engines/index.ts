// ============================================================
// engines/index.ts — Реестр движков (кто что делает — прозрачно)
//
// Единственная точка, где видна вся система: каждый движок — отдельный файл
// (log/upsert/summing/collapsing), здесь они собраны в реестр и доступна
// функция mergeWithEngine() — то, что реально вызывает compact().
// Добавление нового движка = один файл + одна строка в `engines`.
// ============================================================

import type { Engine, EngineDescriptor, EngineKind, Row } from './types.ts';
import { logEngine } from './log.ts';
import { upsertEngine } from './upsert.ts';
import { summingEngine } from './summing.ts';
import { collapsingEngine } from './collapsing.ts';

/** Реестр: имя движка → реализация. Порядок — от простого к сложному. */
export const engines: Record<EngineKind, Engine> = {
  log: logEngine,
  upsert: upsertEngine,
  summing: summingEngine,
  collapsing: collapsingEngine,
};

/**
 * Применяет стратегию движка к строкам. Это ядро compact(): journal.ts
 * вызывает отсюда, сам не зная деталей слияния.
 */
export function mergeWithEngine(rows: Row[], desc: EngineDescriptor): Row[] {
  return engines[desc.kind].merge(rows, desc);
}

/** Достижные имена движков (для ошибок/документации). */
export const ENGINE_KINDS: readonly EngineKind[] = ['log', 'upsert', 'summing', 'collapsing'];

// Реэкспорт API движков + описаний таблиц
export {
  logEngine,
  upsertEngine,
  summingEngine,
  collapsingEngine
};
export {
  ENGINE_META_KEY,
  descriptorToMeta,
  metaToDescriptor
} from './types.ts';
export { keyTuple, asNum, baseIndex } from './util.ts';
export {
  defineLogTable,
  defineUpsertTable,
  defineSummingTable,
  defineCollapsingTable,
  engineDescriptorOf
} from './define.ts';
export type {
  Engine,
  EngineDescriptor,
  EngineKind
} from './types.ts';
export type {
  AnyTableDef,
  LogTableDef,
  UpsertTableDef,
  SummingTableDef,
  CollapsingTableDef,
  TableRuntime,
  TableDescription
} from './define.ts';

// Фаза 2 — мультитирная таблица (MergeTree), rollup и retention.
export { MergeTree } from './mergeTree.ts';
export type {
  MergeTreeConfig,
  MergeTreeRollupReport,
  MergeTreeTierStat
} from './mergeTree.ts';
export { Tier } from './tier.ts';
export { promote, applyAgg } from './rollup.ts';
export { tiersForRetention, validateTiers } from './retention.ts';
