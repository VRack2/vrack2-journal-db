// RetentionEngine.ts — retention tiers
//
// Closed Journal segments live in tiers by data age:
//   0-7d    f64 + raw        (1h block)
//   7-30d   doubleDelta + raw (1h block)
//   30-365d gorilla + raw   (1d block)
//   365d+   rle + gzip + tsDelta (1d block)
//
// Engine:
//   - status()      — how many segments/bytes/rows are in each tier;
//   - plan()        — what to re-encode/merge (dry-run);
//   - apply()       — re-encodes segments into tiers and merges blocks
//                     (1h → 1d) without data loss (dedup at boundaries);
//   - compactTier() — block merging in a single tier only.
//
// Lossless conversion: data is read from the segment and rewritten
// into a new file in full; dedup (segment.append) works as in compact.
//
// The Journal.ts ↔ RetentionEngine.ts cycle is excluded via the RetentionHost interface:
// Journal implements it structurally, the Journal class is not imported.

import fs from 'node:fs';
import path from 'node:path';
import { Segment } from './Segment.ts';
import { SegmentFileV3 } from './SegmentFileV3.ts';
import type { CompressionKind } from './types.ts';
import type {
  ApplyReport,
  CompactTierReport,
  ConversionPlan,
  RetentionTier,
  SegmentEncoding,
  TierStatus,
} from './types.ts';
import ErrorManager from './errors/ErrorManager.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

ErrorManager.registerMany('RetentionEngine', [
  { short: 'RET_HOST', description: 'RetentionEngine: host (journal) is required' },
  { short: 'RET_TIER_UNKNOWN', description: 'Unknown tier', rules: { tierId: 'string' } },
]);

/**
  * The part of a Journal that RetentionEngine works with.
  * Journal implements it structurally (duck typing), so RetentionEngine
// does not import the Journal class (dependency only "downward" — no cycle).
 */
export interface RetentionHost {
  /** Journal directory on disk. */
  journalPath(): string;
  /** IDs of closed segments in chronological order. */
  closedSegmentIds(): string[];
  /** Segment bounds + counters — null if unknown. */
  closedSegmentInfo(id: string): {
    minTs: number | null; maxTs: number | null;
    rowCount: number | null; physicalRowCount: number | null; bytes: number | null;
  } | null;
  /** Name of the segment file on disk — null if unknown. */
  closedSegmentFile(id: string): string | null;
  /** Closed segment from cache/disk. */
  getClosedSegment(id: string): Segment;
  /** Merges closed segments (dedup at boundaries). */
  mergeClosedSegments(ids: string[], encode: (seg: Segment) => Buffer): string;
  /** Re-encodes a closed segment (same data, new codec/compression). */
  reencodeClosedSegment(id: string, encode: (seg: Segment) => Buffer): string;
}

const NOT_V3: SegmentEncoding = { v3: false, compression: '', codecs: {} };

/**
  * Retention engine: re-encodes closed segments into tiers by data age
  * and merges blocks (1h → 1d). Does not touch the active segment.
  *
  *   const eng = journal.retention;          // default tiers
  *   eng.status();                           // tier status
  *   eng.plan();                             // dry-run
  *   eng.apply();                            // apply
  *   eng.compactTier('archive');             // merging only in a tier
 */
export class RetentionEngine {
  private readonly host: RetentionHost;
  readonly tiers: RetentionTier[];
  private readonly nowProvider: () => number;
  private readonly encCache = new Map<string, SegmentEncoding>();

  constructor(host: RetentionHost, tiers?: RetentionTier[], nowProvider?: () => number) {
    if (!host) throw ErrorManager.make('RET_HOST');
    this.host = host;
    this.tiers = (tiers ?? RetentionEngine.defaultTiers())
      .slice()
      .sort((a, b) => a.from - b.from);
    this.nowProvider = nowProvider ?? (() => Date.now());
  }

  /**
    * Default tiers (see docs/metrics-engine-plan.md, phase 4):
    * 0-7d f64+raw; 7-30d doubleDelta+raw; 30-365d gorilla+raw; 365d+ rle+gzip+tsDelta.
    * Blocks: 1h for fresh data, 1d for old data (1h → 1d).
   */
  static defaultTiers(): RetentionTier[] {
    return [
      { id: 'hot',     from: 0,         to: 7 * DAY,     codec: 'f64',         block: 1 * HOUR, compress: 'none', minInterval: 0, tsDelta: false },
      { id: 'warm',    from: 7 * DAY,   to: 30 * DAY,    codec: 'doubleDelta', block: 1 * HOUR, compress: 'none', minInterval: 0, tsDelta: false },
      { id: 'cold',    from: 30 * DAY,  to: 365 * DAY,   codec: 'gorilla',     block: 1 * DAY,  compress: 'none', minInterval: 0, tsDelta: false },
      { id: 'archive', from: 365 * DAY, to: Infinity,    codec: 'rle',         block: 1 * DAY,  compress: 'gzip', minInterval: 0, tsDelta: true },
    ];
  }

  /** Current time (for computing age). */
  now(): number {
    return this.nowProvider();
  }

