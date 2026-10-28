// plan.ts — the scan parser: validates a ScanOptions and compiles it into a
// flat ScanPlan that execute.ts can run without any further validation.

import { Interval } from '../../core/Interval.ts';
import ErrorManager from '../../errors/ErrorManager.ts';
import { isAggFn } from '../Aggregation.ts';
import type { AggFn, JsonValue, ScanOp, ScanOptions, Schema } from '../../core/types.ts';

export interface ScanPlan {
  start: number | null;
  end: number | null;
  where: { field: string; op: ScanOp; value: JsonValue }[];
  hasTsFilter: boolean;
  groupBy: string[];
  agg: boolean;
  aggSpec: { field: string; fns: AggFn[] }[];
  aggKeys: string[];
  select: string[];
  order: 1 | -1;
  limit: number | null;
  offset: number;
  sortKey: string;
}

export const SCAN_OPS: readonly ScanOp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin', 'isNull', 'isNotNull'];
const SCAN_OP_SET: ReadonlySet<string> = new Set(SCAN_OPS);
export function isScanOp(op: unknown): op is ScanOp {
  return typeof op === 'string' && SCAN_OP_SET.has(op);
}

/** Canonical string key for a JsonValue (grouping). */
export function keyOf(v: JsonValue): string {
  switch (typeof v) {
    case 'string':  return 's' + v;
    case 'number':  return 'n' + v;
    case 'boolean': return 'b' + v;
  }
  if (v === null || v === undefined) return '\u0000n';
  return 'j' + JSON.stringify(v);
}

/** Evaluate one where-condition against a value. */
export function whereOne(value: JsonValue, op: ScanOp, target: JsonValue): boolean {
  switch (op) {
    case 'eq':        return value === target;
    case 'ne':        return value !== target;
    case 'lt':        return typeof value === 'number' && typeof target === 'number' && value < target;
    case 'le':        return typeof value === 'number' && typeof target === 'number' && value <= target;
    case 'gt':        return typeof value === 'number' && typeof target === 'number' && value > target;
    case 'ge':        return typeof value === 'number' && typeof target === 'number' && value >= target;
    case 'in':        return Array.isArray(target) && target.includes(value);
    case 'nin':       return Array.isArray(target) && !target.includes(value);
    case 'isNull':    return value === null || value === undefined;
    case 'isNotNull': return value !== null && value !== undefined;
  }
  return false;
}

/** Validate ScanOptions and compile it into a ScanPlan. */
export function compileScan(opts: ScanOptions, schema: Schema | null): ScanPlan {
  const start = opts.start !== undefined ? Interval.resolve(opts.start) : null;
  const end = opts.end !== undefined ? Interval.resolve(opts.end) : null;
  if (start !== null && end !== null && end < start) throw ErrorManager.make('JRN_SCAN_RANGE');

  const where: { field: string; op: ScanOp; value: JsonValue }[] = [];
  if (opts.where) {
    for (const w of opts.where) {
      if (!w || typeof w.field !== 'string' || w.field.length === 0) throw ErrorManager.make('JRN_SCAN_WHERE_FIELD');
      if (!isScanOp(w.op)) throw ErrorManager.make('JRN_SCAN_WHERE_OP', { op: String(w.op), allowed: SCAN_OPS.join('|') });
      if ((w.op === 'in' || w.op === 'nin') && !Array.isArray(w.value)) throw ErrorManager.make('JRN_SCAN_WHERE_IN');
      where.push({ field: w.field, op: w.op, value: w.value ?? null });
    }
  }

  const agg: boolean = opts.agg !== undefined && Object.keys(opts.agg).length > 0;
  const aggSpec: { field: string; fns: AggFn[] }[] = [];
  const aggKeys: string[] = [];
  if (agg) {
    for (const [field, fns] of Object.entries(opts.agg!)) {
      if (typeof field !== 'string' || field.length === 0) throw ErrorManager.make('JRN_SCAN_AGG_FIELD');
      if (!Array.isArray(fns) || fns.length === 0) throw ErrorManager.make('JRN_SCAN_AGG_FNS');
      for (const fn of fns) {
        if (!isAggFn(fn)) throw ErrorManager.make('JRN_SCAN_AGG_FN', { fn: String(fn) });
      }
      aggSpec.push({ field, fns });
      for (const fn of fns) aggKeys.push(`${field}_${fn}`);
    }
  }

  let groupBy: string[] = [];
  if (opts.groupBy !== undefined) {
    if (!agg) throw ErrorManager.make('JRN_SCAN_GROUPBY_AGG');
    const gb = Array.isArray(opts.groupBy) ? opts.groupBy : [opts.groupBy];
    for (const g of gb) {
      if (typeof g !== 'string' || g.length === 0) throw ErrorManager.make('JRN_SCAN_GROUPBY');
    }
    groupBy = gb;
  }

  let select: string[];
  if (!agg) {
    select = opts.select && opts.select.length > 0 ? [...opts.select] : (schema ? Object.keys(schema) : []);
    if (select.length === 0) throw ErrorManager.make('JRN_SCAN_SELECT');
    for (const f of select) {
      if (typeof f !== 'string' || f.length === 0) throw ErrorManager.make('JRN_SCAN_SELECT_FIELD');
    }
  } else {
    select = [];
  }

  const order = opts.order ?? (agg ? 'desc' : 'asc');
  if (order !== 'asc' && order !== 'desc') throw ErrorManager.make('JRN_SCAN_ORDER');
  const orderSign: 1 | -1 = order === 'asc' ? 1 : -1;

  let limit: number | null = null;
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 0) throw ErrorManager.make('JRN_SCAN_LIMIT');
    limit = opts.limit;
  }
  const offset = opts.offset !== undefined ? (Number.isInteger(opts.offset) && opts.offset >= 0 ? opts.offset : (() => { throw ErrorManager.make('JRN_SCAN_OFFSET'); })()) : 0;

  const hasTsFilter = start !== null || end !== null;
  const sortKey = agg ? aggKeys[0] : (select.includes('ts') ? 'ts' : select[0]);

  return { start, end, where, hasTsFilter, groupBy, agg, aggSpec, aggKeys, select, order: orderSign, limit, offset, sortKey };
}
