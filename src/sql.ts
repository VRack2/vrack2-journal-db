// ============================================================
// sql.ts — SQL-lite поверх scan() (Фаза 5)
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

const AGG_FNS: readonly AggFn[] = ['min', 'max', 'sum', 'avg', 'count'];

/** Исключение парсинга SQL-lite. */
export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlError';
  }
}

// --------------------------------------------------
// Токенизатор
// --------------------------------------------------

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punct'; v: string };

const KEYWORDS = new Set([
  'SELECT', 'WHERE', 'AND', 'GROUP', 'BY', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'IN', 'NOT', 'IS', 'NULL', 'BETWEEN', 'AS', 'OFFSET',
  'INSERT', 'INTO', 'VALUES',
]);

/** Разбирает SQL на токены (без учёта ключевых слов — они распознаются по значению). */
function tokenize(sql: string): Tok[] {
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
      if (j >= n) throw new SqlError('SQL: не закрытая строка');
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

    throw new SqlError(`SQL: неожиданный символ '${c}' в позиции ${i}`);
  }
  return toks;
}

// --------------------------------------------------
// Парсер
// --------------------------------------------------

interface Cursor {
  toks: Tok[];
  i: number;
}

function peek(c: Cursor): Tok | undefined {
  return c.toks[c.i];
}

function next(c: Cursor): Tok {
  const t = c.toks[c.i];
  if (!t) throw new SqlError('SQL: неожиданный конец запроса');
  c.i++;
  return t;
}

function isKw(t: Tok | undefined, kw: string): boolean {
  return !!t && t.t === 'id' && t.v.toUpperCase() === kw;
}

function isPunct(t: Tok | undefined, p: string): boolean {
  return !!t && t.t === 'punct' && t.v === p;
}

function expectKw(c: Cursor, kw: string): void {
  const t = next(c);
  if (!isKw(t, kw)) throw new SqlError(`SQL: ожидалось ${kw}, получено ${t.v}`);
}

function expectPunct(c: Cursor, p: string): void {
  const t = next(c);
  if (!isPunct(t, p)) throw new SqlError(`SQL: ожидалось '${p}', получено ${t.v}`);
}

/** Идентификатор (поле/ключ). */
function nextId(c: Cursor): string {
  const t = next(c);
  if (t.t !== 'id') throw new SqlError(`SQL: ожидалось имя поля, получено ${t.v}`);
  return t.v;
}

/** Значение: число, строка, true/false или «голый» идентификатор. */
function parseValue(c: Cursor): number | string | boolean {
  const t = next(c);
  if (t.t === 'num' || t.t === 'str') return t.v;
  if (t.t === 'id') {
    const u = t.v.toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    if (!KEYWORDS.has(u)) return t.v;
  }
  throw new SqlError(`SQL: ожидалось значение (число, строка или true/false), получено ${t.v}`);
}

interface Item {
  agg: { fn: AggFn; field: string } | null;
  field: string;
  star: boolean;
}

/** Один элемент SELECT: `*`, `поле` или `fn(поле)`. */
function parseItem(c: Cursor): Item {
  const t = peek(c);
  if (!t) throw new SqlError('SQL: пустой список SELECT');
  if (isPunct(t, '*')) {
    next(c);
    return { agg: null, field: '*', star: true };
  }
  const name = nextId(c);
  if (isPunct(peek(c), '(')) {
    // Вызов функции
    next(c); // '('
    const fieldName = nextId(c);
    expectPunct(c, ')');
    const fn = name.toLowerCase();
    if (!(AGG_FNS as readonly string[]).includes(fn)) {
      throw new SqlError(`SQL: неизвестная функция '${name}' (допустимо: ${AGG_FNS.join('|')})`);
    }
    return { agg: { fn: fn as AggFn, field: fieldName }, field: fieldName, star: false };
  }
  return { agg: null, field: name, star: false };
}

