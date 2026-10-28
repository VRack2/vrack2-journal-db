// compaction/types.ts — Base types for the compaction engines.
//
// Engine = the strategy of HOW compact() merges rows from multiple
// segments on merge (see Engine.ts). This file is types only, used by
// files inside compaction/. No behavior here.

// Row — the base journal row type; re-exported so the compaction/ API
// (Engine.merge, etc.) is self-contained.
export type { Row } from '../core/types.ts';

/** Compaction engine identifiers. */
export type EngineKind = 'log' | 'upsert' | 'summing' | 'collapsing';
