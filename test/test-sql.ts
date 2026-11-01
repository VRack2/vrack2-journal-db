// ============================================================
// test-sql.ts — SQL parser + integration with Table.scan()
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/index.ts';
import { parseSql, SqlSyntaxError } from '../src/sql/index.ts';
import type { SqlSelectQuery } from '../src/sql/index.ts';
import { defineLogTable } from '../src/compaction/define.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'sql');

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}`); }
}

function assertThrows(fn: () => void, msg: string): void {
  try { fn(); failed++; console.error(`FAIL (no throw): ${msg}`); }
  catch { passed++; }
}

/** Narrow parseSql result to SELECT (all existing tests are SELECT). */
function sel(sql: string): SqlSelectQuery {
  const q = parseSql(sql);
  if (q.kind !== 'select') throw new Error(`expected SELECT, got ${q.kind}`);
  return q;
}

// --------------------------------------------------
// 1. Parser unit tests (parseSql → SqlQuery)
// --------------------------------------------------

{
  const q = sel("SELECT host, value FROM cpu");
  assert(q.table === 'cpu', 'table name parsed');
  assert(q.opts.select!.length === 2 && q.opts.select![0] === 'host', 'select fields');
}

{
  const q = sel("SELECT * FROM events");
  assert(q.table === 'events', 'SELECT * → no select (all fields)');
  assert(q.opts.select === undefined, 'SELECT * → select is undefined');
}

{
  const q = sel("SELECT host FROM cpu WHERE value > 42 AND host = 'web-1'");
  assert(q.opts.where!.length === 2, 'two where conditions');
  assert(q.opts.where![0].field === 'value' && q.opts.where![0].op === 'gt' && q.opts.where![0].value === 42, 'value > 42');
  assert(q.opts.where![1].field === 'host' && q.opts.where![1].op === 'eq' && q.opts.where![1].value === 'web-1', "host = 'web-1'");
}

{
  const q = sel("SELECT host FROM cpu WHERE ts >= 1000 AND ts <= 2000");
  assert(q.opts.start === 1000, 'ts >= → start');
  assert(q.opts.end === 2000, 'ts <= → end');
  assert(q.opts.where === undefined, 'ts conditions not in where[]');
}

{
  const q = sel("SELECT host FROM cpu WHERE ts >= 'now-1h' AND ts <= 'now'");
  assert(q.opts.start === 'now-1h', 'ts >= string → start');
  assert(q.opts.end === 'now', 'ts <= string → end');
}

{
  const q = sel("SELECT host FROM cpu WHERE host IN ('a', 'b', 'c')");
  assert(q.opts.where![0].op === 'in', 'IN operator');
  assert(Array.isArray(q.opts.where![0].value) && (q.opts.where![0].value as string[]).length === 3, 'IN array');
}

{
  const q = sel("SELECT host FROM cpu WHERE host NOT IN ('x', 'y')");
  assert(q.opts.where![0].op === 'nin', 'NOT IN → nin');
}

{
  const q = sel("SELECT host FROM cpu WHERE value IS NULL");
  assert(q.opts.where![0].op === 'isNull', 'IS NULL');
}

{
  const q = sel("SELECT host FROM cpu WHERE value IS NOT NULL");
  assert(q.opts.where![0].op === 'isNotNull', 'IS NOT NULL');
}

{
  const q = sel("SELECT host, avg(value), max(value) FROM cpu GROUP BY host");
  assert(q.opts.agg !== undefined, 'agg present');
  assert(q.opts.agg!['value'].includes('avg') && q.opts.agg!['value'].includes('max'), 'avg + max');
  assert(q.opts.groupBy!.includes('host'), 'groupBy host');
}

{
  const q = sel("SELECT host FROM cpu ORDER BY value DESC LIMIT 10 OFFSET 5");
  assert(q.opts.order === 'desc', 'ORDER BY DESC');
  assert(q.opts.limit === 10, 'LIMIT 10');
  assert(q.opts.offset === 5, 'OFFSET 5');
}

{
  const q = sel("SELECT host FROM cpu WHERE value != 0");
  assert(q.opts.where![0].op === 'ne', '!= → ne');
}

{
  const q = sel("SELECT host FROM cpu WHERE value <= 100");
  assert(q.opts.where![0].op === 'le', '<= → le');
}

{
  const q = sel("SELECT host FROM cpu WHERE value < 100");
  assert(q.opts.where![0].op === 'lt', '< → lt');
}

{
  const q = sel("SELECT host FROM cpu WHERE value >= 100");
  assert(q.opts.where![0].op === 'ge', '>= → ge');
}


// --------------------------------------------------
// 1b. INSERT parser tests
// --------------------------------------------------

{
  const q = parseSql("INSERT INTO cpu (ts, host, value) VALUES (1000, 'web-1', 42.3)");
  assert(q.kind === 'insert', 'INSERT kind');
  if (q.kind === 'insert') {
    assert(q.table === 'cpu', 'INSERT table name');
    assert(q.rows.length === 1, 'INSERT one row');
    assert(q.rows[0].ts === 1000, 'INSERT ts value');
    assert(q.rows[0].host === 'web-1', 'INSERT host value');
    assert(q.rows[0].value === 42.3, 'INSERT float value');
    assert(q.positional === false, 'INSERT with columns → not positional');
  }
}

{
  const q = parseSql("INSERT INTO cpu (ts, host, value) VALUES (1, 'a', 10), (2, 'b', 20)");
  assert(q.kind === 'insert', 'INSERT multi-row kind');
  if (q.kind === 'insert') {
    assert(q.rows.length === 2, 'INSERT two rows');
    assert(q.rows[1].host === 'b', 'second row host');
  }
}

{
  const q = parseSql("INSERT INTO cpu VALUES (1000, 'web-1', 42.3)");
  assert(q.kind === 'insert', 'INSERT positional kind');
  if (q.kind === 'insert') {
    assert(q.positional === true, 'INSERT without columns → positional');
    assert(q.rows[0].__pos0 === 1000, 'positional pos0');
    assert(q.rows[0].__pos1 === 'web-1', 'positional pos1');
    assert(q.rows[0].__pos2 === 42.3, 'positional pos2');
  }
}

{
  const q = parseSql("INSERT INTO t (a, b) VALUES (NULL, TRUE)");
  assert(q.kind === 'insert', 'INSERT NULL/TRUE');
  if (q.kind === 'insert') {
    assert(q.rows[0].a === null, 'NULL literal');
    assert(q.rows[0].b === true, 'TRUE literal');
  }
}

{
  assertThrows(() => parseSql("INSERT INTO t (a, b) VALUES (1)"), 'INSERT column count mismatch');
  assertThrows(() => parseSql("INSERT t VALUES (1)"), 'INSERT missing INTO');
  assertThrows(() => parseSql("INSERT INTO t VALUES"), 'INSERT missing VALUES tuple');
}


// --------------------------------------------------
// 2. Integration: Store.sql() + Table.sql()
// --------------------------------------------------

fs.rmSync(baseDir, { recursive: true, force: true });

{
  const store = new Store(baseDir);
  const t = store.create(defineLogTable({
    name: 'cpu',
    columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
  }));

  const now = Date.now();
  t.append({ ts: now - 5000, host: 'web-1', value: 10 });
  t.append({ ts: now - 4000, host: 'web-1', value: 20 });
  t.append({ ts: now - 3000, host: 'web-2', value: 30 });
  t.append({ ts: now - 2000, host: 'web-2', value: 40 });
  t.append({ ts: now - 1000, host: 'web-1', value: 50 });
  t.flush();

  // Table.sql()
  {
    const rows = t.sql("SELECT host, value FROM cpu WHERE value > 25");
    assert(rows.length === 3, `sql WHERE value > 25: 3 rows (got ${rows.length})`);
    assert(rows.every(r => (r.value as number) > 25), 'all rows have value > 25');
  }

  // Table.sql() with ts range
  {
    const rows = t.sql(`SELECT host, value FROM cpu WHERE ts >= ${now - 3000} AND ts <= ${now - 2000}`);
    assert(rows.length === 2, `sql ts range: 2 rows (got ${rows.length})`);
  }

  // Table.sql() with IN
  {
    const rows = t.sql("SELECT host, value FROM cpu WHERE host IN ('web-1')");
    assert(rows.length === 3, `sql IN: 3 rows for web-1 (got ${rows.length})`);
  }

  // Table.sql() with NOT IN
  {
    const rows = t.sql("SELECT host, value FROM cpu WHERE host NOT IN ('web-1')");
    assert(rows.length === 2, `sql NOT IN: 2 rows for web-2 (got ${rows.length})`);
  }

  // Table.sql() with LIMIT
  {
    const rows = t.sql("SELECT host, value FROM cpu LIMIT 2");
    assert(rows.length === 2, `sql LIMIT 2: 2 rows (got ${rows.length})`);
  }

  // Table.sql() with ORDER BY DESC + LIMIT
  {
    const rows = t.sql("SELECT host, value FROM cpu ORDER BY value DESC LIMIT 2");
    assert(rows.length === 2, 'ORDER BY DESC LIMIT 2: 2 rows');
    assert((rows[0].value as number) === 50 && (rows[1].value as number) === 40, 'desc order correct');
  }

  // Table.sql() with agg + groupBy
  {
    const rows = t.sql("SELECT avg(value), max(value) FROM cpu GROUP BY host");
    assert(rows.length === 2, `agg groupBy: 2 groups (got ${rows.length})`);
    const web1 = rows.find(r => r.host === 'web-1');
    const web2 = rows.find(r => r.host === 'web-2');
    assert(!!web1 && Math.abs((web1['value_avg'] as number) - 80 / 3) < 0.001, `web-1 avg = 80/3 (got ${web1?.['value_avg']})`);
    assert(!!web1 && web1['value_max'] === 50, 'web-1 max = 50');
    assert(!!web2 && web2['value_avg'] === 35, 'web-2 avg = 35');
    assert(!!web2 && web2['value_max'] === 40, 'web-2 max = 40');
  }

  // Store.sql() — resolves table from FROM
  {
    const rows = store.sql("SELECT host, value FROM cpu WHERE value >= 40");
    assert(rows.length === 2, `store.sql: 2 rows (got ${rows.length})`);
  }

  // SELECT * returns all fields
  {
    const rows = t.sql("SELECT * FROM cpu WHERE value = 10");
    assert(rows.length === 1, 'SELECT * returns 1 row');
    assert(rows[0].host === 'web-1' && rows[0].value === 10, 'SELECT * has all fields');
  }

  // INSERT INTO via Table.sql()
  {
    const inserted = t.sql("INSERT INTO cpu (ts, host, value) VALUES (9999, 'web-3', 99)");
    assert(inserted.length === 1, 'INSERT returns inserted row');
    assert(inserted[0].host === 'web-3' && inserted[0].value === 99, 'INSERT row content');
    const rows = t.sql("SELECT host, value FROM cpu WHERE host = 'web-3'");
    assert(rows.length === 1 && rows[0].value === 99, 'INSERT visible in subsequent SELECT');
  }

  // INSERT multi-row via Table.sql()
  {
    t.sql("INSERT INTO cpu (ts, host, value) VALUES (10001, 'web-4', 10), (10002, 'web-4', 20)");
    const rows = t.sql("SELECT host, value FROM cpu WHERE host = 'web-4'");
    assert(rows.length === 2, `INSERT multi-row: 2 rows (got ${rows.length})`);
  }

  // INSERT positional via Table.sql()
  {
    t.sql("INSERT INTO cpu VALUES (10003, 'web-5', 30)");
    const rows = t.sql("SELECT host, value FROM cpu WHERE host = 'web-5'");
    assert(rows.length === 1 && rows[0].value === 30, 'INSERT positional resolved via schema');
  }

  // INSERT via Store.sql()
  {
    store.sql("INSERT INTO cpu (ts, host, value) VALUES (10004, 'web-6', 40)");
    const rows = store.sql("SELECT host, value FROM cpu WHERE host = 'web-6'");
    assert(rows.length === 1 && rows[0].value === 40, 'store.sql INSERT works');
  }

  t.close();
  store.closeAll();
}

// --------------------------------------------------
// Summary
// --------------------------------------------------
console.log(`\ntest-sql: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

{
  const q = sel("select Host from Cpu where Value > 10");
  assert(q.table === 'Cpu', 'case: table name preserved');
  assert(q.opts.select![0] === 'Host', 'case: field name preserved');
  assert(q.opts.where![0].op === 'gt', 'case: keyword parsed');
}

assertThrows(() => parseSql("SELECT"), 'incomplete query throws');
assertThrows(() => parseSql("SELECT FROM cpu"), 'missing select list throws');
assertThrows(() => parseSql("SELECT host cpu"), 'missing FROM throws');
