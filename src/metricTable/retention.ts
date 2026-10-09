// Фаза 2 — retention: разбор политики «res:ttl,res:ttl» в массив тиров.
//
// Канонический парсер — parseRetention в src/table.ts (там же и валидация
// неубывания res/ttl). Здесь — фасад для движков, чтобы MergeTree и внешние
// вызовы не заглядывали внутрь table.ts.

import type { ResolutionTier } from '../types.ts';
import { parseRetention } from '../table.ts';

export type { ResolutionTier };

/**
 * Разбирает retention-политику (напр. '5s:1d,15s:1w,1m:1mon') в массив тиров
 * от тонкого к грубому. Бросает RangeError на невалидной политике.
 */
export function tiersForRetention(retention: string): ResolutionTier[] {
  return parseRetention(retention);
}

/**
 * Валидирует явный массив тиров (res/ttl > 0, неубывающие). Каноника —
 * Table.validateTiers; дублируем здесь, чтобы retention.ts был самодостаточным
 * модулем движков (не тянет table.ts ради одной статической проверки).
 */
export function validateTiers(tiers: ResolutionTier[]): void {
  if (tiers.length === 0) throw new RangeError('retention: tiers — непустой массив');
  for (const t of tiers) {
    if (!Number.isFinite(t.resMs) || t.resMs <= 0) {
      throw new RangeError('retention: tiers — resMs должно быть > 0');
    }
    if (!Number.isFinite(t.ttlMs) || t.ttlMs <= 0) {
      throw new RangeError('retention: tiers — ttlMs должно быть > 0');
    }
  }
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].resMs < tiers[i - 1].resMs) {
      throw new RangeError('retention: tiers — разрешения должны неубывать (тонкий → грубый)');
    }
    if (tiers[i].ttlMs < tiers[i - 1].ttlMs) {
      throw new RangeError('retention: tiers — ttl должны неубывать (по возрастанию возраста)');
    }
  }
}
