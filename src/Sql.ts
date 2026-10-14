// ============================================================
// Sql.ts — SQL-lite поверх scan() (Фаза 5)
//
// Тонкий парсер (не диалект): компилирует SQL-подобный запрос в опции
// Journal.scan() и передаёт дальше. Поддерживаемая форма:
//
//   SELECT <элементы>
//   [WHERE <условие> [AND <условие> ...]]
//   [GROUP BY <поле> [, <поле> ...]]
//   [ORDER BY [<ключ>] [ASC|DESC]]
//   [LIMIT n [OFFSET m]]
//
//   INSERT INTO <журнал> (<колонки>) VALUES (<значения>)[, (<значения>), ...]
//
// Элементы SELECT:
//   *            — все поля схемы (режим без агрегатов);
//   поле         — колонка (в режиме агрегатов — поле группировки);
//   fn(поле)     — агрегат: avg|min|max|sum|count (включает режим агрегации).
//
// Условия WHERE (соединяются И/AND):
//   поле = v | != v | <> v | < v | <= v | > v | >= v
//   поле BETWEEN v AND v      (для ts — диапазон start/end, иначе две границы)
//   поле IN (v, ...) | NOT IN (v, ...)
//   поле IS NULL | IS NOT NULL
//
// Значения: число (123, -4.5) или строка ('text', 'now-1h').
//
// Примеры:
//   SELECT avg(value), host WHERE value > 90 GROUP BY host ORDER BY value_avg DESC LIMIT 20
//   SELECT host, value WHERE ts BETWEEN 'now-1h' AND 'now' AND host = 'web-1' ORDER BY ts DESC LIMIT 10
//   SELECT * WHERE level IN ('error', 'warn') LIMIT 50
// ============================================================

import type { AggFn, JsonValue, Row, ScanOptions, ScanWhere } from './types.ts';
import ErrorManager from './errors/ErrorManager.ts';

