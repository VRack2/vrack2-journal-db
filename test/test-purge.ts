// ============================================================
// test-purge.ts — purge(beforeTs): удаление строк старше границы
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/Journal.ts';
import type { Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'purge');

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

const schema: Schema = { ts: 'delta', val: 'dictionary' };
const segFiles = (name: string): string[] =>
  fs.readdirSync(path.join(baseDir, 'journals', name)).filter(f => f.endsWith('.json'));

// --------------------------------------------------
// 1. Purge посередине: целые сегменты удаляются, пересекающий перекодируется
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('mid', schema);
  for (let i = 0; i < 10; i++) j.append({ ts: i, val: `r${i}` });
  // сегменты: [0,1,2] [3,4,5] [6,7,8] + активный [9]
  assert(segFiles('mid').length === 3, `до purge: 3 закрытых сегмента (факт ${segFiles('mid').length})`);

  const res = j.purge(5); // остаются ts >= 5
  assert(res.removedRows === 5, `удалено 5 строк (факт ${res.removedRows})`);
  assert(res.removedSegments === 1, `целиком удалён 1 сегмент [0,1,2] (факт ${res.removedSegments})`);
  assert(res.rewrittenSegments === 1, `перекодирован 1 сегмент [3,4,5] (факт ${res.rewrittenSegments})`);

  const rows = j.allRows();
  assert(rows.length === 5, `осталось 5 строк (факт ${rows.length})`);
  assert(rows.map(r => r.ts).join(',') === '5,6,7,8,9', `значения ts: ${rows.map(r => r.ts)}`);
  assert(j.stats().totalRows === 5, 'stats() видит новые totalRows');

  const files = segFiles('mid');
  assert(files.length === 3, `после purge на диске 3 сегмента: [5] [6,7,8] [9] (факт ${files.length})`);

  // Переживает перезапуск: WAL не вернул удалённые строки, дублей нет
  j.close();
  const j2 = new Journal(baseDir, { rowsPerSegment: 3 });
  j2.open('mid', schema);
  const again = j2.allRows();
  assert(again.length === 5, `после reopen всё ещё 5 строк (факт ${again.length})`);
  assert(again.map(r => r.ts).join(',') === '5,6,7,8,9', 'после reopen: те же ts, без дублей');

  // Запись поверх очищенного хвоста работает
  j2.append({ ts: 10, val: 'after-purge' });
  assert(j2.allRows().length === 6, 'запись после purge работает');
  j2.close();
}

// --------------------------------------------------
// 2. Строки без ts в пересекающем сегменте никогда не удаляются
// --------------------------------------------------
{
  // ts-колонка должна допускать null: в delta строка без ts физически не живёт
  // (DeltaColumn.append(null) — TypeError), поэтому здесь 'raw'.
  const notsSchema: Schema = { ts: 'raw', val: 'dictionary' };
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('nots', notsSchema);
  j.append({ ts: 0, val: 'a' });
  j.append({ ts: 1, val: 'b' });
  j.append({ ts: 2, val: 'c' }); // flush → сегмент [0,1,2]
  j.append({ ts: 3, val: 'd' });
  j.append({ val: 'no-ts' });   // строка без ts — в пересекающем сегменте
  j.append({ ts: 5, val: 'e' });
  j.append({ ts: 6, val: 'f' }); // flush → сегмент [3, null, 5]

  const res = j.purge(4); // граница внутри сегмента [3, null, 5]
  assert(res.rewrittenSegments === 1, 'сегмент [3, null, 5] перекодирован');

  const rows = j.allRows();
  assert(rows.some(r => r.val === 'no-ts' && r.ts === null), 'строка без ts выжила');
  assert(rows.some(r => r.ts === 5), 'ts=5 >= 4 осталась');
  assert(!rows.some(r => r.ts === 3), 'ts=3 < 4 удалена');
  assert(!rows.some(r => r.ts === 0), 'старый целый сегмент удалён');
  j.close();
}

