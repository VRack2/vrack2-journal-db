// ============================================================
// test-flexschema.ts — Гибкая схема: опциональные поля, catchall, эволюция
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import type { Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-flexschema');

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
// 1. Отсутствующее объявленное поле → null-падинг (без ошибки)
// --------------------------------------------------
{
  const schema: Schema = { ts: 'delta', val: 'dictionary' };
  const j = new Journal(baseDir);
  j.open('optional', schema);

  j.append({ ts: 1, val: 'present' });
  j.append({ ts: 2 }); // поля val нет — раньше это было исключение!

  const rows = j.allRows();
  assert(rows.length === 2, `обе строки записаны (факт ${rows.length})`);
  assert(rows[0].val === 'present', 'присутствующее поле на месте');
  assert(
    rows[1].val === null,
    `отсутствующее поле → null (факт ${JSON.stringify(rows[1].val)})`
  );

  j.close();

  const j2 = new Journal(baseDir);
  j2.open('optional', schema);
  assert(j2.allRows()[1].val === null, 'null-падинг сохраняется после reopen');
  j2.close();
}

// --------------------------------------------------
// 2. Catchall: лишние поля — в «корзину», дедупликация по содержимому
// --------------------------------------------------
{
  const schema: Schema = { ts: 'delta', level: 'dictionary', payload: 'catchall' };
  const j = new Journal(baseDir);
  j.open('catchall', schema);

  j.append({ ts: 1, level: 'info', user: 'alice', code: 42 }); // extras → payload
  j.append({ ts: 2, level: 'warn' });                           // без extras → null
  j.append({ ts: 3, level: 'info', user: 'bob', code: 7 });     // другие extras
  j.append({ ts: 5, level: 'info', user: 'alice', code: 42 });  // те же extras, другой ts
  j.append({ ts: 5, level: 'info', user: 'alice', code: 42 });  // полный дубль (глубокое сравнение)

  const rows = j.allRows();
  assert(rows.length === 5, `дубль схлопнут: 5 строк (факт ${rows.length})`);

  assert(
    JSON.stringify(rows[0].payload) === JSON.stringify({ user: 'alice', code: 42 }),
    `extras в catchall (факт ${JSON.stringify(rows[0].payload)})`
  );
  assert(rows[1].payload === null, 'без extras → payload=null');
  assert(
    JSON.stringify(rows[3].payload) === JSON.stringify({ user: 'alice', code: 42 }),
    'catchall читается обратно'
  );

  const seg = j.activeSegment!;
  assert(seg.physicalRowCount === 4, `физических строк 4 (факт ${seg.physicalRowCount})`);

  // Лишние поля не мешают дедупликации по остальным полям:
  // строки с одинаковым ts/level и РАЗНЫМИ extras — разные
  j.append({ ts: 5, level: 'info', user: 'carol' });
  assert(j.allRows().length === 6, 'разные extras → не дубль');

  j.close();

  const j2 = new Journal(baseDir);
  j2.open('catchall', schema);
  const rows2 = j2.allRows();
  assert(rows2.length === 6 && JSON.stringify(rows2[0].payload) === JSON.stringify({ user: 'alice', code: 42 }),
    'catchall переживает reopen');
  j2.close();
}

// --------------------------------------------------
// 3. Без catchall лишние поля отбрасываются (без ошибки)
// --------------------------------------------------
{
  const schema: Schema = { ts: 'delta', val: 'raw' };
  const j = new Journal(baseDir);
  j.open('noextras', schema);

  j.append({ ts: 1, val: 'ok', surprise: 'gone' }); // раньше — исключение Missing field? нет: лишнее поле молча терялось
  const row = j.allRows()[0];
  assert(row.val === 'ok', 'объявленные поля на месте');
  assert(!('surprise' in row), `лишнее поле отброшено (факт ${JSON.stringify(row)})`);

  j.close();
}

// --------------------------------------------------
// 4. Эволюция схемы: новое поле → null в старых сегментах
// --------------------------------------------------
{
  const oldSchema: Schema = { ts: 'delta', val: 'dictionary' };
  const j1 = new Journal(baseDir);
  j1.open('evolve', oldSchema);
  for (let i = 0; i < 3; i++) {
    j1.append({ ts: i, val: `v${i}` });
  }
  j1.close();

  const newSchema: Schema = { ts: 'delta', val: 'dictionary', extra: 'raw' };
  const j2 = new Journal(baseDir);
  j2.open('evolve', newSchema);

  const rows = j2.allRows();
  assert(rows.length === 3, `старые строки читаются (факт ${rows.length})`);
  assert(
    rows[0].extra === null,
    `новое поле в старом сегменте → null (факт ${JSON.stringify(rows[0].extra)})`
  );

  j2.append({ ts: 9, val: 'new', extra: 'filled' });
  const rows2 = j2.allRows();
  assert(
    rows2.length === 4 && rows2[3].extra === 'filled' && rows2[0].extra === null,
    'новые строки с полем + старые без него — вместе'
  );

  // query() тоже нормализует
  const q = j2.query(0, 100);
  assert(q.length === 4 && q.every(r => 'extra' in r), 'query(): у всех строк есть поле extra');

  j2.close();
}

console.log(`\nТесты гибкой схемы: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
