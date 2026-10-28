// table/RollupManager.ts — resolution-tier rollup for Table.
//
// Moves aged-out data from each fine tier journal to the next coarser one
// (page-wise accumulate + promote), then purges the fine tier. Idempotent
// by checkpoint ('<i>-><i+1>' → ts watermark persisted in _rollup.json).

import fs from 'node:fs';
import type { Journal } from '../journal/Journal.ts';
import { Rollup } from '../metric/Rollup.ts';
import type { RollupConfig } from '../metric/Rollup.ts';
import { AtomicJson } from '../core/AtomicJson.ts';
import type { AggFn, ResolutionTier, RollupReport } from '../core/types.ts';
import ErrorManager from '../errors/ErrorManager.ts';

ErrorManager.registerMany('Table', [
  { short: 'TBL_ROLLUP_NO_TIERS', description: 'Table: rollup() — table without retention (no tiers)' },
  { short: 'TBL_ROLLUP_NOW', description: 'Table: rollup(now) — now: a finite number (ms)' },
  { short: 'TBL_ROLLUP_ONE_NO_TIERS', description: 'Table: rollupOne() — table without retention (no tiers)' },
  { short: 'TBL_ROLLUP_ONE_NOW', description: 'Table: rollupOne(now) — now: a finite number (ms)' },
  { short: 'TBL_ROLLUP_ONE_RES', description: 'Table: rollupOne() — res does not match a tier (or tier 0)', rules: { res: 'number' } },
]);

export interface RollupOneReport {
  tierIndex: number;
  resMs: number;
  fromMs: number;
  toMs: number;
  sourceRows: number;
  promotedRows: number;
}

interface RollupManagerOptions {
  /** Tier journals, fine → coarse (single journal for a non-tier table). */
  journals: Journal[];
  /** null — table without retention. */
  tiers: ResolutionTier[] | null;
  agg: Record<string, AggFn>;
  dims: string[];
  /** Checkpoint file path ('' for non-tier tables). */
  cpPath: string;
  nowProvider: () => number;
}

export class RollupManager {
  private readonly journals: Journal[];
  private readonly tiers: ResolutionTier[] | null;
  private readonly agg: Record<string, AggFn>;
  private readonly dims: string[];
  private readonly cpPath: string;
  private readonly nowProvider: () => number;
  private checkpoints: Record<string, number>;

  constructor(opts: RollupManagerOptions) {
    this.journals = opts.journals;
    this.tiers = opts.tiers;
    this.agg = opts.agg;
    this.dims = opts.dims;
    this.cpPath = opts.cpPath;
    this.nowProvider = opts.nowProvider;
    this.checkpoints = RollupManager.readCheckpoints(opts.cpPath);
  }

  /**
   * Move aged-out data from each fine tier to the next coarser one (downsample +
   * agg), then purge the fine tier. Idempotent by checkpoint. Tier mode only.
   */
  rollup(now?: number): RollupReport {
    if (!this.tiers) {
      throw ErrorManager.make('TBL_ROLLUP_NO_TIERS');
    }
    const nowTs = typeof now === 'number' ? now : this.nowProvider();
    if (!Number.isFinite(nowTs)) throw ErrorManager.make('TBL_ROLLUP_NOW');

    let pairs = 0;
    let rolledRows = 0;
    let purgedRows = 0;

    for (let i = 0; i + 1 < this.tiers.length; i++) {
      const fine = this.journals[i];
      const coarse = this.journals[i + 1];
      const fineTtl = this.tiers[i].ttlMs;
      const coarseRes = this.tiers[i + 1].resMs;
      const maxRollable = nowTs - fineTtl;
      const cpKey = `${i}->${i + 1}`;
      const cp = this.checkpoints[cpKey] ?? 0;
      if (maxRollable <= cp) continue;

      const { sourceRows } = this.rollupWindow(fine, coarse, cp, maxRollable, coarseRes, this.agg, this.dims);

      // Checkpoint before purge — makes a repeat rollup idempotent.
      this.checkpoints[cpKey] = maxRollable;
      this.saveCheckpoints();

      const purged = fine.purge(maxRollable + 1);
      purgedRows += purged.removedRows ?? 0;
      pairs++;
      rolledRows += sourceRows;
    }

    return { pairs, rolledRows, purgedRows };
  }

