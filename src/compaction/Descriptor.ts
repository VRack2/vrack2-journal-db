// compaction/Descriptor.ts — Description of a compaction engine.
//
// Exactly what compact() needs to merge rows. Stored in the journal
// metadata (under ENGINE_META_KEY) and in the _store.json manifest.
//
// Serialization (toMeta / fromMeta) — part of the description itself,
// so it lives here, not in types.ts and not in scattered functions.

import type { JsonObject } from '../core/types.ts';
import type { EngineKind } from './types.ts';

  /** Key in the journal metadata where the engine descriptor is stored. */
export const ENGINE_META_KEY = '_engine';

  /** Key in the journal metadata where the cluster key (dimension fields) is stored. */
export const CLUSTER_META_KEY = '_cluster';

/** Journal-metadata value → validated cluster key, or null when absent/corrupt. */
export function parseClusterKey(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((f) => typeof f === 'string' && f.length > 0)) return null;
  return raw.slice();
}

  /** Normalized description of the engine — merge parameters. */
export class Descriptor {
  readonly kind: EngineKind;
  /** Row identity key (upsert/summing/collapsing) — fields rows are grouped by. */
  readonly key?: string[];
  /** "newness" column (required for upsert): the row with max(version) wins. */
  readonly version?: string;
  /** Numeric columns that are summed (summing). */
  readonly sum?: string[];
  /** +1/-1 sign column (collapsing). */
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

  /** Purely serializable JsonObject for metadata/manifest (only present fields). */
  toMeta(): JsonObject {
    const o: JsonObject = { kind: this.kind };
    if (this.key) o.key = this.key;
    if (this.version) o.version = this.version;
    if (this.sum) o.sum = this.sum;
    if (this.sign) o.sign = this.sign;
    return o;
  }

  /** From metadata: returns a Descriptor, or undefined if there is none / the data is corrupt. */
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
