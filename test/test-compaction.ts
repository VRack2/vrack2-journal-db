// ============================================================
// test-compaction.ts — Компактизация: дедупликация на границах, перекодирование
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import { Store } from '../src/store.ts';
import type { Schema, SerializedColumn } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-compaction');

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

// --------------------------------------------------
// 1. Дедупликация на границах бывших сегментов
// --------------------------------------------------
{
  const schema: Schema = { ts: 'delta', val: 'dictionary' };
  // rowsPerSegment=1 → каждая строка сразу в свой файл, дублей внутри нет
  const j = new Journal(baseDir, { rowsPerSegment: 1 });
  j.open('dedup-merge', schema);

  for (let i = 0; i < 3; i++) {
    j.append({ ts: 42, val: 'x' }); // все три строки идентичны
  }

  const dir = path.join(baseDir, 'journals', 'dedup-merge');
  assert(
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).length === 3,
    'до compact: 3 отдельных сегмента'
  );

  const before = JSON.stringify(j.allRows());
  const r = j.compact();

  assert(r.mergedSegments === 3, `слито 3 сегмента (факт ${r.mergedSegments})`);
  assert(r.logicalRows === 3, `логических строк 3 (факт ${r.logicalRows})`);
  assert(r.physicalBefore === 3, `физических до: 3 (факт ${r.physicalBefore})`);
  assert(r.physicalAfter === 1, `физических после: 1 (факт ${r.physicalAfter})`);

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert(files.length === 1, `на диске остался один сегмент (факт ${files.length})`);

  const after = JSON.stringify(j.allRows());
  assert(before === after, 'данные не изменились после compact');

  j.close();

  // Переживает reopen: дедупликация уже «запечена» в файле
  const j2 = new Journal(baseDir);
  j2.open('dedup-merge', schema);
  const rows = j2.allRows();
  assert(rows.length === 3 && rows.every(x => x.ts === 42 && x.val === 'x'), 'все строки читаются после reopen');
  assert(j2.activeSegment !== null, 'активный сегмент создан заново');
  const st = j2.stats();
  assert(st.totalPhysicalRows === 1, `stats: physical=1 (факт ${st.totalPhysicalRows})`);
  j2.close();
}

// --------------------------------------------------
// 2. Перекодирование auto-колонки на объединённых данных
// --------------------------------------------------
{
  const schema: Schema = { ts: 'delta', val: 'auto' };
  // Порог автоопределения — 50 значений; по 30 в каждом сегменте → «не решено»
  const j = new Journal(baseDir, { rowsPerSegment: 30 });
  j.open('reencode', schema);

  for (let i = 0; i < 60; i++) {
    j.append({ ts: i, val: i % 2 === 0 ? 'a' : 'b' }); // 2 уникальных из 60 → dictionary
  }

  const dir = path.join(baseDir, 'journals', 'reencode');
  assert(
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).length === 2,
    'до compact: 2 сегмента по 30 строк'
  );

  // До compact колонка в каждом файле — «не решённая» (сэмпл < 50)
  const store = new Store(baseDir);
  const segIdBefore = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()[0].replace(/\.json$/, '');
  const colBefore = store.loadSegment('reencode', segIdBefore)!.columns['val'].serialize() as SerializedColumn;
  assert(
    colBefore.type === 'auto' && (colBefore as { decided?: boolean }).decided === false,
    `до compact: auto не решено (факт ${JSON.stringify(colBefore).slice(0, 60)}…)`
  );

  const before = JSON.stringify(j.allRows());
  const r = j.compact();
  assert(r.mergedSegments === 2 && r.physicalAfter === 60, 'compact: 2→1 сегмент, 60 строк');

  // После compact сэмпл пересёк порог → колонка перекодирована в dictionary
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert(files.length === 1, `один файл после compact (факт ${files.length})`);

  const mergedId = files[0].replace(/\.json$/, '');
  const colAfter = store.loadSegment('reencode', mergedId)!.columns['val'].serialize() as SerializedColumn;
  assert(
    colAfter.type === 'auto' && (colAfter as { decided?: boolean }).decided === true,
    `после compact: auto решено (факт ${JSON.stringify(colAfter).slice(0, 60)}…)`
  );
  const delegate = (colAfter as { delegate?: SerializedColumn }).delegate;
  assert(delegate?.type === 'dictionary', `делегат — dictionary (факт ${delegate?.type})`);

  const after = JSON.stringify(j.allRows());
  assert(before === after, 'данные не изменились после compact');

  j.close();
}

// --------------------------------------------------
// 3. No-op: меньше двух закрытых сегментов
// --------------------------------------------------
{
  const schema: Schema = { ts: 'delta', val: 'raw' };
  const j = new Journal(baseDir);
  j.open('noop', schema);
  j.append({ ts: 1, val: 'x' }); // только активный сегмент

  const r = j.compact();
  assert(r.mergedSegments === 0 && r.logicalRows === 0, 'compact без закрытых сегментов — no-op');
  assert(j.allRows().length === 1, 'активные данные не тронуты');

  j.close();
}

console.log(`\nТесты компактизации: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