  /** Tier for an age (ms). */
  tierForAge(ageMs: number): RetentionTier {
    for (const t of this.tiers) {
      if (ageMs >= t.from && ageMs < t.to) return t;
    }
    return this.tiers[this.tiers.length - 1]; // the oldest
  }

  /** Tier for a data timestamp. */
  tierForTs(ts: number): RetentionTier {
    return this.tierForAge(Math.max(0, this.now() - ts));
  }

  /**
    * Current encoding of a closed segment (from the v3 header): format,
    * compression, numeric codecs. null if the segment/file is unknown.
   */
  encodingOf(segId: string): SegmentEncoding | null {
    const file = this.host.closedSegmentFile(segId);
    if (!file) return null;
    let ins = this.encCache.get(segId);
    if (!ins) {
      ins = RetentionEngine.inspectSegFile(path.join(this.host.journalPath(), file));
      this.encCache.set(segId, ins);
    }
    return ins;
  }

  /** Tier status: segments/bytes/rows/ts range. */
  status(now?: number): TierStatus[] {
    const t = now ?? this.now();
    const out = new Map<string, TierStatus>();
    for (const tier of this.tiers) {
      out.set(tier.id, {
        id: tier.id, from: tier.from, to: tier.to,
        segments: 0, bytes: 0, rows: 0, oldestTs: null, newestTs: null,
      });
    }
    for (const id of this.host.closedSegmentIds()) {
      const info = this.host.closedSegmentInfo(id);
      if (!info || info.maxTs === null) continue;
      const tier = this.tierForAge(Math.max(0, t - info.maxTs));
      const s = out.get(tier.id);
      if (!s) continue;
      s.segments++;
      s.bytes += info.bytes ?? 0;
      s.rows += info.rowCount ?? 0;
      if (info.minTs !== null && (s.oldestTs === null || info.minTs < s.oldestTs)) s.oldestTs = info.minTs;
      if (info.maxTs !== null && (s.newestTs === null || info.maxTs > s.newestTs)) s.newestTs = info.maxTs;
    }
    return [...out.values()];
  }

  /** Plan item for a single segment. */
  private planOne(id: string, t: number, tier: RetentionTier): { action: 'none' | 'reencode'; ins: SegmentEncoding } {
    const file = this.host.closedSegmentFile(id);
    let ins = this.encCache.get(id);
    if (!ins) {
      ins = file ? RetentionEngine.inspectSegFile(path.join(this.host.journalPath(), file)) : NOT_V3;
      this.encCache.set(id, ins);
    }
    const seg = this.host.getClosedSegment(id);
    const action = RetentionEngine.matchesTier(ins, tier, seg) ? 'none' : 'reencode';
    return { action, ins };
  }

  /**
    * Plan (dry-run): for each block group of a tier — 'merge' (if group ≥ 2),
    * otherwise 'reencode' (if the encoding does not match the tier), otherwise 'none'.
   */
  plan(now?: number): ConversionPlan[] {
    const t = now ?? this.now();
    const groups = this.groupByTier(t);
    const plans: ConversionPlan[] = [];
    for (const g of groups) {
      const needMerge = g.ids.length >= 2;
      for (const id of g.ids) {
        const { action } = this.planOne(id, t, g.tier);
        plans.push({
          segId: id,
          tier: g.tier.id,
          action: needMerge ? 'merge' : action,
          targetCodec: g.tier.codec,
          targetCompress: g.tier.compress,
          groupSize: g.ids.length,
        });
      }
    }
    return plans;
  }

  /** Applies retention: re-encoding into tiers + block merging (1h → 1d). */
  apply(now?: number): ApplyReport {
    const t = now ?? this.now();
    const groups = this.groupByTier(t);
    let reencoded = 0, merged = 0, skipped = 0;
    const beforeSegments = this.host.closedSegmentIds().length;
    const beforeBytes = this.totalBytes();

    for (const g of groups) {
      if (g.ids.length >= 2) {
        // Merging the tier's blocks: dedup at boundaries + the tier's codec/compression
        this.host.mergeClosedSegments(g.ids, seg => this.encodeForTier(g.tier, seg));
        merged++;
      } else {
        const id = g.ids[0];
        const { action } = this.planOne(id, t, g.tier);
        if (action === 'none') {
          skipped++;
          continue;
        }
        this.host.reencodeClosedSegment(id, seg => this.encodeForTier(g.tier, seg));
        reencoded++;
      }
    }

    this.encCache.clear();
    const afterSegments = this.host.closedSegmentIds().length;
    const afterBytes = this.totalBytes();
    return { reencoded, merged, skipped, beforeSegments, afterSegments, beforeBytes, afterBytes };
  }

  /** Compacting a single tier: block merging only (no re-encoding of singletons). */
  compactTier(tierId: string, now?: number): CompactTierReport {
    const t = now ?? this.now();
    const tier = this.tiers.find(x => x.id === tierId);
    if (!tier) throw ErrorManager.make('RET_TIER_UNKNOWN', { tierId });
    const groups = this.groupByTier(t).filter(g => g.tier.id === tierId);
    let mergedGroups = 0;
    const beforeSegments = this.host.closedSegmentIds().length;
    for (const g of groups) {
      if (g.ids.length >= 2) {
        this.host.mergeClosedSegments(g.ids, seg => this.encodeForTier(tier, seg));
        mergedGroups++;
      }
    }
    this.encCache.clear();
    const afterSegments = this.host.closedSegmentIds().length;
    return { tier: tierId, mergedGroups, beforeSegments, afterSegments };
  }

