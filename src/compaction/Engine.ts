// compaction/Engine.ts — Base class for the compaction engines.
//
// Shared by all engines: the descriptor (merge parameters) and the common logic —
// numeric value of a field, grouping by the identity key, picking the "freshest"
// row in a group. The specifics — abstract merge() — live in each subclass.
//
// A new engine = a class extending Engine and implementing merge() (Log/Upsert/
// Summing/Collapsing are examples). kind→class routing is in Journal.ts.

import type { Row, EngineKind } from './types.ts';
import type { Descriptor } from './Descriptor.ts';

  /** All engine kinds (for errors/docs). */
export const ENGINE_KINDS: readonly EngineKind[] = ['log', 'upsert', 'summing', 'collapsing'];

export abstract class Engine {
  readonly kind: EngineKind;
  protected readonly desc: Descriptor;

  constructor(kind: EngineKind, desc: Descriptor) {
    this.kind = kind;
    this.desc = desc;
  }

  /** Apply the strategy to the rows (in write order) and return the rows for the merged segment. */
  abstract merge(rows: Row[]): Row[];

  // --- shared (formerly engines/util.ts) --------------------------------------

  /** Numeric value of a field; non-number/NaN → 0. */
  protected num(row: Row, field: string): number {
    const v = row[field];
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Numeric "newness" value; no version → 0. */
  protected versionOf(row: Row): number {
    return this.desc.version ? this.num(row, this.desc.version) : 0;
  }

  /** Stable key string from the desc.key fields (distinguishes types and nested values). */
  protected keyOf(row: Row): string {
    const key = this.desc.key ?? [];
    if (key.length === 0) return '';
    return key.map(f => JSON.stringify(row[f] ?? null)).join('\u0000');
  }

  /** Group rows by the identity key (order-preserving groups). */
  protected groupByKey(rows: Row[]): Map<string, Row[]> {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const k = this.keyOf(row);
      const arr = groups.get(k);
      if (arr) arr.push(row);
      else groups.set(k, [row]);
    }
    return groups;
  }

  /** The "base" row in a group: max(version), or the last by order (if there is no version). */
  protected baseRow(group: Row[]): Row | undefined {
    if (group.length === 0) return undefined;
    if (!this.desc.version) return group[group.length - 1];
    let best = group[0];
    let bestV = this.versionOf(best);
    for (let i = 1; i < group.length; i++) {
      const v = this.versionOf(group[i]);
      if (v > bestV) {
        best = group[i];
        bestV = v;
      }
    }
    return best;
  }
}
