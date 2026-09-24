// ============================================================
// test-basic.ts — Базовый жизненный цикл журнала
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import type { Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-basic');

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

// Чистим тестовые данные от предыдущих запусков
fs.rmSync(baseDir, { recursive: true, force: true });

const schema: Schema = { ts: 'delta', val: 'dictionary' };

// --------------------------------------------------
// 1. Открытие / запись / чтение / закрытие
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  assert(!j.isOpen, 'Журнал закрыт до open()');

  let threw = false;
  try {
    j.append({ ts: 1, val: 'x' });
  } catch {
    threw = true;
  }
  assert(threw, 'append() до open() бросает ошибку');

  j.open('basic', schema);
  assert(j.isOpen, 'Журнал открыт после open()');

  for (let i = 0; i < 5; i++) {
    j.append({ ts: 100 + i, val: `v${i % 2}` });
  }

  const rows = j.allRows();
  assert(rows.length === 5, `allRows: 5 строк (факт ${rows.length})`);
  for (let i = 0; i < 5; i++) {
    assert(
      rows[i].ts === 100 + i && rows[i].val === `v${i % 2}`,
      `строка[${i}] совпадает с исходной`
    );
  }

  const st = j.stats();
  assert(st.totalRows === 5, 'stats: totalRows=5');
  assert(st.segmentCount >= 1, 'stats: есть хотя бы активный сегмент');
  assert(
    Array.isArray(st.timeRange) && st.timeRange[0] === 100 && st.timeRange[1] === 104,
    `stats: timeRange [100..104] (факт ${JSON.stringify(st.timeRange)})`
  );

  j.close();
  assert(!j.isOpen, 'Журнал закрыт после close()');

  threw = false;
  try {
    j.append({ ts: 1, val: 'x' });
  } catch {
    threw = true;
  }
  assert(threw, 'append() после close() бросает ошибку');

  threw = false;
  try {
    j.close();
  } catch {
    threw = true;
  }
  assert(threw, 'Повторный close() бросает ошибку');
}

// --------------------------------------------------
// 2. Повторное открытие: данные и метаданные сохраняются
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  j.open('basic', schema);
  assert(j.allRows().length === 5, `После reopen: 5 строк (факт ${j.allRows().length})`);

  j.updateMetadata({ owner: 'ts-test' });
  const md = j.getMetadata();
  assert(md.owner === 'ts-test', 'updateMetadata/getMetadata работают');

  j.close();
}

// --------------------------------------------------
// 3. Несколько журналов в одном каталоге независимы
// --------------------------------------------------
{
  const s2: Schema = { ts: 'delta', name: 'raw' };

  const a = new Journal(baseDir);
  a.open('alpha', s2, { kind: 'a' });
  a.append({ ts: 10, name: 'one' });

  const b = new Journal(baseDir);
  b.open('beta', s2, { kind: 'b' });
  b.append({ ts: 20, name: 'two' });

  assert(a.allRows()[0].name === 'one', 'Журнал alpha независим');
  assert(b.allRows()[0].name === 'two', 'Журнал beta независим');

  a.close();
  b.close();
}

// --------------------------------------------------
// 4. Авто-flush при rowsPerSegment → файлы на диске
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('flushy', schema);
  for (let i = 0; i < 7; i++) {
    j.append({ ts: i, val: 'x' });
  }

  // 7 строк по 3 в сегменте → 2 закрытых + активный с 1 строкой
  const dir = path.join(baseDir, 'journals', 'flushy');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert(files.length === 2, `rowsPerSegment=3: 2 закрытых сегмента (факт ${files.length})`);

  j.close(); // активный с 1 строкой → третий файл
  const files2 = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert(files2.length === 3, `После close: 3 сегмента (факт ${files2.length})`);

  const j2 = new Journal(baseDir);
  j2.open('flushy', schema);
  assert(j2.allRows().length === 7, 'Все 7 строк читаются после reopen');
  j2.close();
}

console.log(`\nБазовые тесты: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
