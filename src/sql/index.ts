// index.ts — public API of the sql/ module.

import { Parser } from './Parser.ts';
import { translate, type SqlQuery, type SqlSelectQuery, type SqlInsertQuery } from './Translator.ts';

export { SqlSyntaxError } from './Lexer.ts';
export type { SqlQuery, SqlSelectQuery, SqlInsertQuery } from './Translator.ts';

/**
 * Parse a SQL string and return the table name + engine-native form.
 *
 * Supported subset:
 *   SELECT col1, col2 | agg_fn(col) | *
 *   FROM table_name
 *   WHERE col op value [AND ...]
 *   GROUP BY col [, col]
 *   ORDER BY col [ASC|DESC]
 *   LIMIT n [OFFSET m]
 *
 *   INSERT INTO table [(col1, col2, ...)] VALUES (v1, v2, ...) [, (...)]
 *
 * Operators: = != < <= > >= IN NOT IN IS NULL IS NOT NULL
 * Aggregates: avg sum min max count
 * ts conditions (>=, >, <=, <) are mapped to start/end for zone-map skipping.
 */
export function parseSql(sql: string): SqlQuery {
  const ast = new Parser(sql).parse();
  return translate(ast);
}