  /** Rollup into one target tier (by resolution res). Tier mode only. */
  rollupOne(cfgOrNow: RollupConfig | number, now?: number): RollupOneReport {
    if (!this.tiers) {
      throw ErrorManager.make('TBL_ROLLUP_ONE_NO_TIERS');
    }
    let cfg: RollupConfig;
    let nowTs: number;
    if (typeof cfgOrNow === 'number') {
      cfg = { agg: this.agg, dims: this.dims, res: 15_000 };
      nowTs = cfgOrNow;
      if (now !== undefined) nowTs = now;
    } else {
      cfg = cfgOrNow;
      nowTs = now !== undefined ? now : this.nowProvider();
    }
    if (!Number.isFinite(nowTs)) throw ErrorManager.make('TBL_ROLLUP_ONE_NOW');

    const targetIdx = this.tiers.findIndex(t => t.resMs === cfg.res);
    if (targetIdx <= 0) {
      throw ErrorManager.make('TBL_ROLLUP_ONE_RES', { res: cfg.res });
    }
    const fineIdx = targetIdx - 1;
    const fine = this.journals[fineIdx];
    const coarse = this.journals[targetIdx];
    const fineTtl = this.tiers[fineIdx].ttlMs;
    const maxRollable = nowTs - fineTtl;
    const cpKey = `${fineIdx}->${targetIdx}`;
    const cp = this.checkpoints[cpKey] ?? 0;
    if (maxRollable <= cp) {
      return {
        tierIndex: targetIdx, resMs: cfg.res, fromMs: cp, toMs: maxRollable,
        sourceRows: 0, promotedRows: 0,
      };
    }

    const { sourceRows, promotedRows } = this.rollupWindow(fine, coarse, cp, maxRollable, cfg.res, cfg.agg, cfg.dims);

    this.checkpoints[cpKey] = maxRollable;
    this.saveCheckpoints();

    const purged = fine.purge(maxRollable + 1);
    void purged;

    return {
      tierIndex: targetIdx,
      resMs: cfg.res,
      fromMs: cp,
      toMs: maxRollable,
      sourceRows,
      promotedRows,
    };
  }

  /** Drop watermarks and the checkpoint file (after truncate). */
  reset(): void {
    this.checkpoints = {};
    if (this.cpPath) {
      fs.rmSync(this.cpPath, { force: true });
    }
  }

  /**
   * Reads the rollable window (cp, maxRollable] page-by-page (each page = one
   * `res` wide) and accumulates incrementally, so peak memory is bounded by the
   * number of buckets, not by the number of fine-tier rows (no OOM under load).
   * Pages are (cursor, end] with the inclusive scan bounds, so no row is counted
   * twice and none is missed. Promotes the resulting buckets to `coarse`.
   */
  private rollupWindow(fine: Journal, coarse: Journal, cp: number, maxRollable: number, res: number, agg: Record<string, AggFn>, dims: string[]): { sourceRows: number; promotedRows: number } {
    const acc = Rollup.accumulate({ agg, dims, res });
    let sourceRows = 0;
    // Fresh table (no checkpoint): start at the oldest fine-tier row, not the
    // epoch — stepping res-pages from 1970 means ~10^7 empty scans (~15s).
    // An empty tier has nothing to roll up: start past the window (loop skips).
    // Pages are (cursor, end], so minTs - 1 keeps the row at exactly minTs.
    const range = fine.getTimeRange();
    let cursor = range === null ? maxRollable : Math.max(cp, range[0] - 1);
    while (cursor < maxRollable) {
      const pageEnd = Math.min(cursor + res, maxRollable);
      // No error swallowing: a failed page must abort the rollup BEFORE the
      // checkpoint advances, otherwise the window's rows are lost while the
      // watermark claims they were promoted.
      const page = fine.scan({ start: cursor, end: pageEnd });
      for (const r of page) {
        const ts = r['ts'];
        if (typeof ts === 'number' && Number.isFinite(ts) && ts > cursor && ts <= pageEnd) {
          acc.add(r);
          sourceRows++;
        }
      }
      cursor = pageEnd;
    }
    const promoted = acc.finalize();
    for (const outRow of promoted) coarse.append(outRow);
    if (promoted.length > 0) coarse.flush();
    return { sourceRows, promotedRows: promoted.length };
  }

  private static readCheckpoints(cpPath: string): Record<string, number> {
    if (!cpPath) return {};
    const obj = AtomicJson.read(cpPath);
    if (obj === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number') out[k] = v;
    }
    return out;
  }

  private saveCheckpoints(): void {
    AtomicJson.write(this.cpPath, this.checkpoints, { mkdir: true });
  }
}
