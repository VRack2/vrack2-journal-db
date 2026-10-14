// Sql.ts — SQL-lite on top of scan()
//
// A thin parser (not a dialect): compiles a SQL-like query into
// Journal.scan() options and passes them on. Supported form:
//
//   SELECT <items>
//   [WHERE <cond> [AND <cond> ...]]
//   [GROUP BY <field> [, <field> ...]]
//   [ORDER BY [<key>] [ASC|DESC]]
//   [LIMIT n [OFFSET m]]
//
//   INSERT INTO <journal> (<columns>) VALUES (<values>)[, (<values>), ...]
//
// SELECT items:
//   *            — all schema fields (non-aggregate mode);
//   field        — a column (in aggregate mode — a group-by field);
//   fn(field)    — aggregate: avg|min|max|sum|count (enables aggregate mode).
//
// WHERE conditions (joined with AND):
//   field = v | != v | <> v | < v | <= v | > v | >= v
//   field BETWEEN v AND v      (for ts — start/end range, otherwise two bounds)
//   field IN (v, ...) | NOT IN (v, ...)
//   field IS NULL | IS NOT NULL
//
// Values: a number (123, -4.5) or a string ('text', 'now-1h').
//
// Examples:
//   SELECT avg(value), host WHERE value > 90 GROUP BY host ORDER BY value_avg DESC LIMIT 20
//   SELECT host, value WHERE ts BETWEEN 'now-1h' AND 'now' AND host = 'web-1' ORDER BY ts DESC LIMIT 10
//   SELECT * WHERE level IN ('error', 'warn') LIMIT 50

import type { AggFn, JsonValue, Row, ScanOptions, ScanWhere } from './types.ts';
import ErrorManager from './errors/ErrorManager.ts';

ErrorManager.registerMany('Sql', [
  { short: 'SQL_EMPTY', description: 'SQL: empty query' },
  { short: 'SQL_LIMIT_NUM', description: 'SQL: LIMIT must be an integer', rules: { got: 'string' } },
  { short: 'SQL_LIMIT_COUNT', description: 'SQL: LIMIT offset,count — count must be a number', rules: { got: 'string' } },
  { short: 'SQL_OFFSET_NUM', description: 'SQL: OFFSET must be an integer', rules: { got: 'string' } },
  { short: 'SQL_TRAILING', description: 'SQL: unexpected tokens at the end of the query', rules: { tok: 'string' } },
  { short: 'SQL_STR_UNCLOSED', description: 'SQL: unterminated string' },
  { short: 'SQL_BAD_CHAR', description: 'SQL: unexpected character', rules: { ch: 'string', pos: 'number' } },
  { short: 'SQL_EOF', description: 'SQL: unexpected end of query' },
  { short: 'SQL_EXPECT_KW', description: 'SQL: expected a keyword', rules: { kw: 'string', got: 'string' } },
  { short: 'SQL_EXPECT_PUNCT', description: 'SQL: expected punctuation', rules: { p: 'string', got: 'string' } },
  { short: 'SQL_EXPECT_ID', description: 'SQL: expected a field name', rules: { got: 'string' } },
  { short: 'SQL_EXPECT_VALUE', description: 'SQL: expected a value (number, string, or true/false)', rules: { got: 'string' } },
  { short: 'SQL_SELECT_EMPTY', description: 'SQL: empty SELECT list' },
  { short: 'SQL_FN_UNKNOWN', description: 'SQL: unknown function', rules: { name: 'string', allowed: 'string' } },
  { short: 'SQL_TS_BETWEEN', description: "SQL: ts BETWEEN — the value must be a number (ms) or a string like 'now-1h'" },
  { short: 'SQL_IS_NOT', description: 'SQL: expected NULL after IS NOT' },
  { short: 'SQL_IS_OP', description: 'SQL: expected NULL or NOT after IS', rules: { got: 'string' } },
  { short: 'SQL_NOT_IN', description: 'SQL: expected IN after NOT', rules: { got: 'string' } },
  { short: 'SQL_OP_UNKNOWN', description: 'SQL: unknown operator in the condition', rules: { field: 'string' } },
  { short: 'SQL_INSERT_MORE', description: 'SQL: INSERT INTO — more values than columns', rules: { cols: 'number' } },
  { short: 'SQL_INSERT_COUNT', description: 'SQL: INSERT INTO — expected N value(s)', rules: { cols: 'number', got: 'number' } },
]);

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punct'; v: string };

