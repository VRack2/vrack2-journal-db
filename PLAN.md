# PLAN.md — architectural refactor of vrack2-journal-db (working notes for the agent)

> Self-notes. Execute phases in order. After EVERY phase:
> `npm run typecheck && npm test` (in `ts/`) must be green before the next phase
> and before any commit. `npm test` is a long && chain — run it, don't cherry-pick.
> Baseline: `main` @ 2544558, clean tree, 18 test files run directly against `src/*.ts`
> (node runs TS; `lib/` only for publish). Imports use explicit `.ts` extensions.

## Ground rules
- Public API (`src/index.ts` exports + names in test files) must NOT change.
  Tests import internals too — check `grep -rn "from '\.\./src" ts/test` before moving any file.
- One phase = one commit on `main` (repo style: `refactor(scope): …`, messages in repo language OK).
- RULES.md is binding: one entity per file, dependency direction downward (§9), PascalCase file = class name.
- If a phase balloons, stop at the last green commit and report; do not mix phases.

## Phase A — kill duplicated semantics (no file moves)
Goal: one source of truth for agg-fn sets, where-predicates, tier validation.
1. `src/journal/scan/plan.ts` already owns `whereOne`, `isScanOp`, `SCAN_OPS`.
   → Replace the body of `Table._matchWhere` with a call to a shared predicate.
   NOTE the behavioral difference: `Table._matchWhere` returns `v < target` for numbers only via
   `typeof v === 'number'` but does NOT check `typeof target === 'number'`; `whereOne` checks both.
   Aligning on `whereOne` may change tier-mode `Table.scan` results if callers pass non-numeric
   targets — acceptable (journal semantics win), but run tests and mention it in the commit msg.
   Move `whereOne`/`SCAN_OPS`/`isScanOp` out of `scan/` into a neutral module (Phase A creates
   `src/compaction/…`? NO — neutral = `src/types.ts` is types-only (RULES §6). Put them in
   a new `src/WherePredicate.ts`? Better: `src/journal/scan/` is journal-deep; Table is above
   journal, so Table→plan.ts import is allowed (downward). So: Table imports `whereOne` from
   `./journal/scan/plan.ts`. No new file needed.
2. `AGG_FNS` set exists in `Table.ts` and `compaction/define.ts`; `isAggFn` lives in
   `journal/Aggregation.ts`. → Export/reuse one `isAggFn` (from `journal/Aggregation.ts`)
   everywhere; delete the local sets.
3. `Table.ts` `parseRetention` + `Table.validateTiers` duplicate tier-ordering checks that
   `compaction/define.ts` `validateBase` also performs. → Leave for Phase E (single validator);
   do NOT touch now (validation errors are asserted by tests with specific codes).

## Phase B — file relocation into layers (imports-only changes)
Target layout (git mv + import path rewrites; keep filenames = class names):
```
src/
  core/        types.ts (split later), errors/ stays, Interval.ts, LRUCache.ts, Compression.ts
  format/      Segment.ts, SegmentFile.ts, SegmentFileV2.ts, SegmentFileV3.ts,
               columns/ (moved under format/), numcodecs/ (moved under format/)
  journal/     existing journal/ + RetentionEngine.ts moves HERE (it depends on journal/ internals)
  metric/      Rollup.ts, Percentile.ts
  table/       Table.ts, (Phase E adds: TieredQuery.ts, RollupManager.ts, Maintenance.ts)
  store/       Store.ts
```
Decisions:
- `Interval.ts` is imported by everything → `core/`. `Percentile.ts` → `metric/`.
- `journal/constants.ts`, `journal/errors.ts` stay in journal/.
- `RetentionEngine.ts` → `journal/RetentionEngine.ts` (fixes upward-import from src root).
  Its import of `journal/constants.ts` becomes same-dir.
- Update ALL importers incl. `ts/test/*` and `ts/bin/*`.
- `Store.ts` re-export of `ENGINE_META_KEY` at the bottom (back-compat shim) — check who uses it;
  if only `Store` internals/tests, drop the re-export in this phase and fix importers.

## Phase C — thin down Journal (extract write-path ops)
1. `Journal.purge()` (row-level rewrite loop) → new `journal/Purge.ts` (static class `Purge`
   working on SegmentStore + schema/metadata providers), Journal keeps a 3-line delegation.
2. `Journal.migrateToV3` + `_ensureV3` + `_v3Migrated` → `journal/Migration.ts`.
3. Remove leak accessors `closedSegmentIds/getClosedSegment/closedSegmentFile/closedSegmentInfo/
   newSegmentId/reencodeClosedSegment/mergeClosedSegments` from Journal IF callers (Table.stats,
   Rollup?, tests) can hold the SegmentStore directly. CHECK tests first — if tests call them,
   keep the minimal set, mark `// @internal`.
4. `Journal.stats()` stays (facade-level aggregation is fine).

## Phase D — one codec layer (biggest, do last but carefully)
Problem: v2 path encodes via `columns/*` classes; v3 (`SegmentFileV3`) re-encodes values itself
(NumCodecs + dict), bypassing `Column` → on-disk column type is lost (Store._typeOfColumn
guesses; RetentionEngine.pickFields guesses the numeric field).
Plan:
1. Add to `Column` interface: `encodeBlob(): BlobDesc` / `decodeBlob(reader)` (v3-side),
   implemented per column class; `SegmentFileV3.encode/decode` become container-only
   (magic/header/CRC/compression) delegating per-column bytes.
2. Header stores the actual column type so `_typeOfColumn`/`pickFields` heuristics disappear
   (keep old-file fallback: no type in header → current heuristic).
3. Numerics: keep NumCodecs as the numeric backend used by RawColumn/AutoColumn v3 path —
   do not delete NumCodecs; it becomes internal to columns.
Risk: byte-format compatibility. v3 files must round-trip identically for existing fields;
test-v3-format + test-migration are the guards. If blob layout must change, bump v3 minor
only if needed (header is JSON — adding "type" per column is backward-compatible on read).

## Phase E — split Table (949 → ~facade)
New classes in `src/table/`:
- `RollupManager` — checkpoints (`_rollup.json` read/write), `rollup()`, `rollupOne()`,
  `_rollupWindow` (page-by-page accumulate). Table delegates.
- `TieredQuery` — tier-window splitting for `query()`; the timeline-over-tiers loop.
- `Maintenance` — auto-rollup/auto-purge throttle (`_lastMaintain`, DEFAULT_MAINTENANCE_INTERVAL_MS).
- `validateTableDef` shared by `compaction/define.ts` and `Table` ctor (single validator;
  keep every existing error short-code — tests assert them). Where: `table/TableDef.ts`.
- `parseRetention` → `table/` (or core if format/ needs it — it doesn't).
- shared `AtomicJson` (manifest, `_rollup.json`, `.meta` all duplicate tmp+rename) → `store/AtomicJson.ts`
  used by Store._upsertManifest, RollupManager, SegmentStore.writeMeta.

## Naming follow-up (Phase A rename — decide BEFORE moving files)
- `RetentionTier` (encoding-by-age tiers) → `EncodingTier`? It's EXPORTED in index.ts/types
  (`RetentionTier` type export) — public rename breaks API. DECISION: do NOT rename in-repo
  public type; instead doc-comment the distinction and rename only internal usages if trivial.
  (If a rename is ever wanted, it's a semver-major change — out of scope.)
- Keep `ResolutionTier` (also public).
This kills the "rename" item from the chat plan — public API wins.

## Phase F (stretch, only if all above is green)
- `Store`↔`Table` cycle: move `TableStore` interface into `table/TableStore.ts` (contract),
  `Store` implements it; drop the `ENGINE_META_KEY` re-export shim.
- Split `src/types.ts`: `core/types.ts` (public Row/Schema/ScanOptions…) vs module-local types
  (SerializedSegment etc. into `format/`). Only move, never redefine.

## Verification per phase
- `npm run typecheck`
- full `npm test` (18 files)
- `npm run build` at the very end.
- Sanity diff of public surface: `git diff main -- src/index.ts` must stay empty
  (until an explicit public change is decided).

## Done = Phases A–E green + build green. Phase F optional.