// --------------------------------------------------
// 3. Нефлашенные строки (WAL): purge их тоже видит и не «оживляет» после reopen
// --------------------------------------------------
{
  // flush не сработает (rowsPerSegment=1000), а walBatchSize=1 — каждая строка
  // сразу уходит в wal.log: строки реально «только в WAL» до purge.
  const j = new Journal(baseDir, { rowsPerSegment: 1000, walBatchSize: 1 });
  j.open('wal', schema);
  for (let i = 0; i < 5; i++) j.append({ ts: i, val: 'w' });
  const dir = path.join(baseDir, 'journals', 'wal');
  assert(fs.existsSync(path.join(dir, 'wal.log')), 'до purge строки ещё только в WAL');

  const res = j.purge(3);
  assert(res.removedRows === 3, `удалены 3 строки из WAL/активного (факт ${res.removedRows})`);
  const rows = j.allRows();
  assert(rows.map(r => r.ts).join(',') === '3,4', `в памяти остались [3,4] (факт ${rows.map(r => r.ts)})`);
  assert(!fs.existsSync(path.join(dir, 'wal.log')), 'WAL обрезан после purge');

  j.close();
  const j2 = new Journal(baseDir, { rowsPerSegment: 1000 });
  j2.open('wal', schema);
  const again = j2.allRows();
  assert(again.length === 2, `после reopen ровно 2 строки, без воскрешения из WAL (факт ${again.length})`);
  assert(again.map(r => r.ts).join(',') === '3,4', 'после reopen: ts 3,4');
  j2.close();
}

// --------------------------------------------------
// 4. Граница включена: ts == beforeTs остаётся; no-op purge ничего не делает
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('edge', schema);
  for (let i = 0; i < 3; i++) j.append({ ts: i, val: 'e' }); // [0,1,2]

  const res = j.purge(0); // граница ровно на minTs
  assert(res.removedRows === 0, `purge(minTs) — no-op (удалено ${res.removedRows})`);
  assert(j.allRows().length === 3, 'все строки на месте');

  const res2 = j.purge(100); // граница выше maxTs — чистит всё
  assert(res2.removedRows === 3, `purge(maxTs+1) удаляет всё (удалено ${res2.removedRows})`);
  assert(j.allRows().length === 0, 'журнал пуст');
  assert(j.stats().totalRows === 0, 'stats: 0 строк');
  assert(j.isOpen, 'журнал остался открытым');

  j.append({ ts: 1, val: 'fresh' });
  assert(j.allRows().length === 1, 'запись в очищенный журнал работает');
  j.close();
}

// --------------------------------------------------
// 5. Ошибки: закрытый журнал, некорректный аргумент
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  let threw = false;
  try {
    j.purge(5);
  } catch (e) {
    threw = /not open/i.test(String(e));
  }
  assert(threw, 'purge() до open() → ошибка «not open»');

  j.open('errs', schema);
  threw = false;
  try {
    j.purge('yesterday' as never);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, "purge('yesterday') → RangeError");
  j.close();
}

// --------------------------------------------------
// 6. Строковая граница (VRackDB-совместимо): 'now-1d', абсолютное время
// --------------------------------------------------
{
  const D = 86_400_000;
  const now = Date.now();
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('str', schema);
  j.append({ ts: now - 2 * D, val: 'old' });     // старше now-1d
  j.append({ ts: now - 3_600_000, val: 'recent' }); // новее now-1d
  j.append({ ts: now, val: 'now' });

  // относительная граница: 'now-1d' — удалит только 'old' (ts < now-1d)
  const resRel = j.purge('now-1d');
  assert(resRel.removedRows === 1, `'now-1d': удалена 1 строка (факт ${resRel.removedRows})`);
  assert(j.allRows().length === 2, `'now-1d': остались 2 свежие (факт ${j.allRows().length})`);

  j.close();

  // абсолютная строка === то же число
  const j2 = new Journal(baseDir, { rowsPerSegment: 3 });
  j2.open('str2', schema);
  j2.append({ ts: now - 2 * D, val: 'old' });
  j2.append({ ts: now, val: 'now' });
  const boundary = String(now - 3_600_000);
  const resAbs = j2.purge(boundary);
  assert(resAbs.removedRows === 1, `абсолютная строка: удалена 1 (факт ${resAbs.removedRows})`);
  assert(
    j2.allRows().every(r => (r.ts as number) >= now - 3_600_000),
    'абсолютная строка: остались ts >= границы'
  );
  j2.close();
}

console.log(`\nТесты purge: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
