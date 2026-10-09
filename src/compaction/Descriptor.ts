// ============================================================
// compaction/Descriptor.ts — Описание движка компактизации
//
// Ровно то, что compact() нужно для слияния строк. Хранится в metadata
// журнала (под ключом ENGINE_META_KEY) и в манифесте _store.json.
//
// Сериализация (toMeta / fromMeta) — часть самого описания, поэтому живёт
// здесь, а не в types.ts и не в разбросанных функциях.
// ============================================================

import type { JsonObject } from '../types.ts';
import type { EngineKind } from './types.ts';

/** Ключ в metadata журнала, под которым лежит дескриптор движка. */
export const ENGINE_META_KEY = '_engine';

/** Нормализованное описание движка — параметры слияния. */
export class Descriptor {
  readonly kind: EngineKind;
  /** identity-ключ строки (upsert/summing/collapsing) — поля, по которым группируются строки. */
  readonly key?: string[];
  /** колонка «новизны» (upsert обязательна): строка с max(version) побеждает. */
  readonly version?: string;
  /** числовые колонки, которые суммируются (summing). */
  readonly sum?: string[];
  /** колонка знака +1/-1 (collapsing). */
  readonly sign?: string;

  constructor(init: {
    kind: EngineKind;
    key?: string[];
    version?: string;
    sum?: string[];
    sign?: string;
  }) {
    this.kind = init.kind;
    this.key = init.key;
    this.version = init.version;
    this.sum = init.sum;
    this.sign = init.sign;
  }

  /** Чисто-сериграфическое JsonObject для metadata/манифеста (только присутствующие поля). */
  toMeta(): JsonObject {
    const o: JsonObject = { kind: this.kind };
    if (this.key) o.key = this.key;
    if (this.version) o.version = this.version;
    if (this.sum) o.sum = this.sum;
    if (this.sign) o.sign = this.sign;
    return o;
  }

  /** Из metadata: вернёт Descriptor либо undefined, если движка нет/данные битые. */
  static fromMeta(raw: unknown): Descriptor | undefined {
    if (raw === null || typeof raw !== 'object' || !('kind' in raw)) return undefined;
    const d = raw as Record<string, unknown>;
    if (d.kind !== 'log' && d.kind !== 'upsert' && d.kind !== 'summing' && d.kind !== 'collapsing') {
      return undefined;
    }
    return new Descriptor({
      kind: d.kind as EngineKind,
      key: Array.isArray(d.key) && d.key.every(k => typeof k === 'string') ? (d.key as string[]) : undefined,
      version: typeof d.version === 'string' ? d.version : undefined,
      sum: Array.isArray(d.sum) && d.sum.every(s => typeof s === 'string') ? (d.sum as string[]) : undefined,
      sign: typeof d.sign === 'string' ? d.sign : undefined,
    });
  }
}
