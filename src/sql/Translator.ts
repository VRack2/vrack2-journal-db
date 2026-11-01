// Translator.ts — SqlStatement AST → ScanOptions (the engine's native IR).

import type { ScanOptions, ScanWhere, ScanOp, AggFn, Row } from '../core/types.ts';
import type { SqlStatement, SqlSelectStatement, SqlInsertStatement, SqlWhereCondition } from './types.ts';
import { SqlSyntaxError } from './Lexer.ts';

const OP_MAP: Record<string, ScanOp> = {
  '=': 'eq',
  '!=': 'ne',
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
};

const VALID_AGG_FNS: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg', 'count']);

export type SqlQuery = SqlSelectQuery | SqlInsertQuery;

export interface SqlSelectQuery {
  kind: 'select';
  table: string;
  opts: ScanOptions;
}

export interface SqlInsertQuery {
  kind: 'insert';
  table: string;
  rows: Row[];
  /** true when columns were not specified (positional — needs schema to resolve). */
  positional: boolean;
}

/** Translate a parsed SqlStatement into the engine's native form. */
export function translate(ast: SqlStatement): SqlQuery {
  if (ast.kind === 'insert') return translateInsert(ast);
  return translateSelect(ast);
}

function translateInsert(ast: SqlInsertStatement): SqlInsertQuery {
  return {
    kind: 'insert',
    table: ast.table,
    rows: ast.rows as Row[],
    positional: ast.columns === null,
  };
}

function translateSelect(ast: SqlSelectStatement): SqlSelectQuery {
  const opts: ScanOptions = {};

  // --- SELECT: plain columns vs aggregates ---
  const plainFields: string[] = [];
  const aggMap: Record<string, AggFn[]> = {};

  for (const item of ast.select) {
    if (item.field === '*' && item.fn === null) {
      // SELECT * — no explicit select (engine returns all schema fields)
      continue;
    }
    if (item.fn !== null) {
      if (!VALID_AGG_FNS.has(item.fn)) {
        throw new SqlSyntaxError(`unsupported aggregate function '${item.fn}'`, 0);
      }
      (aggMap[item.field] ??= []).push(item.fn as AggFn);
    } else {
      plainFields.push(item.field);
    }
  }

  if (Object.keys(aggMap).length > 0) {
    opts.agg = aggMap;
    if (ast.groupBy.length > 0) {
      opts.groupBy = ast.groupBy;
    }
  } else if (plainFields.length > 0) {
    opts.select = plainFields;
  }

  // --- WHERE: split ts conditions into start/end, rest into where[] ---
  const whereConditions: ScanWhere[] = [];
  for (const cond of ast.where) {
    if (cond.field === 'ts') {
      const tsResult = translateTsCondition(cond);
      if (tsResult.start !== undefined) opts.start = tsResult.start;
      if (tsResult.end !== undefined) opts.end = tsResult.end;
      // If ts has a non-range op (eq, in, etc.), keep it as a regular where condition
      if (tsResult.whereFallback) whereConditions.push(tsResult.whereFallback);
    } else {
      whereConditions.push(translateWhereCondition(cond));
    }
  }
  if (whereConditions.length > 0) opts.where = whereConditions;

  // --- ORDER BY ---
  if (ast.order !== null) {
    opts.order = ast.order;
    // The engine sorts by select[0] (or 'ts' if present).
    // Put the ORDER BY field first in select so the engine sorts by it.
    if (ast.orderField && ast.orderField !== 'ts' && opts.select && opts.select.length > 0) {
      const idx = opts.select.indexOf(ast.orderField);
      if (idx > 0) {
        opts.select.splice(idx, 1);
        opts.select.unshift(ast.orderField);
      }
    }
  }

  // --- LIMIT / OFFSET ---
  if (ast.limit !== null) opts.limit = ast.limit;
  if (ast.offset !== null) opts.offset = ast.offset;

  return { kind: 'select', table: ast.table, opts };
}

function translateTsCondition(cond: SqlWhereCondition): {
  start?: number | string;
  end?: number | string;
  whereFallback?: ScanWhere;
} {
  switch (cond.op) {
    case '>=': return { start: cond.value as number | string };
    case '>':  return { start: cond.value as number | string };
    case '<=': return { end: cond.value as number | string };
    case '<':  return { end: cond.value as number | string };
    default:   return { whereFallback: translateWhereCondition(cond) };
  }
}

function translateWhereCondition(cond: SqlWhereCondition): ScanWhere {
  switch (cond.op) {
    case 'IS NULL':     return { field: cond.field, op: 'isNull' };
    case 'IS NOT NULL': return { field: cond.field, op: 'isNotNull' };
    case 'IN':          return { field: cond.field, op: 'in', value: cond.value as never };
    case 'NOT IN':      return { field: cond.field, op: 'nin', value: cond.value as never };
    default: {
      const op = OP_MAP[cond.op];
      if (!op) throw new SqlSyntaxError(`unsupported operator '${cond.op}'`, 0);
      return { field: cond.field, op, value: cond.value as never };
    }
  }
}