interface Cursor {
  toks: Tok[];
  i: number;
}

interface Item {
  agg: { fn: AggFn; field: string } | null;
  field: string;
  star: boolean;
}

/** Result of parsing INSERT INTO. */
export interface InsertQuery {
  /** Name of the target journal (must match the journal it is executed on). */
  name: string;
  /** Rows to write: columns from the query in list order. */
  rows: Row[];
}

const AGG_FNS: readonly AggFn[] = ['min', 'max', 'sum', 'avg', 'count'];

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'GROUP', 'BY', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'IN', 'NOT', 'IS', 'NULL', 'BETWEEN', 'AS', 'OFFSET',
  'INSERT', 'INTO', 'VALUES',
]);

const OP_MAP: Record<string, ScanWhere['op']> = {
  '=': 'eq', '!=': 'ne', '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge',
};

export class Sql {
  /**
    * Compiles SQL-lite (SELECT) into Journal.scan() options.
     * Throws an error (SQL_* code) on a syntax error.
   */
  static parse(query: string): ScanOptions {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw ErrorManager.make('SQL_EMPTY');
    }
    const toks = this.tokenize(query);
    if (toks.length === 0) throw ErrorManager.make('SQL_EMPTY');
    const c: Cursor = { toks, i: 0 };
    const opts: ScanOptions = {};

    this.expectKw(c, 'SELECT');
    const items = this.parseItems(c);

    // FROM <table> — name of the target journal; Journal.sql() will match it against this.name.
    if (this.isKw(this.peek(c), 'FROM')) {
      this.next(c);
      opts.table = this.nextId(c);
    }

    // WHERE
    if (this.isKw(this.peek(c), 'WHERE')) {
      this.next(c);
      opts.where = [];
      this.parseCond(c, opts);
      while (this.isKw(this.peek(c), 'AND')) {
        this.next(c);
        this.parseCond(c, opts);
      }
    }

    // GROUP BY
    const explicitGroup: string[] = [];
    if (this.isKw(this.peek(c), 'GROUP')) {
      this.next(c);
      this.expectKw(c, 'BY');
      explicitGroup.push(this.nextId(c));
      while (this.isPunct(this.peek(c), ',')) {
        this.next(c);
        explicitGroup.push(this.nextId(c));
      }
    }

    // ORDER BY
    let order: 'asc' | 'desc' | null = null;
    if (this.isKw(this.peek(c), 'ORDER')) {
      this.next(c);
      this.expectKw(c, 'BY');
      // Optional key (scan sorts by the first aggregate key / ts / select[0]).
      const t = this.peek(c);
      if (t && t.t === 'id' && !this.isKw(t, 'ASC') && !this.isKw(t, 'DESC')) {
        this.next(c); // key
      }
      const d = this.peek(c);
      if (this.isKw(d, 'ASC')) { this.next(c); order = 'asc'; }
      else if (this.isKw(d, 'DESC')) { this.next(c); order = 'desc'; }
    }

