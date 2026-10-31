// ============================================================
// test-deleteby.ts — deleteBy(where): удаление строк по предикату
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal/Journal.ts';
import { Store } from '../src/store/Store.ts';
import { defineLogTable } from '../src/compaction/define.ts';
import ErrorManager from '../src/errors/ErrorManager.ts';
import type { Schema } from '../src/core/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'deleteby');

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

fs.rmSync(baseDir, { recursive: true, force: true });

const schema: Schema = { ts: 'delta', val: 'dictionary', host: 'dictionary' };
const segFiles = (name: string): string[] =>
  fs.readdirSync(path.join(baseDir, 'journals', name)).filter(f => f.endsWith('.seg'));

// --------------------------------------------------
// 1. Базовый: eq-предикат удаляет подходящие строки
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('basic', schema);
  for (let i = 0; i < 9; i++) j.append({ ts: i, val: `v${i}`, host: i % 2 === 0 ? 'a' : 'b' });
  assert(segFiles('basic').length === 3, `до deleteBy: 3 сегмента (факт ${segFiles('basic').length})`);

  const res = j.deleteBy([{ field: 'host', op: 'eq', value: 'a' }]);
  assert(res.removedRows === 5, `удалено 5 строк (факт ${res.removedRows})`);
  const rows = j.allRows();
  assert(rows.length === 4, `осталось 4 строки (факт ${rows.length})`);
  assert(rows.every(r => r.host === 'b'), 'все оставшиеся host=b');
  j.close();
}

// --------------------------------------------------
// 2. Несколько условий (AND)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 4 });
  j.open('and', schema);
  j.append({ ts: 1, val: 'x', host: 'a' });
  j.append({ ts: 2, val: 'y', host: 'a' });
  j.append({ ts: 3, val: 'x', host: 'b' });
  j.append({ ts: 4, val: 'y', host: 'b' });
  j.flush();
  j.append({ ts: 5, val: 'x', host: 'a' });
  j.append({ ts: 6, val: 'y', host: 'a' });

  const res = j.deleteBy([
    { field: 'host', op: 'eq', value: 'a' },
    { field: 'val', op: 'eq', value: 'x' },
  ]);
  assert(res.removedRows === 2, `AND: удалено 2 (факт ${res.removedRows})`);
  const rows = j.allRows();
  assert(rows.length === 4, `AND: осталось 4 (факт ${rows.length})`);
  assert(!rows.some(r => r.host === 'a' && r.val === 'x'), 'AND: нет (a,x)');
  j.close();
}

// --------------------------------------------------
// 3. Оператор in
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 5 });
  j.open('inop', schema);
  for (let i = 0; i < 10; i++) j.append({ ts: i, val: `v${i}`, host: `h${i % 3}` });
  j.flush();

  const res = j.deleteBy([{ field: 'host', op: 'in', value: ['h0', 'h2'] }]);
  assert(res.removedRows === 7, `in: удалено 7 (факт ${res.removedRows})`);
  const rows = j.allRows();
  assert(rows.length === 3, `in: осталось 3 (факт ${rows.length})`);
  assert(rows.every(r => r.host === 'h1'), 'in: все оставшиеся h1');
  j.close();
}

// --------------------------------------------------
// 4. Оператор ne (не пропускается zone-map → полный скан)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('ne', schema);
  for (let i = 0; i < 6; i++) j.append({ ts: i, val: `v${i}`, host: i < 3 ? 'x' : 'y' });
  j.flush();

  const res = j.deleteBy([{ field: 'host', op: 'ne', value: 'x' }]);
  assert(res.removedRows === 3, `ne: удалено 3 (факт ${res.removedRows})`);
  const rows = j.allRows();
  assert(rows.length === 3, `ne: осталось 3 (факт ${rows.length})`);
  assert(rows.every(r => r.host === 'x'), 'ne: все оставшиеся x');
  j.close();
}

// --------------------------------------------------
// 5. Удаление всех строк из сегмента → drop whole segment
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('dropall', schema);
  j.append({ ts: 1, val: 'a1', host: 'a' });
  j.append({ ts: 2, val: 'a2', host: 'a' });
  j.append({ ts: 3, val: 'a3', host: 'a' });
  j.flush();
  j.append({ ts: 4, val: 'b1', host: 'b' });
  j.append({ ts: 5, val: 'b2', host: 'b' });
  j.append({ ts: 6, val: 'b3', host: 'b' });
  j.flush();

  const res = j.deleteBy([{ field: 'host', op: 'eq', value: 'a' }]);
  assert(res.removedRows === 3, `dropall: удалено 3 (факт ${res.removedRows})`);
  assert(res.removedSegments === 1, `dropall: 1 сегмент удалён целиком (факт ${res.removedSegments})`);
  assert(res.rewrittenSegments === 0, `dropall: 0 переписано (факт ${res.rewrittenSegments})`);
  assert(j.allRows().length === 3, 'dropall: 3 строки осталось');
  j.close();
}

