// types.ts — AST types for the SQL subset that maps to ScanOptions.

/** Token types produced by the Lexer. */
export type TokenType =
  | 'KEYWORD'    // SELECT, FROM, WHERE, GROUP, BY, ORDER, LIMIT, OFFSET, AND, IN, NOT, IS, NULL, ASC, DESC, AS, INSERT, INTO, VALUES
  | 'IDENT'      // identifiers (column/table names)
  | 'NUMBER'     // numeric literal
  | 'STRING'     // 'quoted string'
  | 'OP'         // = != < <= > >=
  | 'COMMA'      // ,
  | 'DOT'        // .
  | 'LPAREN'     // (
  | 'RPAREN'     // )
  | 'STAR'       // *
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

// --------------------------------------------------
// AST
// --------------------------------------------------

export type SqlStatement = SqlSelectStatement | SqlInsertStatement;

export interface SqlSelectStatement {
  kind: 'select';
  table: string;
  select: SqlSelectItem[];
  where: SqlWhereCondition[];
  groupBy: string[];
  order: 'asc' | 'desc' | null;
  orderField: string | null;
  limit: number | null;
  offset: number | null;
}

export interface SqlInsertStatement {
  kind: 'insert';
  table: string;
  columns: string[] | null;  // null = use schema order
  rows: Record<string, string | number | boolean | null>[];
}

export interface SqlSelectItem {
  /** Column name or aggregate function name. */
  field: string;
  /** Aggregate function (avg, sum, min, max, count) or null for plain column. */
  fn: string | null;
  /** Alias (AS name). */
  alias: string | null;
}

export interface SqlWhereCondition {
  field: string;
  op: string;       // '=', '!=', '<', '<=', '>', '>=', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL'
  value: unknown;   // literal or array for IN
}
