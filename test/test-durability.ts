// ============================================================
// test-durability.ts — Надёжность: WAL-восстановление, блокировки
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal/Journal.ts';
import ErrorManager from '../src/errors/ErrorManager.ts';
import type { Schema } from '../src/core/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'durability');
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
  execFileSync(process.execPath, ['--experimental-strip-types', helperPath, baseDir, 'wal-crash', '5', 'on']);

  const dir = path.join(baseDir, 'journals', 'wal-crash');
  assert(fs.existsSync(path.join(dir, 'wal.log')), 'WAL существует после «краха» (строки не сфлашены)');
  assert(
    fs.readdirSync(dir).filter(f => f.endsWith('.seg')).length === 0,
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
  assert(fs.readdirSync(dir).filter(f => f.endsWith('.seg')).length === 1, 'сегмент записан при close()');
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
    assert(ErrorManager.isCode(e, 'JRN_LOCKED'), 'ошибка упоминает блокировку');
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
  // Явное маленькое rowsPerSegment: проверяем, что flush сработал на диске,
  // а clear() его стирает (не зависит от дефолта сегмента).
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('wiped', schema);
  for (let i = 0; i < 150; i++) {
    j.append({ ts: i, val: `x${i}` });
  }
  const dir = path.join(baseDir, 'journals', 'wiped');
  assert(j.stats().totalRows === 150, 'до clear: записано 150 строк');
  assert(
    fs.readdirSync(dir).some(f => f.endsWith('.seg')),
    'до clear: есть сегмент на диске (flush сработал)'
  );

  j.clear();

  const after = fs.readdirSync(dir);
  assert(!after.some(f => f.endsWith('.seg') || f.endsWith('.meta') || f === 'wal.log' || f.endsWith('.tmp')),
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

// --------------------------------------------------
// 6. Отклонённый append (нарушение схемы) не должен портить WAL:
//    после reopen журнал жив, и отклонённой строки в нём нет
// --------------------------------------------------
{
  // Путь 1: строка ещё в буфере (дефолтный walBatchSize)
  const j = new Journal(baseDir, { wal: 'on' });
  j.open('wal-rollback', schema);
  let rejected = false;
  try {
    j.append({ val: 'no-ts' }); // ts отсутствует — DeltaColumn отклонит
  } catch {
    rejected = true;
  }
  assert(rejected, 'append без ts отклоняется');
  j.append({ ts: 1, val: 'ok' });
  j.close();

  const j2 = new Journal(baseDir);
  j2.open('wal-rollback', schema);
  const rows = j2.allRows();
  assert(rows.length === 1 && rows[0].val === 'ok',
    `после reopen: только валидная строка, отклонённой нет (факт ${rows.length})`);
  j2.close();

  // Путь 2: строка уже на диске (walBatchSize=1 — каждый append дренирует буфер)
  const k = new Journal(baseDir, { walBatchSize: 1, wal: 'on' });
  k.open('wal-rollback-disk', schema);
  let rejected2 = false;
  try {
    k.append({ val: 'no-ts' });
  } catch {
    rejected2 = true;
  }
  assert(rejected2, 'append без ts отклоняется (буфер сразу на диске)');
  k.append({ ts: 7, val: 'ok' });
  k.close();

  const k2 = new Journal(baseDir, { walBatchSize: 1 });
  k2.open('wal-rollback-disk', schema);
  const rows2 = k2.allRows();
  assert(rows2.length === 1 && rows2[0].val === 'ok',
    `после reopen (запись на диске): только валидная строка (факт ${rows2.length})`);
  k2.close();
}

// --------------------------------------------------
// 7. WAL watermark: уже покрытые seq не воспроизводятся повторно.
//    Имитируем крах между persist сегмента и усечением WAL: сегмент
//    с walSeq на диске + wal.log с покрытыми и непокрытой строками.
// --------------------------------------------------
{
  const j = new Journal(baseDir, { wal: 'on' });
  j.open('wal-watermark', schema);
  for (let i = 0; i < 3; i++) j.append({ ts: i, val: `m${i}` });
  j.close(); // сегмент с walSeq=3, WAL усечён

  const dir = path.join(baseDir, 'journals', 'wal-watermark');
  // «Порванный» WAL: покрытые seq 1..3 (дубли) + свежая seq 4
  fs.writeFileSync(path.join(dir, 'wal.log'),
    '1 {"ts":0,"val":"m0"}\n2 {"ts":1,"val":"m1"}\n3 {"ts":2,"val":"m2"}\n4 {"ts":99,"val":"late"}\n',
    'utf-8');

  const j2 = new Journal(baseDir, { wal: 'on' });
  j2.open('wal-watermark', schema);
  const rows = j2.allRows();
  assert(rows.length === 4, `watermark: без дублей — 3+1 строка (факт ${rows.length})`);
  assert(rows.some(r => r.val === 'late'), 'watermark: непокрытая строка восстановлена');
  assert(rows.filter(r => r.val === 'm0').length === 1, 'watermark: покрытая строка не задублирована');
  j2.close();

  const j3 = new Journal(baseDir, { wal: 'on' });
  j3.open('wal-watermark', schema);
  assert(j3.allRows().length === 4, `watermark: повторный reopen — те же 4 строки (факт ${j3.allRows().length})`);
  j3.close();
}

// --------------------------------------------------
// 7b. WAL выключен (дефолт): «крах» роняет несфлашенные строки,
//     wal.log вообще не создаётся; закрытие и flush работают как раньше.
// --------------------------------------------------
{
  execFileSync(process.execPath, ['--experimental-strip-types', helperPath, baseDir, 'wal-off-crash', '5', 'off']);

  const dir = path.join(baseDir, 'journals', 'wal-off-crash');
  assert(!fs.existsSync(path.join(dir, 'wal.log')), 'off: wal.log не создан');
  assert(
    fs.readdirSync(dir).filter(f => f.endsWith('.seg')).length === 0,
    'off: сегментов нет (нет и строки с ними)'
  );

  const j = new Journal(baseDir);
  j.open('wal-off-crash', schema);
  assert(j.allRows().length === 0, `off: после «краха» несфлашенных строк нет (факт ${j.allRows().length})`);

  // нормальный путь не меняется: append → close → reopen сохраняет
  for (let i = 0; i < 3; i++) j.append({ ts: i, val: `d${i}` });
  j.close();
  const j2 = new Journal(baseDir);
  j2.open('wal-off-crash', schema);
  assert(j2.allRows().length === 3, `off: чистое закрытие сохраняет 3 строки (факт ${j2.allRows().length})`);
  j2.close();

  // невалидное значение опции
  let threw = false;
  try {
    new Journal(baseDir, { wal: 'bogus' as never });
  } catch (e) {
    threw = ErrorManager.isCode(e, 'JRN_OPT_WAL');
  }
  assert(threw, "wal: невалидное значение → JRN_OPT_WAL");
}

// --------------------------------------------------
// 8. Tolerant tail: оборванная ПОСЛЕДНЯЯ строка WAL отбрасывается,
//    журнал открывается и остаётся рабочим.
// --------------------------------------------------
{
  const dir = path.join(baseDir, 'journals', 'wal-tail');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wal.log'),
    '1 {"ts":0,"val":"a"}\n2 {"ts":1,"val":"b"}\n3 {"ts":2,"va', // оборванный хвост
    'utf-8');

  const j = new Journal(baseDir);
  j.open('wal-tail', schema);
  const rows = j.allRows();
  assert(rows.length === 2 && rows[0].val === 'a' && rows[1].val === 'b',
    `tolerant tail: 2 целые строки, хвост отброшен (факт ${rows.length})`);
  j.append({ ts: 3, val: 'c' });
  j.close();

  const j2 = new Journal(baseDir);
  j2.open('wal-tail', schema);
  assert(j2.allRows().length === 3, `tolerant tail: журнал рабочий после reopen (факт ${j2.allRows().length})`);
  j2.close();
}

// --------------------------------------------------
// 9. Порча СЕРЕДИНЫ WAL — явная ошибка (не тихая потеря данных).
// --------------------------------------------------
{
  const dir = path.join(baseDir, 'journals', 'wal-midcorrupt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wal.log'),
    '1 {"ts":0,"val":"a"}\n2 {"ts":1,"va//}\n3 {"ts":2,"val":"c"}\n', // битая в середине
    'utf-8');

  let threw = false;
  try {
    const j = new Journal(baseDir);
    j.open('wal-midcorrupt', schema);
    j.close();
  } catch (e) {
    threw = true;
    assert(ErrorManager.isCode(e, 'JRN_WAL_CORRUPT'), 'середина WAL: ошибка JRN_WAL_CORRUPT');
  }
  assert(threw, 'середина WAL: open бросает ошибку, а не теряет строки молча');

  // Блокировка снята — журнал можно починить и открыть
  fs.writeFileSync(path.join(dir, 'wal.log'), '1 {"ts":0,"val":"a"}\n', 'utf-8');
  const j2 = new Journal(baseDir);
  j2.open('wal-midcorrupt', schema);
  assert(j2.allRows().length === 1, 'после ручной починки WAL журнал открывается');
  j2.close();
}

