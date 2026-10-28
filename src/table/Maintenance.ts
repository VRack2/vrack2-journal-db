// table/Maintenance.ts — throttled auto-rollup/auto-purge on append.
//
// At most one maintenance pass per minIntervalMs (0 disables throttling).
// Errors are logged and never break append().

import type { Journal } from '../journal/Journal.ts';
import type { ResolutionTier } from '../core/types.ts';

// 10 min by default: keeps per-pass file churn (segment/meta/WAL/checkpoint
// writes) ~20x lower under low-rate ingest while still bounding lag.
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 600_000;

interface MaintenanceOptions {
  /** Table name (for the error log). */
  name: string;
  /** Tier journals, fine → coarse. */
  journals: Journal[];
  /** Tier definitions (same length as journals). */
  tiers: ResolutionTier[];
  autoRollup: boolean;
  autoPurge: boolean;
  minIntervalMs: number;
  nowProvider: () => number;
  /** The table's rollup pass (throws are caught here). */
  rollup: (now: number) => void;
}

export class Maintenance {
  private readonly name: string;
  private readonly journals: Journal[];
  private readonly tiers: ResolutionTier[];
  private readonly autoRollup: boolean;
  private readonly autoPurge: boolean;
  private readonly minIntervalMs: number;
  private readonly nowProvider: () => number;
  private readonly rollup: (now: number) => void;
  private lastRun: number;

  constructor(opts: MaintenanceOptions) {
    this.name = opts.name;
    this.journals = opts.journals;
    this.tiers = opts.tiers;
    this.autoRollup = opts.autoRollup;
    this.autoPurge = opts.autoPurge;
    this.minIntervalMs = opts.minIntervalMs;
    this.nowProvider = opts.nowProvider;
    this.rollup = opts.rollup;
    // Start the throttling window at creation — no maintenance on the first append.
    this.lastRun = opts.nowProvider();
  }

  maybeMaintain(): void {
    if (!this.autoRollup && !this.autoPurge) return;
    const now = this.nowProvider();
    if (now - this.lastRun < this.minIntervalMs) return;
    this.lastRun = now;

    if (this.autoRollup) {
      try {
        this.rollup(now);
      } catch (e) {
        console.error(`Table ${this.name}: auto-rollup failed:`, e);
      }
    }
    if (this.autoPurge) {
      const i = this.tiers.length - 1;
      try {
        this.journals[i].purge(now - this.tiers[i].ttlMs);
      } catch (e) {
        console.error(`Table ${this.name}: tier ${i} auto-purge failed:`, e);
      }
    }
  }
}
