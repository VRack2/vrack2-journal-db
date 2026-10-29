// execute.ts — runs a compiled ScanPlan over a journal's segments (vectorized:
// column-at-a-time access, .meta skipping, summaries fast path, early stop).

import type { Column } from '../../format/columns/Column.ts';
import type { Segment } from '../../format/Segment.ts';
import type { Row } from '../../core/types.ts';
import { Aggregation, type AggAcc } from '../../metric/Aggregation.ts';
import { SegmentMeta } from '../SegmentMeta.ts';
import type { SegmentSource } from '../segmentSource.ts';
import { keyOf, whereOne, type ScanPlan } from './plan.ts';

export function executeScan(plan: ScanPlan, src: SegmentSource): Row[] {
  // One shared comparator for both result shapes: nulls last, direction from plan.order.
  const sortRows = (rows: Row[], key: string): void => {
    if (rows.length <= 1) return;
    rows.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (av < bv ? -1 : 1) * plan.order;
    });
  };

  const groups = new Map<string, { row: Row; accs: Record<string, AggAcc> }>();
  let rawRows: Row[] | null = null;
  if (!plan.agg) rawRows = [];

  const rawNeed = plan.limit !== null ? plan.offset + plan.limit : Infinity;
  // Early stop trusts journal invariants and safe plan shapes. Invariant:
  // appends arrive ts-nondecreasing (rows inside a segment, and segment
  // ranges, follow real chronological order — documented in README).
  // Safe gate: the plan sorts by ts itself (not by a select field); every
  // closed segment publishes numeric .meta bounds with NON-OVERLAPPING
  // ranges (a meta-less segment sorts LAST in sortedIds() regardless of its
  // real ts range, and overlapping ranges let the break cut smaller ts from
  // a later segment); and rows without a numeric ts cannot steal the
  // collection budget — either the ts window rejects them, or every scanned
  // source has tsCount === rowCount (no ts-less rows anywhere). Clustered
  // segments (meta.tsOrdered === false) break the ordering invariant — their
  // rows follow dimension order, not ts — so early stop additionally requires
  // every closed segment to be ts-ordered.
  const closedIds = src.sortedClosedIds();
  let rangesDisjoint = true;
  let allTsCovered = true;
  let tsOrderedAll = true;
  for (let i = 0; i < closedIds.length; i++) {
    const m = src.metaOf(closedIds[i]);
    if (m && m.tsOrdered === false) tsOrderedAll = false;
    if (!m || typeof m.minTs !== 'number' || typeof m.maxTs !== 'number' || m.tsCount !== m.rowCount) {
      allTsCovered = false;
      if (!m || typeof m.minTs !== 'number' || typeof m.maxTs !== 'number') rangesDisjoint = false;
      continue;
    }
    if (i > 0) {
      const prev = src.metaOf(closedIds[i - 1]);
      if (prev && typeof prev.maxTs === 'number' && !(prev.maxTs < m.minTs)) rangesDisjoint = false;
    }
  }
  const activeSeg = src.activeSegment;
  if (activeSeg && activeSeg.rowCount > 0 && activeSeg.tsCount !== activeSeg.rowCount) allTsCovered = false;
  const canEarlyStop = !plan.agg && plan.order === 1 && plan.limit !== null
    && plan.sortKey === 'ts' && rangesDisjoint && tsOrderedAll
    && (plan.hasTsFilter || allTsCovered);

  const getGroup = (key: string, row: Row): { row: Row; accs: Record<string, AggAcc> } => {
    let g = groups.get(key);
    if (!g) {
      const accs: Record<string, AggAcc> = {};
      for (const spec of plan.aggSpec) accs[spec.field] = Aggregation.newAcc();
      g = { row, accs };
      groups.set(key, g);
    }
    return g;
  };

  const processSegment = (seg: Segment): void => {
    if (plan.start !== null && plan.end !== null && seg.minTs !== null && seg.maxTs !== null && (seg.maxTs < plan.start || seg.minTs > plan.end)) return;

    if (plan.agg && plan.where.length === 0 && plan.groupBy.length === 0 && plan.start !== null && plan.end !== null && seg.minTs !== null && seg.maxTs !== null && seg.minTs >= plan.start && seg.maxTs <= plan.end) {
      let slow: string[] = [];
      for (const spec of plan.aggSpec) {
        const s = seg.summaries[spec.field];
        if (s && s.count > 0) {
          const acc = groups.get('')!.accs[spec.field];
          Aggregation.addSummary(acc, s);
        } else {
          slow.push(spec.field);
        }
      }
      if (slow.length > 0) Aggregation.scanAggregate(seg, plan.start!, plan.end!, slow, groups.get('')!.accs);
      return;
    }

    const rowMap = seg.rowMap;
    const n = seg.rowCount;
    const cols: Record<string, Column | undefined> = {};
    const fieldsNeeded = new Set<string>();
    if (plan.hasTsFilter) fieldsNeeded.add('ts');
    for (const c of plan.where) fieldsNeeded.add(c.field);
    if (plan.agg) {
      for (const a of plan.aggSpec) fieldsNeeded.add(a.field);
      for (const g of plan.groupBy) fieldsNeeded.add(g);
    } else {
      for (const f of plan.select) fieldsNeeded.add(f);
    }
    for (const f of fieldsNeeded) cols[f] = seg.columns[f];

    const tsCol = plan.hasTsFilter ? cols['ts'] : null;
    const conds = plan.where;
    const nc = conds.length;
    const start = plan.start;
    const end = plan.end;

    // Shared per-row gate (ts range + where) for both the agg and raw loops.
    const rowPasses = (pi: number): boolean => {
      if (tsCol) {
        const ts = tsCol.get(pi);
        if (typeof ts !== 'number') return false;
        if (start !== null && ts < start) return false;
        if (end !== null && ts > end) return false;
      }
      for (let ci = 0; ci < nc; ci++) {
        const c = conds[ci];
        const col = cols[c.field];
        const v = col ? col.get(pi) : null;
        if (!whereOne(v, c.op, c.value)) return false;
      }
      return true;
    };

    if (plan.agg) {
      const gb = plan.groupBy;
      const ngb = gb.length;
      const spec = plan.aggSpec;
      for (let li = 0; li < n; li++) {
        const pi = rowMap[li];
        if (!rowPasses(pi)) continue;

        let key: string;
        let grow: Row = {};
        if (ngb === 0) {
          key = '';
        } else if (ngb === 1) {
          const gcol = cols[gb[0]];
          const gv = gcol ? gcol.get(pi) : null;
          key = keyOf(gv);
          grow = { [gb[0]]: gv };
        } else {
          grow = {};
          let kk = '';
          for (let gi = 0; gi < ngb; gi++) {
            const gcol = cols[gb[gi]];
            const gv = gcol ? gcol.get(pi) : null;
            grow[gb[gi]] = gv;
            kk += (gi ? '\u0000' : '') + keyOf(gv);
          }
          key = kk;
        }

        const g = key === '' ? (groups.has('') ? groups.get('')! : getGroup('', {})) : getGroup(key, grow);
        for (let si = 0; si < spec.length; si++) {
          const f = spec[si].field;
          const col = cols[f];
          const v = col ? col.get(pi) : null;
          if (typeof v === 'number' && Number.isFinite(v)) Aggregation.addValue(g.accs[f], v);
        }
      }
    } else {
      const sel = plan.select;
      const nsel = sel.length;
      for (let li = 0; li < n; li++) {
        const pi = rowMap[li];
        if (!rowPasses(pi)) continue;

        const row: Row = {};
        for (let si = 0; si < nsel; si++) {
          const f = sel[si];
          const col = cols[f];
          row[f] = col ? col.get(pi) : null;
        }
        rawRows!.push(row);
        if (canEarlyStop && rawRows!.length >= rawNeed) return;
      }
    }
  };

  if (plan.agg && plan.groupBy.length === 0) getGroup('', {});

  for (const id of closedIds) {
    const meta = src.metaOf(id);
    if (plan.start !== null && plan.end !== null && SegmentMeta.skips(meta?.minTs ?? null, meta?.maxTs ?? null, plan.start, plan.end, true)) continue;
    // Zone-map pushdown: skip segments whose column summaries rule out every row.
    if (plan.where.length > 0 && SegmentMeta.skipsWhere(meta ?? null, plan.where, plan.hasTsFilter)) continue;
    processSegment(src.loadClosed(id));
    if (canEarlyStop && rawRows!.length >= rawNeed) break;
  }

  const active = src.activeSegment;
  if (active && active.rowCount > 0) processSegment(active);

  if (plan.agg) {
    const out: Row[] = [];
    for (const g of groups.values()) {
      const row: Row = { ...g.row };
      for (const spec of plan.aggSpec) {
        const acc = g.accs[spec.field];
        for (const fn of spec.fns) row[`${spec.field}_${fn}`] = Aggregation.value(acc, fn);
      }
      out.push(row);
    }
    sortRows(out, plan.aggKeys[0]);
    const from = plan.offset;
    const to = plan.limit !== null ? from + plan.limit : out.length;
    return out.slice(from, to);
  }

  sortRows(rawRows!, plan.sortKey);
  const from = plan.offset;
  const to = plan.limit !== null ? from + plan.limit : rawRows!.length;
  return rawRows!.slice(from, to);
}
