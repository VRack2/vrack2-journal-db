// Parser.ts — recursive-descent parser: tokens → SqlStatement AST.

import { Lexer, SqlSyntaxError } from './Lexer.ts';
import type { SqlStatement, SqlSelectStatement, SqlInsertStatement, SqlSelectItem, SqlWhereCondition, Token, TokenType } from './types.ts';

const AGG_FNS: ReadonlySet<string> = new Set(['avg', 'sum', 'min', 'max', 'count']);

export class Parser {
  private readonly tokens: Token[];
  private pos: number = 0;

  constructor(sql: string) {
    this.tokens = new Lexer(sql).tokenize();
  }

  parse(): SqlStatement {
    const tok = this.peek();
    if (tok.type === 'KEYWORD' && tok.value === 'INSERT') {
      return this.parseInsert();
    }
    return this.parseSelect();
  }

  private parseSelect(): SqlSelectStatement {
    this.expectKeyword('SELECT');
    const select = this.parseSelectList();
    this.expectKeyword('FROM');
    const table = this.expectIdent();
    const where = this.parseOptionalWhere();
    const groupBy = this.parseOptionalGroupBy();
    const { order, orderField } = this.parseOptionalOrderBy();
    const limit = this.parseOptionalLimit();
    const offset = this.parseOptionalOffset();
    this.expectEof();
    return { kind: 'select', table, select, where, groupBy, order, orderField, limit, offset };
  }

  private parseInsert(): SqlInsertStatement {
    this.expectKeyword('INSERT');
    this.expectKeyword('INTO');
    const table = this.expectIdent();

    // optional column list: (col1, col2, ...)
    let columns: string[] | null = null;
    if (this.peek().type === 'LPAREN') {
      this.advance();
      columns = [this.expectIdent()];
      while (this.peek().type === 'COMMA') {
        this.advance();
        columns.push(this.expectIdent());
      }
      this.expect('RPAREN', ')');
    }

    this.expectKeyword('VALUES');

    // one or more value tuples: (v1, v2, ...), (v1, v2, ...), ...
    const rows: Record<string, string | number | boolean | null>[] = [];
    rows.push(this.parseValueTuple(columns));
    while (this.peek().type === 'COMMA') {
      this.advance();
      rows.push(this.parseValueTuple(columns));
    }

    this.expectEof();
    return { kind: 'insert', table, columns, rows };
  }

  private parseValueTuple(columns: string[] | null): Record<string, string | number | boolean | null> {
    this.expect('LPAREN', '(');
    const values: (string | number | boolean | null)[] = [];
    values.push(this.parseInsertLiteral());
    while (this.peek().type === 'COMMA') {
      this.advance();
      values.push(this.parseInsertLiteral());
    }
    this.expect('RPAREN', ')');

    const row: Record<string, string | number | boolean | null> = {};
    if (columns) {
      if (columns.length !== values.length) {
        throw new SqlSyntaxError(`column count (${columns.length}) != value count (${values.length})`, this.peek().pos);
      }
      for (let i = 0; i < columns.length; i++) row[columns[i]] = values[i];
    } else {
      // no column list — positional: col0, col1, ... (caller resolves via schema)
      for (let i = 0; i < values.length; i++) row[`__pos${i}`] = values[i];
    }
    return row;
  }

  private parseInsertLiteral(): string | number | boolean | null {
    const tok = this.peek();
    if (tok.type === 'NUMBER') { this.advance(); return Number(tok.value); }
    if (tok.type === 'STRING') { this.advance(); return tok.value; }
    if (tok.type === 'KEYWORD' && tok.value === 'NULL') { this.advance(); return null; }
    if (tok.type === 'KEYWORD' && tok.value === 'TRUE') { this.advance(); return true; }
    if (tok.type === 'KEYWORD' && tok.value === 'FALSE') { this.advance(); return false; }
    if (tok.type === 'IDENT') { this.advance(); return tok.value; }
    throw new SqlSyntaxError('expected a literal value in VALUES', tok.pos);
  }

  private parseSelectList(): SqlSelectItem[] {
    const items: SqlSelectItem[] = [];
    items.push(this.parseSelectItem());
    while (this.peek().type === 'COMMA') {
      this.advance();
      items.push(this.parseSelectItem());
    }
    return items;
  }

  private parseSelectItem(): SqlSelectItem {
    const tok = this.peek();
    if (tok.type === 'IDENT' && AGG_FNS.has(tok.value.toLowerCase()) && this.peekAt(1).type === 'LPAREN') {
      const fn = tok.value.toLowerCase();
      this.advance(); this.advance();
      const field = this.expectIdent();
      this.expect('RPAREN', ')');
      const alias = this.parseOptionalAlias();
      return { field, fn, alias };
    }
    if (tok.type === 'STAR') {
      this.advance();
      return { field: '*', fn: null, alias: null };
    }
    const field = this.expectIdent();
    const alias = this.parseOptionalAlias();
    return { field, fn: null, alias };
  }

  private parseOptionalAlias(): string | null {
    if (this.peek().type === 'KEYWORD' && this.peek().value === 'AS') {
      this.advance();
      return this.expectIdent();
    }
    return null;
  }