  // --------------------------------------------------
  // Internal
  // --------------------------------------------------

  /** Groups closed segments by (tier, block) — for 1h → 1d merging. */
  private groupByTier(t: number): { tier: RetentionTier; blockKey: number; ids: string[] }[] {
    const groups = new Map<string, { tier: RetentionTier; blockKey: number; ids: string[] }>();
    for (const id of this.host.closedSegmentIds()) {
      const info = this.host.closedSegmentInfo(id);
      if (!info || info.minTs === null || info.maxTs === null) continue;
      const tier = this.tierForAge(Math.max(0, t - info.maxTs));
      const blockKey = tier.block > 0 ? Math.floor(info.minTs / tier.block) : 0;
      const key = `${tier.id}:${blockKey}`;
      let g = groups.get(key);
      if (!g) { g = { tier, blockKey, ids: [] }; groups.set(key, g); }
      g.ids.push(id);
    }
    return [...groups.values()];
  }

  /** Encodes a segment for a tier: value codec + (opt.) ts delta + compression. */
  private encodeForTier(tier: RetentionTier, segment: Segment): Buffer {
    return SegmentFileV3.encode(segment, {
      compression: tier.compress as CompressionKind,
      codecs: RetentionEngine.buildCodecs(segment, tier),
    });
  }

  private totalBytes(): number {
    let b = 0;
    for (const id of this.host.closedSegmentIds()) {
      b += this.host.closedSegmentInfo(id)?.bytes ?? 0;
    }
    return b;
  }

  // --------------------------------------------------
  // Helpers: data fields and tier codecs
  // --------------------------------------------------

  /** Determines the ts column and the value column (the first numeric one that is not ts). */
  private static pickFields(segment: Segment): { tsField: string | null; valueField: string | null } {
    const fields = Object.keys(segment.schema);
    const tsField = fields.includes('ts') ? 'ts' : null;
    let valueField: string | null = null;
    for (const f of fields) {
      if (f === tsField) continue;
      if (!segment.columns[f]) continue;
      let numeric = true, seen = false;
      const n = Math.min(segment.rowCount, 64);
      for (let i = 0; i < n; i++) {
        const v = segment.get(f, i);
        if (v === null || v === undefined) continue;
        seen = true;
        if (typeof v !== 'number') { numeric = false; break; }
      }
      if (numeric && seen) { valueField = f; break; }
    }
    return { tsField, valueField };
  }

  /** Codecs for a segment per tier: value → tier.codec, ts → doubleDelta (if tsDelta). */
  private static buildCodecs(segment: Segment, tier: RetentionTier): Record<string, string> {
    const { tsField, valueField } = RetentionEngine.pickFields(segment);
    const codecs: Record<string, string> = {};
    if (valueField) codecs[valueField] = tier.codec;
    if (tier.tsDelta && tsField) codecs[tsField] = 'doubleDelta';
    return codecs;
  }

  // --------------------------------------------------
  // Helpers: current encoding of the segment file
  // --------------------------------------------------

  /** Reads the v3 file header (magic + headerLen + header) without loading the blobs. */
  private static inspectSegFile(filePath: string): SegmentEncoding {
    let fd: number | null = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const head = Buffer.alloc(12);
      const n = fs.readSync(fd, head, 0, 12, 0);
      if (n < 12) return NOT_V3;
      if (!head.subarray(0, 4).equals(Buffer.from('JSDB', 'ascii')) || head[4] !== 3) {
        return NOT_V3;
      }
      const headerLen = head.readUInt32LE(8);
      const hbuf = Buffer.alloc(headerLen);
      fs.readSync(fd, hbuf, 0, headerLen, 12);
      const header = JSON.parse(hbuf.toString('utf-8'));
      const codecs: Record<string, string> = {};
      if (header.columns && typeof header.columns === 'object') {
        for (const [f, spec] of Object.entries(header.columns)) {
          if (spec && typeof spec === 'object' && (spec as { kind?: string }).kind === 'numeric') {
            const c = (spec as { codec?: string }).codec;
            if (typeof c === 'string') codecs[f] = c;
          }
        }
      }
      return { v3: true, compression: header.compression ?? 'gzip', codecs };
    } catch {
      return NOT_V3;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  /** Does the current encoding match the tier? */
  private static matchesTier(ins: SegmentEncoding, tier: RetentionTier, segment: Segment): boolean {
    if (!ins.v3) return false;
    if (ins.compression !== tier.compress) return false;
    const { tsField, valueField } = RetentionEngine.pickFields(segment);
    if (valueField && ins.codecs[valueField] !== tier.codec) return false;
    if (tier.tsDelta && tsField && ins.codecs[tsField] !== 'doubleDelta') return false;
    return true;
  }
}
