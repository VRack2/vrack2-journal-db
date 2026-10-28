// table/TableDef.ts — retention/tier definition rules for Table.
//
// Parses the 'res:ttl,…' retention string into resolution tiers and
// validates explicit tier arrays. The rules and their TBL_* error codes
// live here so Table keeps only the runtime (journals, queries, rollup).

import { Interval } from '../core/Interval.ts';
import type { ResolutionTier } from '../core/types.ts';
import ErrorManager from '../errors/ErrorManager.ts';

ErrorManager.registerMany('Table', [
  { short: 'TBL_RETENTION_STRING', description: 'Table: retention — non-empty string, e.g. "5s:1d,15s:1w,1m:1mon"' },
  { short: 'TBL_RETENTION_EMPTY', description: 'Table: retention — at least one tier in "res:ttl" form' },
  { short: 'TBL_RETENTION_TIER_FORMAT', description: 'Table: retention — tier in "res:ttl" format', rules: { part: 'string' } },
  { short: 'TBL_RETENTION_RES', description: 'Table: retention — resolution', rules: { res: 'string', message: 'string' } },
  { short: 'TBL_RETENTION_TTL', description: 'Table: retention — ttl', rules: { ttl: 'string', message: 'string' } },
  { short: 'TBL_RETENTION_RES_POS', description: 'Table: retention — res must be > 0', rules: { part: 'string' } },
  { short: 'TBL_RETENTION_TTL_POS', description: 'Table: retention — ttl must be > 0', rules: { part: 'string' } },
  { short: 'TBL_RETENTION_RES_ASC', description: 'Table: retention — resolutions must be non-decreasing left to right (fine → coarse)' },
  { short: 'TBL_RETENTION_TTL_ASC', description: 'Table: retention — ttl must be non-decreasing left to right' },
  { short: 'TBL_TIERS_EMPTY', description: 'Table: tiers — non-empty array' },
  { short: 'TBL_TIERS_RES_POS', description: 'Table: tiers — resMs must be > 0' },
  { short: 'TBL_TIERS_TTL_POS', description: 'Table: tiers — ttlMs must be > 0' },
  { short: 'TBL_TIERS_RES_ASC', description: 'Table: tiers — resolutions must be non-decreasing (fine → coarse)' },
  { short: 'TBL_TIERS_TTL_ASC', description: 'Table: tiers — ttl must be non-decreasing (by increasing age)' },
]);

export class TableDef {
  /** Parses a retention string '5s:1d,15s:1w' into tiers (fine → coarse). */
  static parseRetention(retention: string): ResolutionTier[] {
    const s = String(retention).trim();
    if (!s) {
      throw ErrorManager.make('TBL_RETENTION_STRING');
    }
    const parts = s.split(',').map(p => p.trim()).filter(p => p.length > 0);
    if (parts.length === 0) {
      throw ErrorManager.make('TBL_RETENTION_EMPTY');
    }
    const tiers: ResolutionTier[] = [];
    for (const part of parts) {
      const m = part.match(/^(\S+):(\S+)$/);
      if (!m) {
        throw ErrorManager.make('TBL_RETENTION_TIER_FORMAT', { part });
      }
      let resMs: number;
      let ttlMs: number;
      try {
        resMs = Interval.parseInterval(m[1]);
      } catch (e) {
        throw ErrorManager.make('TBL_RETENTION_RES', { res: m[1], message: (e as Error).message });
      }
      try {
        ttlMs = Interval.parseInterval(m[2]);
      } catch (e) {
        throw ErrorManager.make('TBL_RETENTION_TTL', { ttl: m[2], message: (e as Error).message });
      }
      if (!Number.isFinite(resMs) || resMs <= 0) {
        throw ErrorManager.make('TBL_RETENTION_RES_POS', { part });
      }
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw ErrorManager.make('TBL_RETENTION_TTL_POS', { part });
      }
      tiers.push({ resMs, ttlMs });
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].resMs < tiers[i - 1].resMs) {
        throw ErrorManager.make('TBL_RETENTION_RES_ASC');
      }
      if (tiers[i].ttlMs < tiers[i - 1].ttlMs) {
        throw ErrorManager.make('TBL_RETENTION_TTL_ASC');
      }
    }
    return tiers;
  }

  static validateTiers(tiers: ResolutionTier[]): void {
    if (!tiers || tiers.length === 0) throw ErrorManager.make('TBL_TIERS_EMPTY');
    for (const t of tiers) {
      if (!Number.isFinite(t.resMs) || t.resMs <= 0) {
        throw ErrorManager.make('TBL_TIERS_RES_POS');
      }
      if (!Number.isFinite(t.ttlMs) || t.ttlMs <= 0) {
        throw ErrorManager.make('TBL_TIERS_TTL_POS');
      }
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].resMs < tiers[i - 1].resMs) {
        throw ErrorManager.make('TBL_TIERS_RES_ASC');
      }
      if (tiers[i].ttlMs < tiers[i - 1].ttlMs) {
        throw ErrorManager.make('TBL_TIERS_TTL_ASC');
      }
    }
  }
}