  private parseOptionalWhere(): SqlWhereCondition[] {
    if (this.peek().type === 'KEYWORD' && this.peek().value === 'WHERE') {
      this.advance();
      return this.parseWhereConditions();
    }
    return [];
  }

  private parseWhereConditions(): SqlWhereCondition[] {
    const conditions: SqlWhereCondition[] = [];
    conditions.push(this.parseWhereCondition());
    while (this.peek().type === 'KEYWORD' && this.peek().value === 'AND') {
      this.advance();
      conditions.push(this.parseWhereCondition());
    }
    return conditions;
  }

  private parseWhereCondition(): SqlWhereCondition {
    const field = this.expectIdent();
    const tok = this.peek();

    if (tok.type === 'KEYWORD' && tok.value === 'IS') {
      this.advance();
      if (this.peek().type === 'KEYWORD' && this.peek().value === 'NOT') {
        this.advance();
        this.expectKeyword('NULL');
        return { field, op: 'IS NOT NULL', value: null };
      }
      this.expectKeyword('NULL');
      return { field, op: 'IS NULL', value: null };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'NOT') {
      this.advance();
      this.expectKeyword('IN');
      return { field, op: 'NOT IN', value: this.parseParenList() };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'IN') {
      this.advance();
      return { field, op: 'IN', value: this.parseParenList() };
    }

    if (tok.type === 'OP') {
      this.advance();
      return { field, op: tok.value, value: this.parseLiteral() };
    }

    throw new SqlSyntaxError(`expected operator after '${field}'`, tok.pos);
  }

  private parseParenList(): unknown[] {
    this.expect('LPAREN', '(');
    const values: unknown[] = [];
    if (this.peek().type !== 'RPAREN') {
      values.push(this.parseLiteral());
      while (this.peek().type === 'COMMA') {
        this.advance();
        values.push(this.parseLiteral());
      }
    }
    this.expect('RPAREN', ')');
    return values;
  }

  private parseOptionalGroupBy(): string[] {
    if (this.peek().type === 'KEYWORD' && this.peek().value === 'GROUP') {
      this.advance();
      this.expectKeyword('BY');
      const fields: string[] = [this.expectIdent()];
      while (this.peek().type === 'COMMA') {
        this.advance();
        fields.push(this.expectIdent());
      }
      return fields;
    }
    return [];
  }

  private parseOptionalOrderBy(): { order: 'asc' | 'desc' | null; orderField: string | null } {
    if (this.peek().type === 'KEYWORD' && this.peek().value === 'ORDER') {
      this.advance();
      this.expectKeyword('BY');
      const orderField = this.expectIdent();
      let order: 'asc' | 'desc' = 'asc';
      if (this.peek().type === 'KEYWORD' && (this.peek().value === 'ASC' || this.peek().value === 'DESC')) {
        order = this.peek().value.toLowerCase() as 'asc' | 'desc';
        this.advance();
      }
      return { order, orderField };
    }
    return { order: null, orderField: null };
  }

  private parseOptionalLimit(): number | null {
    if (this.peek().type === 'KEYWORD' && this.peek().value === 'LIMIT') {
      this.advance();
      const tok = this.peek();
      if (tok.type !== 'NUMBER') throw new SqlSyntaxError('expected a number after LIMIT', tok.pos);
      this.advance();
      return Number(tok.value);
    }
    return null;
  }

  private parseOptionalOffset(): number | null {
    if (this.peek().type === 'KEYWORD' && this.peek().value === 'OFFSET') {
      this.advance();
      const tok = this.peek();
      if (tok.type !== 'NUMBER') throw new SqlSyntaxError('expected a number after OFFSET', tok.pos);
      this.advance();
      return Number(tok.value);
    }
    return null;
  }

  private parseLiteral(): string | number | null {
    const tok = this.peek();
    if (tok.type === 'NUMBER') { this.advance(); return Number(tok.value); }
    if (tok.type === 'STRING') { this.advance(); return tok.value; }
    if (tok.type === 'KEYWORD' && tok.value === 'NULL') { this.advance(); return null; }
    if (tok.type === 'IDENT') { this.advance(); return tok.value; }
    throw new SqlSyntaxError('expected a literal value', tok.pos);
  }

  // --------------------------------------------------
  // Token helpers
  // --------------------------------------------------
  private peek(): Token { return this.tokens[this.pos]; }
  private peekAt(n: number): Token { return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)]; }
  private advance(): Token { return this.tokens[this.pos++]; }

  private expect(type: TokenType, expected: string): Token {
    const tok = this.peek();
    if (tok.type !== type) throw new SqlSyntaxError(`expected '${expected}', got '${tok.value || tok.type}'`, tok.pos);
    return this.advance();
  }

  private expectKeyword(kw: string): Token {
    const tok = this.peek();
    if (tok.type !== 'KEYWORD' || tok.value !== kw) throw new SqlSyntaxError(`expected '${kw}'`, tok.pos);
    return this.advance();
  }

  private expectIdent(): string {
    const tok = this.peek();
    if (tok.type !== 'IDENT') throw new SqlSyntaxError(`expected an identifier, got '${tok.value || tok.type}'`, tok.pos);
    this.advance();
    return tok.value;
  }

  private expectEof(): void {
    const tok = this.peek();
    if (tok.type !== 'EOF') throw new SqlSyntaxError(`unexpected token '${tok.value}'`, tok.pos);
  }
}

