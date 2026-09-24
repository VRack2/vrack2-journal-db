// ============================================================
// test-durability.ts — Надёжность: WAL-восстановление, блокировки
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import type { Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-durability');
const helperPath = path.join(__dirname, 'helpers', 'crash-writer.ts');

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

// --------------------------------------------------
// 1. Краш до flush: строки восстанавливаются из WAL
// --------------------------------------------------
{
  // Дочерний процесс пишет 5 строк и «крашится» (без close)
  execFileSync(process.execPath, ['--experimental-strip-types', helperPath, baseDir, 'wal-crash', '5']);

  const dir = path.join(baseDir, 'journals', 'wal-crash');
  assert(fs.existsSync(path.join(dir, 'wal.log')), 'WAL существует после «краха» (строки не сфлашены)');
  assert(
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).length === 0,
    'сегментов на диске нет — flush не успел'
  );

  // Открываем журнал: WAL проигрывается, мёртвая блокировка забирается
  const j = new Journal(baseDir);
  j.open('wal-crash', schema);

  const rows = j.allRows();
  assert(rows.length === 5, `восстановлено 5 строк (факт ${rows.length})`);
  assert(
    rows.every((r, i) => r.ts === i && r.val === `w${i}`),
    'значения совпадают с записанными'
  );
  assert(!fs.existsSync(path.join(dir, 'wal.log')), 'WAL удалён после проигрывания');

  // Дальнейшая запись поверх восстановленных данных работает
  j.append({ ts: 99, val: 'after-crash' });
  assert(j.allRows().length === 6, 'запись после восстановления работает');

  j.close();

  const j2 = new Journal(baseDir);
  j2.open('wal-crash', schema);
  assert(j2.allRows().length === 6, 'данные переживают повторный reopen');
  j2.close();
}

// --------------------------------------------------
// 2. Чистое закрытие: без дублей после reopen
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 10_000 });
  j.open('clean', schema);
  for (let i = 0; i < 3; i++) {
    j.append({ ts: i, val: 'c' });
  }
  j.close(); // flush → сегмент на диске, WAL усечён

  const dir = path.join(baseDir, 'journals', 'clean');
  assert(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length === 1, 'сегмент записан при close()');
  assert(!fs.existsSync(path.join(dir, 'wal.log')), 'WAL усечён после flush');

  const j2 = new Journal(baseDir);
  j2.open('clean', schema);
  assert(j2.allRows().length === 3, `без дублей после чистого close (факт ${j2.allRows().length})`);
  j2.close();
}

// --------------------------------------------------
// 3. Блокировка: второй open того же журнала отклоняется
// --------------------------------------------------
{
  const a = new Journal(baseDir);
  a.open('locked', schema);

  let threw = false;
  try {
    const b = new Journal(baseDir);
    b.open('locked', schema);
  } catch (e) {
    threw = true;
    assert(/заблокирован/.test(String(e)), 'ошибка упоминает блокировку');
  }
  assert(threw, 'второй open того же журнала бросает ошибку');

  a.close(); // сняли блокировку

  const c = new Journal(baseDir);
  c.open('locked', schema); // теперь можно
  assert(c.isOpen, 'после close() первый владельца журнал открывается снова');
  c.close();
}

// --------------------------------------------------
// 4. Устаревшая блокировка (мёртвый PID) забирается автоматически
// --------------------------------------------------
{
  const dir = path.join(baseDir, 'journals', 'stale');
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, '.lock');

  // Дочерний процесс кладёт блокировку со своим PID и умирает
  execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  `]);

  assert(fs.existsSync(lockPath), 'lockfile с чужим PID существует');

  const j = new Journal(baseDir);
  j.open('stale', schema); // должен забрать устаревшую блокировку
  assert(j.isOpen, 'журнал открыт поверх устаревшей блокировки (мёртвый PID)');

  const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid: number };
  assert(info.pid === process.pid, `блокировка теперь наша (pid ${info.pid})`);

  j.close();
}

// --------------------------------------------------
// 5. clear(): полный сброс памяти и диска, журнал готов к записи
// --------------------------------------------------
{
  const j = new Journal(baseDir); // rowsPerSegment=100 по умолчанию
  j.open('wiped', schema);
  for (let i = 0; i < 150; i++) {
    j.append({ ts: i, val: `x${i}` });
  }
  const dir = path.join(baseDir, 'journals', 'wiped');
  assert(j.stats().totalRows === 150, 'до clear: записано 150 строк');
  assert(
    fs.readdirSync(dir).some(f => f.endsWith('.json')),
    'до clear: есть сегмент на диске (flush сработал)'
  );

  j.clear();

  const after = fs.readdirSync(dir);
  assert(!after.some(f => f.endsWith('.json') || f.endsWith('.meta') || f === 'wal.log' || f.endsWith('.tmp')),
    `clear: сегменты, .meta и wal.log удалены с диска (осталось: ${after.join(', ')})`);
  assert(after.includes('.lock'), 'clear: блокировка владельца сохранена');
  assert(j.isOpen, 'clear: журнал остался открытым');

  const s = j.stats();
  assert(s.totalRows === 0 && s.segmentCount === 0, `clear: в памяти чисто (rows=${s.totalRows}, сегментов=0 — активный ещё пустой)`);
  assert(j.allRows().length === 0, 'clear: allRows() пусто');
  assert(j.getTimeRange() === null, 'clear: timeRange=null');

  // Запись поверх очищенного журнала работает и переживает reopen
  for (let i = 0; i < 3; i++) {
    j.append({ ts: 1000 + i, val: `fresh${i}` });
  }
  assert(j.allRows().length === 3, 'запись после clear работает');
  j.close();

  const j2 = new Journal(baseDir);
  j2.open('wiped', schema);
  assert(j2.allRows().length === 3, `после reopen: только новые строки (${j2.allRows().length})`);
  assert(
    j2.allRows().every(r => String(r.val).startsWith('fresh')),
    'старые данные не вернулись после reopen'
  );
  j2.close();
}

console.log(`\nТесты надёжности: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