    // LIMIT [OFFSET]
    if (this.isKw(this.peek(c), 'LIMIT')) {
      this.next(c);
      const lt = this.next(c);
      if (lt.t !== 'num') throw ErrorManager.make('SQL_LIMIT_NUM', { got: String(lt.v) });
      let limitVal = lt.v;
      if (this.isPunct(this.peek(c), ',')) {
        this.next(c);
        const ct = this.next(c);
        if (ct.t !== 'num') throw ErrorManager.make('SQL_LIMIT_COUNT', { got: String(ct.v) });
        opts.offset = limitVal;
        limitVal = ct.v;
      }
      opts.limit = limitVal;
    }
    if (this.isKw(this.peek(c), 'OFFSET')) {
      this.next(c);
      const ot = this.next(c);
      if (ot.t !== 'num') throw ErrorManager.make('SQL_OFFSET_NUM', { got: String(ot.v) });
      opts.offset = ot.v;
    }

    // Leftover tokens — error
    if (c.i < toks.length) {
      throw ErrorManager.make('SQL_TRAILING', { tok: String(toks[c.i].v) });
    }

    // --------------------------------------------------
    // Aggregate mode vs raw
    // --------------------------------------------------
    const hasAgg = items.some(it => it.agg !== null);

    if (hasAgg) {
      const agg: Record<string, AggFn[]> = {};
      const groupFromSelect: string[] = [];
      for (const it of items) {
        if (it.agg) {
          const arr = agg[it.agg.field] ?? (agg[it.agg.field] = []);
          if (!arr.includes(it.agg.fn)) arr.push(it.agg.fn);
        } else if (!it.star) {
          groupFromSelect.push(it.field);
        }
      }
      opts.agg = agg;
      const groupBy = [...new Set([...explicitGroup, ...groupFromSelect])];
      if (groupBy.length > 0) opts.groupBy = groupBy;
    } else {
      const stars = items.filter(it => it.star);
      if (stars.length === 0) {
        opts.select = items.map(it => it.field);
      }
      // stars → do not set select: scan() takes all schema fields by default.
    }

    if (order) opts.order = order;