// --------------------------------------------------
// 10. Легаси WAL: строки без seq-префикса (до watermark-фичи) —
//     воспроизводятся целиком, а не отбрасываются и не роняют open().
// --------------------------------------------------
{
  const dir = path.join(baseDir, 'journals', 'wal-legacy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wal.log'),
    '{"ts":0,"val":"a"}\n{"ts":1,"val":"b"}\n', 'utf-8');

  const j = new Journal(baseDir);
  j.open('wal-legacy', schema);
  const rows = j.allRows();
  assert(rows.length === 2 && rows[0].val === 'a' && rows[1].val === 'b',
    `легаси WAL: обе строки восстановлены (факт ${rows.length})`);
  j.close();

  const j2 = new Journal(baseDir);
  j2.open('wal-legacy', schema);
  assert(j2.allRows().length === 2, `легаси WAL: после reopen те же 2 строки (факт ${j2.allRows().length})`);
  j2.close();
}

// --------------------------------------------------
// 11. Некорректный seq-префикс (не безопасное целое / немонотонный) —
//     явная порча, а не отравление watermark'а.
// --------------------------------------------------
{
  const dir = path.join(baseDir, 'journals', 'wal-badseq');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'wal.log'),
    '1 {"ts":0,"val":"a"}\n99999999999999999999 {"ts":1,"val":"b"}\n2 {"ts":2,"val":"c"}\n', 'utf-8');
  let threw = false;
  try {
    const j = new Journal(baseDir);
    j.open('wal-badseq', schema);
    j.close();
  } catch (e) {
    threw = ErrorManager.isCode(e, 'JRN_WAL_CORRUPT');
  }
  assert(threw, 'seq > 2^53 в середине → JRN_WAL_CORRUPT (watermark не отравлен)');

  fs.writeFileSync(path.join(dir, 'wal.log'),
    '5 {"ts":0,"val":"a"}\n3 {"ts":1,"val":"b"}\n', 'utf-8');
  threw = false;
  try {
    const j = new Journal(baseDir);
    j.open('wal-badseq', schema);
    j.close();
  } catch (e) {
    threw = ErrorManager.isCode(e, 'JRN_WAL_CORRUPT');
  }
  assert(threw, 'немонотонный seq (после 5 идёт 3) → JRN_WAL_CORRUPT');

  fs.writeFileSync(path.join(dir, 'wal.log'), '1 {"ts":0,"val":"a"}\n2 {"ts":1,"val":"b"}\n', 'utf-8');
  const j2 = new Journal(baseDir);
  j2.open('wal-badseq', schema);
  assert(j2.allRows().length === 2, 'после ручной починки WAL журнал открывается');
  j2.close();
}

