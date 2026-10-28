// ============================================================
// test-compression.ts — Контейнер сегмент-файла (JSDB v4):
// магические байты, сжатие блобов, CRC32, реакция на повреждение.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal/Journal.ts';
import { Segment } from '../src/format/Segment.ts';
import { SegmentFile } from '../src/format/SegmentFile.ts';
import { SegmentFileV3 } from '../src/format/SegmentFileV3.ts';
import ErrorManager from '../src/errors/ErrorManager.ts';
import type { Schema } from '../src/core/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'compression');

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
// 1. Round-trip: запись → файл → чтение
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  j.open('roundtrip', schema);
  for (let i = 0; i < 5; i++) {
    j.append({ ts: i, val: `v${i % 2}` });
  }
  j.close();

  const dir = path.join(baseDir, 'journals', 'roundtrip');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.seg'));
  assert(files.length === 1, `один сегмент на диске (факт ${files.length})`);

  const buf = fs.readFileSync(path.join(dir, files[0]));
  assert(SegmentFile.isWrapped(buf), 'файл начинается с магических байтов JSDB');
  assert(buf[4] === 4, 'версия контейнера 4');
  assert(buf.length >= 12, 'в файле есть заголовок и CRC32');

  // Сжатие реально уменьшает данные: один и тот же сегмент без сжатия vs по умолчанию
  const seg = new Segment('t', schema);
  for (let i = 0; i < 500; i++) {
    seg.append({ ts: i, val: i % 2 === 0 ? 'even' : 'odd' });
  }
  const rawSize = SegmentFileV3.encode(seg, { compression: 'none' }).length;
  const encSize = SegmentFileV3.encode(seg, { compression: 'gzip' }).length;
  assert(encSize < rawSize, `сжатый (${encSize} Б) меньше несжатого (${rawSize} Б)`);

  // Повторное чтение: данные целы
  const j2 = new Journal(baseDir);
  j2.open('roundtrip', schema);
  const rows = j2.allRows();
  assert(rows.length === 5, `после reopen: 5 строк (факт ${rows.length})`);
  assert(
    rows[0].val === 'v0' && rows[4].ts === 4 && rows[4].val === 'v0',
    'значения совпадают с исходными'
  );
  j2.close();
}

// --------------------------------------------------
// 2. Чужой/легаси файл: не JSDB → SFW3_NOT_V3,
//    JSDB с чужой версией → SFW3_BAD_VERSION
// --------------------------------------------------
{
  const notSeg = Buffer.from(JSON.stringify({ id: 'x' }), 'utf-8');
  let threw = false;
  try {
    SegmentFile.read(notSeg);
  } catch (e) {
    threw = ErrorManager.isCode(e, 'SFW3_NOT_V3');
  }
  assert(threw, 'чистый JSON без магических байтов → SFW3_NOT_V3');

  // Легаси-версия контейнера (byte 4 = 3) с корректным CRC — отклоняется по версии
  const seg = new Segment('oldver', schema);
  for (let i = 0; i < 10; i++) seg.append({ ts: i, val: `v${i}` });
  const buf = Buffer.from(SegmentFileV3.encode(seg, { compression: 'gzip' }));
  buf[4] = 3; // портим только версию; CRC уже не совпадёт — проверим, что проверка версии первее
  let bad = false;
  try {
    SegmentFileV3.decode(buf);
  } catch (e) {
    bad = ErrorManager.isCode(e, 'SFW3_BAD_VERSION');
  }
  assert(bad, 'версия != 4 → SFW3_BAD_VERSION (проверка версии первее CRC)');
}

// --------------------------------------------------
// 3. Повреждённый файл → ошибка по контрольной сумме
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  j.open('corrupt', schema);
  for (let i = 0; i < 5; i++) {
    j.append({ ts: i, val: 'a' });
  }
  j.close();

  const dir = path.join(baseDir, 'journals', 'corrupt');
  const file = fs.readdirSync(dir).find(f => f.endsWith('.seg'))!;
  const filePath = path.join(dir, file);
  const buf = Buffer.from(fs.readFileSync(filePath));
  buf[10] ^= 0xff; // ломаем байт в области payload (после 8-байтового заголовка)
  fs.writeFileSync(filePath, buf);

  let threw = false;
  try {
    const j2 = new Journal(baseDir);
    j2.open('corrupt', schema);
    j2.allRows();
    j2.close();
  } catch (e) {
    threw = true;
    assert(ErrorManager.isCode(e, 'JRN_SEG_READ'), 'ошибка упоминает контрольную сумму/повреждение');
  }
  assert(threw, 'чтение повреждённого сегмента бросает ошибку');
}

console.log(`\nТесты контейнера: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