// --------------------------------------------------
// 6. Пустой where → удаляет всё (delete where 1=1)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('noop', schema);
  for (let i = 0; i < 6; i++) j.append({ ts: i, val: `v${i}`, host: 'z' });
  j.flush();

  const res = j.deleteBy([]);
  assert(res.removedRows === 6, `noop: пустой where удаляет все 6 (факт ${res.removedRows})`);
  assert(j.allRows().length === 0, 'noop: таблица пуста');
  j.close();
}

// --------------------------------------------------
// 7. Персистентность: после reopen удалённые не возвращаются
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('persist', schema);
  for (let i = 0; i < 6; i++) j.append({ ts: i, val: `v${i}`, host: i % 2 === 0 ? 'a' : 'b' });
  j.flush();
  j.deleteBy([{ field: 'host', op: 'eq', value: 'a' }]);
  j.close();

  const j2 = new Journal(baseDir, { rowsPerSegment: 3 });
  j2.open('persist', schema);
  const rows = j2.allRows();
  assert(rows.length === 3, `persist: 3 строки после reopen (факт ${rows.length})`);
  assert(rows.every(r => r.host === 'b'), 'persist: только host=b');
  j2.close();
}

// --------------------------------------------------
// 8. deleteBy на закрытом журнале → ошибка
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('closed', schema);
  j.append({ ts: 1, val: 'x', host: 'a' });
  j.close();
  let threw = false;
  try {
    j.deleteBy([{ field: 'host', op: 'eq', value: 'a' }]);
  } catch (e) {
    threw = /not open/i.test(String(e));
  }
  assert(threw, 'deleteBy на закрытом журнале → ошибка');
}

// --------------------------------------------------
// 9. deleteBy через Table API (одиночный журнал)
// --------------------------------------------------
{
  const dir = path.join(baseDir, 'tbl');
  fs.rmSync(dir, { recursive: true, force: true });
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'metrics',
    columns: { ts: 'delta', value: 'auto', host: 'dictionary' },
  }));
  for (let i = 0; i < 10; i++) t.append({ ts: i, value: i * 10, host: i % 3 === 0 ? 'x' : 'y' });
  t.flush();

  const res = t.deleteBy([{ field: 'host', op: 'eq', value: 'x' }]);
  assert(res.removedRows === 4, `table: удалено 4 (факт ${res.removedRows})`);
  const rows = t.allRows();
  assert(rows.length === 6, `table: осталось 6 (факт ${rows.length})`);
  assert(rows.every(r => r.host === 'y'), 'table: все host=y');
  t.close();
  store.closeAll();
}

// --------------------------------------------------
// 10. deleteBy через Table API (тир-режим)
// --------------------------------------------------
{
  const dir = path.join(baseDir, 'tier');
  fs.rmSync(dir, { recursive: true, force: true });
  const store = new Store(dir, { autoCompact: false });
  const t = store.create(defineLogTable({
    name: 'tiered',
    columns: { ts: 'delta', value: 'auto', host: 'dictionary' },
    retention: '5s:1d',
    agg: { value: 'avg' },
  }));
  for (let i = 0; i < 5; i++) t.append({ ts: 1000 + i, value: i, host: i % 2 === 0 ? 'a' : 'b' });
  t.flush();

  const res = t.deleteBy([{ field: 'host', op: 'eq', value: 'a' }]);
  assert(res.removedRows === 3, `tier: удалено 3 (факт ${res.removedRows})`);
  const rows = t.allRows();
  assert(rows.length === 2, `tier: осталось 2 (факт ${rows.length})`);
  assert(rows.every(r => r.host === 'b'), 'tier: все host=b');
  t.close();
  store.closeAll();
}

// --------------------------------------------------
// 11. Идемпотентность: повторный deleteBy → 0 удалений
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('idemp', schema);
  for (let i = 0; i < 6; i++) j.append({ ts: i, val: `v${i}`, host: i % 2 === 0 ? 'a' : 'b' });
  j.flush();

  const r1 = j.deleteBy([{ field: 'host', op: 'eq', value: 'a' }]);
  assert(r1.removedRows === 3, `idemp: первый проход удалил 3 (факт ${r1.removedRows})`);

  const r2 = j.deleteBy([{ field: 'host', op: 'eq', value: 'a' }]);
  assert(r2.removedRows === 0, `idemp: второй проход удалил 0 (факт ${r2.removedRows})`);
  assert(j.allRows().length === 3, 'idemp: 3 строки на месте');
  j.close();
}

// --------------------------------------------------
// 12. Числовой предикат (gt)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 4 });
  j.open('gt', schema);
  for (let i = 0; i < 8; i++) j.append({ ts: i, val: `v${i}`, host: 'h' });
  j.flush();

  const res = j.deleteBy([{ field: 'ts', op: 'gt', value: 4 }]);
  assert(res.removedRows === 3, `gt: удалено 3 (факт ${res.removedRows})`);
  const rows = j.allRows();
  assert(rows.length === 5, `gt: осталось 5 (факт ${rows.length})`);
  assert(rows.every(r => (r.ts as number) <= 4), 'gt: все ts <= 4');
  j.close();
}

// --------------------------------------------------
// Summary
// --------------------------------------------------
console.log(`\ndeleteBy: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
