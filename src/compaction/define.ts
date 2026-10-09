// ============================================================
// compaction/define.ts — Описания таблиц (define*Table)
//
// Единый «язык» для декларирования таблиц: одна функция на движок, у каждой
// свои параметры (как движки ClickHouse). Возвращают типизированное описание
// (AnyTableDef) — его можно передать в store.create(def), записать в манифест
// _store.json или отдать коллеге/AI-агенту как самодостаточный артефакт.
//
//   const cpu = defineUpsertTable({
//     name: 'cpu',
//     desc: 'Состояние CPU: последняя версия по (host, metric)',
//     columns: { ts: 'delta', host: 'dictionary', metric: 'dictionary', value: 'auto' },
//     key: ['host', 'metric'],
//     version: 'ts',
//   });
//   store.create(cpu);
//
// Валидация выполняется сразу при вызове define* — ошибки видны на месте
// объявления, а не при первом compact().
// ============================================================

import type { Schema } from '../types.ts';
import { Descriptor } from './Descriptor.ts';

// --------------------------------------------------
// Базовое + специфичные описания (дискриминированный union по kind)
// --------------------------------------------------

interface BaseTableDef {
  /** Имя таблицы (и имя журнала/каталога в хранилище). */
  name: string;
  /** Человек- и AI-читаемое назначение: зачем таблица и что в ней хранится. */
  desc?: string;
  /** Схема: поле → тип колонки. */
  columns: Schema;
  /** Retention-политика (для Table/тиров), например '5s:1d,15s:1w,1m:1mon'. */
  retention?: string;
  /** Строк в сегменте (передаётся в JournalOptions). */
  rowsPerSegment?: number;
}

/** log — слияние без изменения строк. */
export interface LogTableDef extends BaseTableDef {
  kind: 'log';
}

/** upsert — по key оставить строку с max(version). */
export interface UpsertTableDef extends BaseTableDef {
  kind: 'upsert';
  key: string[];
  version: string;
}

/** summing — по key суммировать числовые колонки `sum`. */
export interface SummingTableDef extends BaseTableDef {
  kind: 'summing';
  key: string[];
  sum: string[];
  version?: string;
}

/** collapsing — по key гасить пары +1/-1 в колонке `sign`. */
export interface CollapsingTableDef extends BaseTableDef {
  kind: 'collapsing';
  key: string[];
  sign: string;
  version?: string;
}

/** Любое описание таблицы — то, что принимает store.create() и пишет в манифест. */
export type AnyTableDef = LogTableDef | UpsertTableDef | SummingTableDef | CollapsingTableDef;

/** Рантайм-статистика таблицы (из каталога журнала на диске). */
export interface TableRuntime {
  /** Логических строк в закрытых сегментах (без активного). */
  rows: number;
  /** Количество файлов сегментов. */
  segments: number;
  /** Размер сегментов на диске, байт. */
  sizeBytes: number;
}

/** Результат store.describe(): описание таблицы + рантайм-статистика. */
export type TableDescription = AnyTableDef & TableRuntime;

// --------------------------------------------------
// Валидация (базовые правила)
// --------------------------------------------------

function validateBase(cfg: BaseTableDef, kind: string): void {
  if (typeof cfg.name !== 'string' || cfg.name.trim().length === 0) {
    throw new RangeError(`${kind}: name — непустая строка`);
  }
  if (!cfg.columns || typeof cfg.columns !== 'object') {
    throw new RangeError(`${kind}: columns — объект «поле → тип колонки»`);
  }
  if (Object.keys(cfg.columns).length === 0) {
    throw new RangeError(`${kind}: columns — непустая схема`);
  }
}

function validateKey(cfg: BaseTableDef & { key: unknown }, kind: string): void {
  if (!Array.isArray(cfg.key) || cfg.key.length === 0) {
    throw new RangeError(`${kind}: key — непустой массив полей identity-ключа`);
  }
  for (const f of cfg.key) {
    if (typeof f !== 'string' || !(f in cfg.columns)) {
      throw new RangeError(`${kind}: key — поле "${String(f)}" не найдено в columns`);
    }
  }
}

function requireColumn(cfg: BaseTableDef, field: unknown, kind: string): string {
  if (typeof field !== 'string' || field.length === 0) {
    throw new RangeError(`${kind}: требуется непустое имя колонки`);
  }
  if (!(field in cfg.columns)) {
    throw new RangeError(`${kind}: колонка "${field}" не найдена в columns`);
  }
  return field;
}

// --------------------------------------------------
// define* — одна функция на движок
// --------------------------------------------------

/** log (MergeTree): слияние без изменения строк. */
export function defineLogTable(cfg: Omit<LogTableDef, 'kind'>): LogTableDef {
  validateBase(cfg, 'log');
  return { ...cfg, kind: 'log' };
}

/** upsert (ReplacingMergeTree): по key оставить строку с max(version). */
export function defineUpsertTable(cfg: Omit<UpsertTableDef, 'kind'>): UpsertTableDef {
  validateBase(cfg, 'upsert');
  validateKey(cfg, 'upsert');
  const version = requireColumn(cfg, cfg.version, 'upsert');
  return { ...cfg, kind: 'upsert', version };
}

/** summing (SummingMergeTree): по key суммировать числовые колонки `sum`. */
export function defineSummingTable(cfg: Omit<SummingTableDef, 'kind'>): SummingTableDef {
  validateBase(cfg, 'summing');
  validateKey(cfg, 'summing');
  if (!Array.isArray(cfg.sum) || cfg.sum.length === 0) {
    throw new RangeError('summing: sum — непустой массив числовых колонок');
  }
  const sum = cfg.sum.map(s => requireColumn(cfg, s, 'summing'));
  const version = cfg.version != null ? requireColumn(cfg, cfg.version, 'summing') : undefined;
  return { ...cfg, kind: 'summing', sum, version };
}

/** collapsing (CollapsingMergeTree): по key гасить пары +1/-1 в колонке `sign`. */
export function defineCollapsingTable(cfg: Omit<CollapsingTableDef, 'kind'>): CollapsingTableDef {
  validateBase(cfg, 'collapsing');
  validateKey(cfg, 'collapsing');
  const sign = requireColumn(cfg, cfg.sign, 'collapsing');
  const version = cfg.version != null ? requireColumn(cfg, cfg.version, 'collapsing') : undefined;
  return { ...cfg, kind: 'collapsing', sign, version };
}

// --------------------------------------------------
// Описание → дескриптор движка (для metadata/compact)
// --------------------------------------------------

/** Достаёт из описания таблицы дескриптор движка (то, что нужно compact()). */
export function engineDescriptorOf(def: AnyTableDef): Descriptor {
  switch (def.kind) {
    case 'log':
      return new Descriptor({ kind: 'log' });
    case 'upsert':
      return new Descriptor({ kind: 'upsert', key: def.key, version: def.version });
    case 'summing':
      return new Descriptor({ kind: 'summing', key: def.key, sum: def.sum, version: def.version });
    case 'collapsing':
      return new Descriptor({ kind: 'collapsing', key: def.key, sign: def.sign, version: def.version });
  }
}