/** Список элементов SELECT до ключевого слова/конца. */
function parseItems(c: Cursor): Item[] {
  const items = [parseItem(c)];
  while (isPunct(peek(c), ',')) {
    next(c);
    items.push(parseItem(c));
  }
  return items;
}

const OP_MAP: Record<string, ScanWhere['op']> = {
  '=': 'eq', '!=': 'ne', '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge',
};

/**
 * Одно условие WHERE. Пишет в opts.where, либо (для `ts BETWEEN`) — в
 * opts.start/opts.end (быстрый путь сегментов).
 */
function parseCond(c: Cursor, opts: ScanOptions): void {
  const field = nextId(c);
  const t = peek(c);

  // BETWEEN
  if (isKw(t, 'BETWEEN')) {
    next(c);
    const a = parseValue(c);
    expectKw(c, 'AND');
    const b = parseValue(c);
    if (field.toLowerCase() === 'ts') {
      if (typeof a === 'boolean' || typeof b === 'boolean') {
        throw new SqlError('SQL: ts BETWEEN — значение должно быть числом (мс) или строкой вида \'now-1h\'');
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
  if (isKw(t, 'IS')) {
    next(c);
    const t2 = next(c);
    if (isKw(t2, 'NOT')) {
      const t3 = next(c);
      if (!isKw(t3, 'NULL')) throw new SqlError('SQL: ожидалось NULL после IS NOT');
      opts.where!.push({ field, op: 'isNotNull' });
    } else if (isKw(t2, 'NULL')) {
      opts.where!.push({ field, op: 'isNull' });
    } else {
      throw new SqlError(`SQL: ожидалось NULL или NOT после IS, получено ${t2.v}`);
    }
    return;
  }

  // NOT IN
  if (isKw(t, 'NOT')) {
    next(c);
    const t2 = next(c);
    if (!isKw(t2, 'IN')) throw new SqlError(`SQL: ожидалось IN после NOT, получено ${t2.v}`);
    expectPunct(c, '(');
    const vals: JsonValue[] = [parseValue(c)];
    while (isPunct(peek(c), ',')) {
      next(c);
      vals.push(parseValue(c));
    }
    expectPunct(c, ')');
    opts.where!.push({ field, op: 'nin', value: vals });
    return;
  }

  // IN
  if (isKw(t, 'IN')) {
    next(c);
    expectPunct(c, '(');
    const vals: JsonValue[] = [parseValue(c)];
    while (isPunct(peek(c), ',')) {
      next(c);
      vals.push(parseValue(c));
    }
    expectPunct(c, ')');
    opts.where!.push({ field, op: 'in', value: vals });
    return;
  }

  // Сравнение
  if (t && t.t === 'op' && t.v in OP_MAP) {
    const op = OP_MAP[t.v];
    next(c);
    const v = parseValue(c);
    opts.where!.push({ field, op, value: v });
    return;
  }

  throw new SqlError(`SQL: неизвестный оператор в условии (поле '${field}')`);
}

/**
 * Компилирует SQL-lite в опции Journal.scan().
 * Бросает SqlError при синтаксической ошибке.
 */
export function parseSql(query: string): ScanOptions {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new SqlError('SQL: пустой запрос');
  }
  const toks = tokenize(query);
  if (toks.length === 0) throw new SqlError('SQL: пустой запрос');
  const c: Cursor = { toks, i: 0 };
  const opts: ScanOptions = {};

  expectKw(c, 'SELECT');
  const items = parseItems(c);

  // WHERE
  if (isKw(peek(c), 'WHERE')) {
    next(c);
    opts.where = [];
    parseCond(c, opts);
    while (isKw(peek(c), 'AND')) {
      next(c);
      parseCond(c, opts);
    }
  }

  // GROUP BY
  const explicitGroup: string[] = [];
  if (isKw(peek(c), 'GROUP')) {
    next(c);
    expectKw(c, 'BY');
    explicitGroup.push(nextId(c));
    while (isPunct(peek(c), ',')) {
      next(c);
      explicitGroup.push(nextId(c));
    }
  }

  // ORDER BY
  let order: 'asc' | 'desc' | null = null;
  if (isKw(peek(c), 'ORDER')) {
    next(c);
    expectKw(c, 'BY');
    // Опциональный ключ (скан сортирует по первому ключу агрегата / ts / select[0]).
    const t = peek(c);
    if (t && t.t === 'id' && !isKw(t, 'ASC') && !isKw(t, 'DESC')) {
      next(c); // ключ
    }
    const d = peek(c);
    if (isKw(d, 'ASC')) { next(c); order = 'asc'; }
    else if (isKw(d, 'DESC')) { next(c); order = 'desc'; }
  }

  // LIMIT [OFFSET]
  if (isKw(peek(c), 'LIMIT')) {
    next(c);
    const lt = next(c);
    if (lt.t !== 'num') throw new SqlError(`SQL: LIMIT должен быть целым числом, получено ${lt.v}`);
    let limitVal = lt.v;
    if (isPunct(peek(c), ',')) {
      // LIMIT offset, count
      next(c);
      const ct = next(c);
      if (ct.t !== 'num') throw new SqlError(`SQL: LIMIT offset,count — count должен быть числом, получено ${ct.v}`);
      opts.offset = limitVal;
      limitVal = ct.v;
    }
    opts.limit = limitVal;
  }
  if (isKw(peek(c), 'OFFSET')) {
    next(c);
    const ot = next(c);
    if (ot.t !== 'num') throw new SqlError(`SQL: OFFSET должен быть целым числом, получено ${ot.v}`);
    opts.offset = ot.v;
  }

  // Остаток токенов — ошибка
  if (c.i < toks.length) {
    throw new SqlError(`SQL: неожиданные токены в конце запроса (${toks[c.i].v} ...)`);
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

// --------------------------------------------------
// INSERT INTO
// --------------------------------------------------

/** Результат парсинга INSERT INTO. */
export interface InsertQuery {
  /** Имя журнала-цели (должно совпадать с именем журнала, на котором выполняется). */
  name: string;
  /** Строки для записи: колонки из запроса в порядке списка. */
  rows: Row[];
}

/**
 * Парсит `INSERT INTO name (col, ...) VALUES (v, ...)[, (v, ...), ...]`.
 * Значения: число, строка, `true`/`false` или «голый» идентификатор
 * (не ключевое слово). Бросает SqlError при синтаксической ошибке.
 */
export function parseInsert(sql: string): InsertQuery {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new SqlError('SQL: пустой запрос');
  }
  const toks = tokenize(sql);
  if (toks.length === 0) throw new SqlError('SQL: пустой запрос');
  const c: Cursor = { toks, i: 0 };

  expectKw(c, 'INSERT');
  expectKw(c, 'INTO');
  const name = nextId(c);

  expectPunct(c, '(');
  const cols: string[] = [nextId(c)];
  while (isPunct(peek(c), ',')) {
    next(c);
    cols.push(nextId(c));
  }
  expectPunct(c, ')');

  expectKw(c, 'VALUES');
  const parseRow = (): Row => {
    expectPunct(c, '(');
    const row: Row = {};
    let k = 0;
    row[cols[0]] = parseValue(c);
    while (isPunct(peek(c), ',')) {
      next(c);
      k++;
      if (k >= cols.length) {
        throw new SqlError(`SQL: INSERT INTO — значений больше, чем колонок (${cols.length})`);
      }
      row[cols[k]] = parseValue(c);
    }
    if (k + 1 !== cols.length) {
      throw new SqlError(`SQL: INSERT INTO — ожидается ${cols.length} значени(я), получено ${k + 1}`);
    }
    expectPunct(c, ')');
    return row;
  };
  const rows: Row[] = [parseRow()];
  while (isPunct(peek(c), ',')) {
    next(c);
    rows.push(parseRow());
  }

  if (c.i < toks.length) {
    throw new SqlError(`SQL: неожиданные токены в конце запроса (${toks[c.i].v} ...)`);
  }
  return { name, rows };
}