// --------------------------------------------------
// 12. Рваный .meta при непустом wal.log: мета восстанавливается из
//     сегмента ДО замера watermark — уже сохранённые строки не дублируются.
// --------------------------------------------------
{
  const j = new Journal(baseDir, { wal: 'on' });
  j.open('wal-tornmeta', schema);
  for (let i = 0; i < 3; i++) j.append({ ts: i, val: `m${i}` });
  j.close(); // сегмент с walSeq=3 + .meta на диске

  const dir = path.join(baseDir, 'journals', 'wal-tornmeta');
  const metaFile = fs.readdirSync(dir).find(f => f.endsWith('.meta'));
  assert(!!metaFile, 'рваный .meta: сайдкар существует');
  fs.writeFileSync(path.join(dir, metaFile!), '{broken', 'utf-8'); // «порванный» сайдкар
  fs.writeFileSync(path.join(dir, 'wal.log'),
    '1 {"ts":0,"val":"m0"}\n2 {"ts":1,"val":"m1"}\n3 {"ts":2,"val":"m2"}\n', 'utf-8'); // крах до усечения WAL

  const j2 = new Journal(baseDir, { wal: 'on' });
  j2.open('wal-tornmeta', schema);
  assert(j2.allRows().length === 3, `рваный .meta: без дублей — 3 строки (факт ${j2.allRows().length})`);
  const info = j2.closedSegmentInfo(j2.closedSegmentIds()[0]);
  assert(!!info && info.rowCount === 3, 'рваный .meta: bounds/counts восстановлены из сегмента');
  j2.close();
}

console.log(`\nТесты надёжности: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
