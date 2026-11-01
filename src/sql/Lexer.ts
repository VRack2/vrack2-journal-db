// Lexer.ts — tokenizer for the SQL subset.

import type { Token, TokenType } from './types.ts';

const KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'OFFSET',
  'AND', 'IN', 'NOT', 'IS', 'NULL', 'ASC', 'DESC', 'AS',
  'INSERT', 'INTO', 'VALUES', 'TRUE', 'FALSE',
]);

export class Lexer {
  private readonly src: string;
  private pos: number = 0;

  constructor(src: string) {
    this.src = src;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) break;

      const ch = this.src[this.pos];

      if (ch === ',') { tokens.push({ type: 'COMMA', value: ',', pos: this.pos++ }); continue; }
      if (ch === '.') { tokens.push({ type: 'DOT', value: '.', pos: this.pos++ }); continue; }
      if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(', pos: this.pos++ }); continue; }
      if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')', pos: this.pos++ }); continue; }
      if (ch === '*') { tokens.push({ type: 'STAR', value: '*', pos: this.pos++ }); continue; }

      if (ch === '=' || ch === '!' || ch === '<' || ch === '>') {
        tokens.push(this.readOperator());
        continue;
      }

      if (ch === "'" || ch === '"') {
        tokens.push(this.readString(ch));
        continue;
      }

      if (this.isDigit(ch) || (ch === '-' && this.pos + 1 < this.src.length && this.isDigit(this.src[this.pos + 1]))) {
        tokens.push(this.readNumber());
        continue;
      }

      if (this.isIdentStart(ch)) {
        tokens.push(this.readIdentOrKeyword());
        continue;
      }

      throw new SqlSyntaxError(`unexpected character '${ch}'`, this.pos);
    }
    tokens.push({ type: 'EOF', value: '', pos: this.pos });
    return tokens;
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private readOperator(): Token {
    const start = this.pos;
    const ch = this.src[this.pos];
    let op: string;
    if (ch === '!') {
      if (this.src[this.pos + 1] === '=') { op = '!='; this.pos += 2; }
      else throw new SqlSyntaxError("expected '!='", this.pos);
    } else if (ch === '<') {
      if (this.src[this.pos + 1] === '=') { op = '<='; this.pos += 2; }
      else if (this.src[this.pos + 1] === '>') { op = '!='; this.pos += 2; }
      else { op = '<'; this.pos++; }
    } else if (ch === '>') {
      if (this.src[this.pos + 1] === '=') { op = '>='; this.pos += 2; }
      else { op = '>'; this.pos++; }
    } else {
      op = '='; this.pos++;
    }
    return { type: 'OP', value: op, pos: start };
  }

  private readString(quote: string): Token {
    const start = this.pos;
    this.pos++; // skip opening quote
    let value = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === quote) {
        if (this.src[this.pos + 1] === quote) { value += quote; this.pos += 2; }
        else { this.pos++; return { type: 'STRING', value, pos: start }; }
      } else {
        value += ch;
        this.pos++;
      }
    }
    throw new SqlSyntaxError('unterminated string literal', start);
  }

  private readNumber(): Token {
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos++;
    while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) this.pos++;
    if (this.pos < this.src.length && this.src[this.pos] === '.') {
      this.pos++;
      while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) this.pos++;
    }
    if (this.pos < this.src.length && (this.src[this.pos] === 'e' || this.src[this.pos] === 'E')) {
      this.pos++;
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos++;
      while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) this.pos++;
    }
    return { type: 'NUMBER', value: this.src.slice(start, this.pos), pos: start };
  }

  private readIdentOrKeyword(): Token {
    const start = this.pos;
    while (this.pos < this.src.length && this.isIdentPart(this.src[this.pos])) this.pos++;
    const raw = this.src.slice(start, this.pos);
    const upper = raw.toUpperCase();
    if (KEYWORDS.has(upper)) {
      return { type: 'KEYWORD', value: upper, pos: start };
    }
    return { type: 'IDENT', value: raw, pos: start };
  }

  private isDigit(ch: string): boolean { return ch >= '0' && ch <= '9'; }
  private isIdentStart(ch: string): boolean { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'; }
  private isIdentPart(ch: string): boolean { return this.isIdentStart(ch) || this.isDigit(ch); }
}

export class SqlSyntaxError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`SQL syntax error at position ${pos}: ${message}`);
    this.name = 'SqlSyntaxError';
    this.pos = pos;
  }
}
