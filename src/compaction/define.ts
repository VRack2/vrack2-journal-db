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

import type { AggFn, OpenJournalOptions, ResolutionTier, RetentionTier, Schema } from '../types.ts';
import { Descriptor } from './Descriptor.ts';

// --------------------------------------------------
// Базовое + специфичные описания (дискриминированный union по kind)
// --------------------------------------------------

/** Storage-тиры (re-encode без потерь): кодек/сжатие по возрасту данных. */
export interface StorageConfig {
  /** Тир'ы (по умолчанию RetentionEngine.defaultTiers()). */
  tiers?: RetentionTier[];
}

interface BaseTableDef {
  /** Имя таблицы (и имя каталога в хранилище). */
  name: string;
  /** Человек- и AI-читаемое назначение: зачем таблица и что в ней хранится. */
  desc?: string;
  /** Схема: поле → тип колонки. */
  columns: Schema;

  // --- правило склейки по возрасту (тиры/rollup), опционально ------------
  /** Retention-политика 'res:ttl,res:ttl' (тиры разрешения).
   *  Задана → таблица мультитирная (rollup + TTL). Требует явный `agg`. */
  retention?: string;
  /** Явный массив тиров (от тонких к грубым). Приоритет над `retention`.
   *  Задан → таблица мультитирная. Требует явный `agg`. */
  tiers?: ResolutionTier[];
  /** Агрегация rollup: поле → fn (min|max|sum|avg|count). Обязательно при `retention`. */
  agg?: Record<string, AggFn>;
  /** Поля-размеры rollup (group-by). По умолчанию: ключ движка (без ts) или схема − ts − agg. */
  dims?: string[];

  // --- storage (re-encode без потерь), опционально -------------------------
  /** Storage-тиры (кодек/сжатие по возрасту, без потерь). По умолчанию выключено. */
  storage?: StorageConfig;

  // --- обслуживание --------------------------------------------------------
  /** Авто-ролап при append (по умолчанию true; только для тирных таблиц). */
  autoRollup?: boolean;
  /** Авто-purge при append (по умолчанию true). */
  autoPurge?: boolean;
  /** Троттлинг авто-обслуживания (мс, по умолчанию 30 000; 0 — каждый append). */
  maintenanceMinIntervalMs?: number;
  /** Провайдер «текущего времени» (тесты). По умолчанию Date.now. */
  nowProvider?: () => number;

  // --- физическое (журнал) --------------------------------------------------
  /** Строк в сегменте. */
  rowsPerSegment?: number;
  /** Физические опции журнала (lock, format, compression, codecs, walBatchSize, …). */
  opts?: OpenJournalOptions;
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

const AGG_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count']);

function validateBase(cfg: BaseTableDef, kind: string): void {
  if (typeof cfg.name !== 'string' || cfg.name.trim().length === 0) {
    throw new RangeError(`${kind}: name — непустая строка`);
  }
  if (cfg.name.includes('/')) {
    throw new RangeError(`${kind}: name не должно содержать "/"`);
  }
  if (!cfg.columns || typeof cfg.columns !== 'object') {
    throw new RangeError(`${kind}: columns — объект «поле → тип колонки»`);
  }
  if (Object.keys(cfg.columns).length === 0) {
    throw new RangeError(`${kind}: columns — непустая схема`);
  }
  // --- retention/agg/dims --------------------------------------------------
  if ((cfg.retention !== undefined || cfg.tiers !== undefined)
    && (!cfg.agg || Object.keys(cfg.agg).length === 0)) {
    throw new RangeError(`${kind}: retention/tiers — требует явный agg (поле → min|max|sum|avg|count)`);
  }
  if (cfg.tiers !== undefined) {
    if (!Array.isArray(cfg.tiers) || cfg.tiers.length === 0) {
      throw new RangeError(`${kind}: tiers — непустой массив { resMs, ttlMs }`);
    }
    for (const t of cfg.tiers) {
      if (!t || !Number.isFinite(t.resMs) || t.resMs <= 0 || !Number.isFinite(t.ttlMs) || t.ttlMs <= 0) {
        throw new RangeError(`${kind}: tiers — resMs/ttlMs должны быть > 0`);
      }
    }
    for (let i = 1; i < cfg.tiers.length; i++) {
      if (cfg.tiers[i].resMs < cfg.tiers[i - 1].resMs || cfg.tiers[i].ttlMs < cfg.tiers[i - 1].ttlMs) {
        throw new RangeError(`${kind}: tiers — resMs и ttlMs должны неубывать (тонкий → грубый)`);
      }
    }
  }
  if (cfg.agg) {
    for (const [f, fn] of Object.entries(cfg.agg)) {
      if (!(f in cfg.columns)) {
        throw new RangeError(`${kind}: agg.${f} — поле не найдено в columns`);
      }
      if (!AGG_FNS.has(fn)) {
        throw new RangeError(`${kind}: agg.${f} — fn min|max|sum|avg|count (получено ${String(fn)})`);
      }
    }
  }
  if (cfg.dims) {
    if (!Array.isArray(cfg.dims) || cfg.dims.length === 0) {
      throw new RangeError(`${kind}: dims — непустой массив полей`);
    }
    for (const f of cfg.dims) {
      if (typeof f !== 'string' || !(f in cfg.columns)) {
        throw new RangeError(`${kind}: dims — поле "${String(f)}" не найдено в columns`);
      }
    }
  }
  if (cfg.storage && cfg.storage.tiers) {
    for (const t of cfg.storage.tiers) {
      if (!t || typeof t.id !== 'string' || !Number.isFinite(t.from) || !Number.isFinite(t.to)) {
        throw new RangeError(`${kind}: storage.tiers — объекты { id, from, to, … }`);
      }
    }
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