ErrorManager.registerMany('Sql', [
  { short: 'SQL_EMPTY', description: 'SQL: пустой запрос' },
  { short: 'SQL_LIMIT_NUM', description: 'SQL: LIMIT должен быть целым числом', rules: { got: 'string' } },
  { short: 'SQL_LIMIT_COUNT', description: 'SQL: LIMIT offset,count — count должен быть числом', rules: { got: 'string' } },
  { short: 'SQL_OFFSET_NUM', description: 'SQL: OFFSET должен быть целым числом', rules: { got: 'string' } },
  { short: 'SQL_TRAILING', description: 'SQL: неожиданные токены в конце запроса', rules: { tok: 'string' } },
  { short: 'SQL_STR_UNCLOSED', description: 'SQL: не закрытая строка' },
  { short: 'SQL_BAD_CHAR', description: 'SQL: неожиданный символ', rules: { ch: 'string', pos: 'number' } },
  { short: 'SQL_EOF', description: 'SQL: неожиданный конец запроса' },
  { short: 'SQL_EXPECT_KW', description: 'SQL: ожидалось ключевое слово', rules: { kw: 'string', got: 'string' } },
  { short: 'SQL_EXPECT_PUNCT', description: 'SQL: ожидалась пунктуация', rules: { p: 'string', got: 'string' } },
  { short: 'SQL_EXPECT_ID', description: 'SQL: ожидалось имя поля', rules: { got: 'string' } },
  { short: 'SQL_EXPECT_VALUE', description: 'SQL: ожидалось значение (число, строка или true/false)', rules: { got: 'string' } },
  { short: 'SQL_SELECT_EMPTY', description: 'SQL: пустой список SELECT' },
  { short: 'SQL_FN_UNKNOWN', description: 'SQL: неизвестная функция', rules: { name: 'string', allowed: 'string' } },
  { short: 'SQL_TS_BETWEEN', description: "SQL: ts BETWEEN — значение должно быть числом (мс) или строкой вида 'now-1h'" },
  { short: 'SQL_IS_NOT', description: 'SQL: ожидалось NULL после IS NOT' },
  { short: 'SQL_IS_OP', description: 'SQL: ожидалось NULL или NOT после IS', rules: { got: 'string' } },
  { short: 'SQL_NOT_IN', description: 'SQL: ожидалось IN после NOT', rules: { got: 'string' } },
  { short: 'SQL_OP_UNKNOWN', description: 'SQL: неизвестный оператор в условии', rules: { field: 'string' } },
  { short: 'SQL_INSERT_MORE', description: 'SQL: INSERT INTO — значений больше, чем колонок', rules: { cols: 'number' } },
  { short: 'SQL_INSERT_COUNT', description: 'SQL: INSERT INTO — ожидается N значени(я)', rules: { cols: 'number', got: 'number' } },
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

/** Результат парсинга INSERT INTO. */
export interface InsertQuery {
  /** Имя журнала-цели (должно совпадать с именем журнала, на котором выполняется). */
  name: string;
  /** Строки для записи: колонки из запроса в порядке списка. */
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
   * Компилирует SQL-lite (SELECT) в опции Journal.scan().
    * Бросает ошибку (код SQL_*) при синтаксической ошибке.
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

    // FROM <таблица> (Фаза 4) — имя целевого журнала; Journal.sql() сверит с this.name.
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
      // Опциональный ключ (скан сортирует по первому ключу агрегата / ts / select[0]).
      const t = this.peek(c);
      if (t && t.t === 'id' && !this.isKw(t, 'ASC') && !this.isKw(t, 'DESC')) {
        this.next(c); // ключ
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

    // Остаток токенов — ошибка
    if (c.i < toks.length) {
      throw ErrorManager.make('SQL_TRAILING', { tok: String(toks[c.i].v) });
    }

    // --------------------------------------------------
    // Режим агрегации vs raw
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
      // stars → select не задаём: scan() по умолчанию берёт все поля схемы.
    }

    if (order) opts.order = order;

    return opts;
  }

  /**
   * Парсит `INSERT INTO name (col, ...) VALUES (v, ...)[, (v, ...), ...]`.
   * Значения: число, строка, `true`/`false` или «голый» идентификатор
    * (не ключевое слово). Бросает ошибку (код SQL_*) при синтаксической ошибке.
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
  // Токенизатор
  // --------------------------------------------------

  /** Разбирает SQL на токены (без учёта ключевых слов — они распознаются по значению). */
  private static tokenize(sql: string): Tok[] {
    const toks: Tok[] = [];
    const n = sql.length;
    let i = 0;
    while (i < n) {
      const c = sql[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

      // Строка
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

      // Идентификатор / ключевое слово.
      // ВАЖНО: пробуем ДО числа — именованная колонка с цифрой (host9, c3) не
      // должна съедаться числовым правилом как «9».
      const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
      if (idMatch) {
        toks.push({ t: 'id', v: idMatch[0] });
        i += idMatch[0].length;
        continue;
      }

      // Число (только если не начало идентификатора)
      const numMatch = /^-?\d+(?:\.\d+)?/.exec(sql.slice(i));
      if (numMatch && (i === 0 || /\s/.test(sql[i - 1]) || sql[i - 1] === '(' || sql[i - 1] === ',')) {
        toks.push({ t: 'num', v: parseFloat(numMatch[0]) });
        i += numMatch[0].length;
        continue;
      }
      // Операторы (двухсимвольные в первую очередь)
      const two = sql.slice(i, i + 2);
      if (two === '!=' || two === '<>' || two === '<=' || two === '>=') {
        toks.push({ t: 'op', v: two });
        i += 2;
        continue;
      }

      // Односимвольные
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
  // Парсер (курсор)
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

  /** Идентификатор (поле/ключ). */
  private static nextId(c: Cursor): string {
    const t = this.next(c);
    if (t.t !== 'id') throw ErrorManager.make('SQL_EXPECT_ID', { got: String(t.v) });
    return t.v;
  }

  /** Значение: число, строка, true/false или «голый» идентификатор. */
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

  /** Один элемент SELECT: `*`, `поле` или `fn(поле)`. */
  private static parseItem(c: Cursor): Item {
    const t = this.peek(c);
    if (!t) throw ErrorManager.make('SQL_SELECT_EMPTY');
    if (this.isPunct(t, '*')) {
      this.next(c);
      return { agg: null, field: '*', star: true };
    }
    const name = this.nextId(c);
    if (this.isPunct(this.peek(c), '(')) {
      // Вызов функции
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

  /** Список элементов SELECT до ключевого слова/конца. */
  private static parseItems(c: Cursor): Item[] {
    const items = [this.parseItem(c)];
    while (this.isPunct(this.peek(c), ',')) {
      this.next(c);
      items.push(this.parseItem(c));
    }
    return items;
  }

  /**
   * Одно условие WHERE. Пишет в opts.where, либо (для `ts BETWEEN`) — в
   * opts.start/opts.end (быстрый путь сегментов).
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

    // Сравнение
    if (t && t.t === 'op' && t.v in OP_MAP) {
      const op = OP_MAP[t.v];
      this.next(c);
      const v = this.parseValue(c);
      opts.where!.push({ field, op, value: v });
      return;
    }

    throw ErrorManager.make('SQL_OP_UNKNOWN', { field });
  }

  /** Одна строка INSERT: `(v, ...)`. */
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