    return opts;
  }

  /**
    * Parses `INSERT INTO name (col, ...) VALUES (v, ...)[, (v, ...), ...]`.
    * Values: number, string, `true`/`false`, or a "bare" identifier
     * (not a keyword). Throws an error (SQL_* code) on a syntax error.
   */
  static parseInsert(sql: string): InsertQuery {
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw ErrorManager.make('SQL_EMPTY');
    }
    const toks = this.tokenize(sql);
    if (toks.length === 0) throw ErrorManager.make('SQL_EMPTY');
    const c: Cursor = { toks, i: 0 };

    this.expectKw(c, 'INSERT');
    this.expectKw(c, 'INTO');
    const name = this.nextId(c);

    this.expectPunct(c, '(');
    const cols: string[] = [this.nextId(c)];
    while (this.isPunct(this.peek(c), ',')) {
      this.next(c);
      cols.push(this.nextId(c));
    }
    this.expectPunct(c, ')');

    this.expectKw(c, 'VALUES');
    const rows: Row[] = [this.parseRow(c, cols)];
    while (this.isPunct(this.peek(c), ',')) {
      this.next(c);
      rows.push(this.parseRow(c, cols));
    }

    if (c.i < toks.length) {
      throw ErrorManager.make('SQL_TRAILING', { tok: String(toks[c.i].v) });
    }
    return { name, rows };
  }

  // --------------------------------------------------
  // Tokenizer
  // --------------------------------------------------

  /** Tokenizes SQL (keywords are not considered — they are recognized by value). */
  private static tokenize(sql: string): Tok[] {
    const toks: Tok[] = [];
    const n = sql.length;
    let i = 0;
    while (i < n) {
      const c = sql[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

      // String
      if (c === "'" || c === '"') {
        const quote = c;
        let j = i + 1;
        let out = '';
        while (j < n && sql[j] !== quote) { out += sql[j]; j++; }
        if (j >= n) throw ErrorManager.make('SQL_STR_UNCLOSED');
        toks.push({ t: 'str', v: out });
        i = j + 1;
        continue;
      }

      // Identifier / keyword.
      // IMPORTANT: try this BEFORE numbers — a named column with digits (host9, c3) must
      // not be eaten by the number rule as "9".
      const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
      if (idMatch) {
        toks.push({ t: 'id', v: idMatch[0] });
        i += idMatch[0].length;
        continue;
      }

      // Number (only if not the start of an identifier)
      const numMatch = /^-?\d+(?:\.\d+)?/.exec(sql.slice(i));
      if (numMatch && (i === 0 || /\s/.test(sql[i - 1]) || sql[i - 1] === '(' || sql[i - 1] === ',')) {
        toks.push({ t: 'num', v: parseFloat(numMatch[0]) });
        i += numMatch[0].length;
        continue;
      }
      // Operators (two-character ones first)
      const two = sql.slice(i, i + 2);
      if (two === '!=' || two === '<>' || two === '<=' || two === '>=') {
        toks.push({ t: 'op', v: two });
        i += 2;
        continue;
      }

      // Single-character
      if (c === '=' || c === '<' || c === '>' || c === '(' || c === ')' || c === ',' || c === '*') {
        toks.push(c === '=' || c === '<' || c === '>' ? { t: 'op', v: c } : { t: 'punct', v: c });
        i++;
        continue;
      }

      throw ErrorManager.make('SQL_BAD_CHAR', { ch: c, pos: i });
    }
    return toks;
  }

  // --------------------------------------------------
  // Parser (cursor)
  // --------------------------------------------------

  private static peek(c: Cursor): Tok | undefined {
    return c.toks[c.i];
  }

  private static next(c: Cursor): Tok {
    const t = c.toks[c.i];
    if (!t) throw ErrorManager.make('SQL_EOF');
    c.i++;
    return t;
  }

  private static isKw(t: Tok | undefined, kw: string): boolean {
    return !!t && t.t === 'id' && t.v.toUpperCase() === kw;
  }

  private static isPunct(t: Tok | undefined, p: string): boolean {
    return !!t && t.t === 'punct' && t.v === p;
  }

  private static expectKw(c: Cursor, kw: string): void {
    const t = this.next(c);
    if (!this.isKw(t, kw)) throw ErrorManager.make('SQL_EXPECT_KW', { kw, got: String(t.v) });
  }

  private static expectPunct(c: Cursor, p: string): void {
    const t = this.next(c);
    if (!this.isPunct(t, p)) throw ErrorManager.make('SQL_EXPECT_PUNCT', { p, got: String(t.v) });
  }

  /** Identifier (field/key). */
  private static nextId(c: Cursor): string {
    const t = this.next(c);
    if (t.t !== 'id') throw ErrorManager.make('SQL_EXPECT_ID', { got: String(t.v) });
    return t.v;
  }

  /** Value: number, string, true/false, or a "bare" identifier. */
  private static parseValue(c: Cursor): number | string | boolean {
    const t = this.next(c);
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'id') {
      const u = t.v.toUpperCase();
      if (u === 'TRUE') return true;
      if (u === 'FALSE') return false;
      if (!KEYWORDS.has(u)) return t.v;
    }
    throw ErrorManager.make('SQL_EXPECT_VALUE', { got: String(t.v) });
  }

  /** One SELECT item: `*`, `field`, or `fn(field)`. */
  private static parseItem(c: Cursor): Item {
    const t = this.peek(c);
    if (!t) throw ErrorManager.make('SQL_SELECT_EMPTY');
    if (this.isPunct(t, '*')) {
      this.next(c);
      return { agg: null, field: '*', star: true };
    }
    const name = this.nextId(c);
    if (this.isPunct(this.peek(c), '(')) {
      // Function call
      this.next(c); // '('
      const fieldName = this.nextId(c);
      this.expectPunct(c, ')');
      const fn = name.toLowerCase();
      if (!(AGG_FNS as readonly string[]).includes(fn)) {
        throw ErrorManager.make('SQL_FN_UNKNOWN', { name, allowed: AGG_FNS.join('|') });
      }
      return { agg: { fn: fn as AggFn, field: fieldName }, field: fieldName, star: false };
    }
    return { agg: null, field: name, star: false };
  }

  /** List of SELECT items up to a keyword/end. */
  private static parseItems(c: Cursor): Item[] {
    const items = [this.parseItem(c)];
    while (this.isPunct(this.peek(c), ',')) {
      this.next(c);
      items.push(this.parseItem(c));
    }
    return items;
  }

  /**
    * One WHERE condition. Writes to opts.where, or (for `ts BETWEEN`) to
    * opts.start/opts.end (the segment fast path).
   */
  private static parseCond(c: Cursor, opts: ScanOptions): void {
    const field = this.nextId(c);
    const t = this.peek(c);

    // BETWEEN
    if (this.isKw(t, 'BETWEEN')) {
      this.next(c);
      const a = this.parseValue(c);
      this.expectKw(c, 'AND');
      const b = this.parseValue(c);
      if (field.toLowerCase() === 'ts') {
        if (typeof a === 'boolean' || typeof b === 'boolean') {
          throw ErrorManager.make('SQL_TS_BETWEEN');
        }
        opts.start = a;
        opts.end = b;
      } else {
        opts.where!.push({ field, op: 'ge', value: a });
        opts.where!.push({ field, op: 'le', value: b });
      }
      return;
    }

    // IS [NOT] NULL
    if (this.isKw(t, 'IS')) {
      this.next(c);
      const t2 = this.next(c);
      if (this.isKw(t2, 'NOT')) {
        const t3 = this.next(c);
        if (!this.isKw(t3, 'NULL')) throw ErrorManager.make('SQL_IS_NOT');
        opts.where!.push({ field, op: 'isNotNull' });
      } else if (this.isKw(t2, 'NULL')) {
        opts.where!.push({ field, op: 'isNull' });
      } else {
        throw ErrorManager.make('SQL_IS_OP', { got: String(t2.v) });
      }
      return;
    }

    // NOT IN
    if (this.isKw(t, 'NOT')) {
      this.next(c);
      const t2 = this.next(c);
      if (!this.isKw(t2, 'IN')) throw ErrorManager.make('SQL_NOT_IN', { got: String(t2.v) });
      this.expectPunct(c, '(');
      const vals: JsonValue[] = [this.parseValue(c)];
      while (this.isPunct(this.peek(c), ',')) {
        this.next(c);
        vals.push(this.parseValue(c));
      }
      this.expectPunct(c, ')');
      opts.where!.push({ field, op: 'nin', value: vals });
      return;
    }

    // IN
    if (this.isKw(t, 'IN')) {
      this.next(c);
      this.expectPunct(c, '(');
      const vals: JsonValue[] = [this.parseValue(c)];
      while (this.isPunct(this.peek(c), ',')) {
        this.next(c);
        vals.push(this.parseValue(c));
      }
      this.expectPunct(c, ')');
      opts.where!.push({ field, op: 'in', value: vals });
      return;
    }

    // Comparison
    if (t && t.t === 'op' && t.v in OP_MAP) {
      const op = OP_MAP[t.v];
      this.next(c);
      const v = this.parseValue(c);
      opts.where!.push({ field, op, value: v });
      return;
    }

    throw ErrorManager.make('SQL_OP_UNKNOWN', { field });
  }

  /** One INSERT row: `(v, ...)`. */
  private static parseRow(c: Cursor, cols: string[]): Row {
    this.expectPunct(c, '(');
    const row: Row = {};
    let k = 0;
    row[cols[0]] = this.parseValue(c);
    while (this.isPunct(this.peek(c), ',')) {
      this.next(c);
      k++;
      if (k >= cols.length) {
        throw ErrorManager.make('SQL_INSERT_MORE', { cols: cols.length });
      }
      row[cols[k]] = this.parseValue(c);
    }
    if (k + 1 !== cols.length) {
      throw ErrorManager.make('SQL_INSERT_COUNT', { cols: cols.length, got: k + 1 });
    }
    this.expectPunct(c, ')');
    return row;
  }
}
