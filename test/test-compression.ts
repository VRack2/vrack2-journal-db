// ============================================================
// test-compression.ts — Формат файла v2: gzip + CRC32, совместимость с v1
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import { Segment } from '../src/segment.ts';
import { decodeSegment, encodeSegment, isCompressedFormat } from '../src/codec.ts';
import type { Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-compression');

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
// 1. Round-trip: запись → файл v2 → чтение
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  j.open('roundtrip', schema);
  for (let i = 0; i < 5; i++) {
    j.append({ ts: i, val: `v${i % 2}` });
  }
  j.close();

  const dir = path.join(baseDir, 'journals', 'roundtrip');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert(files.length === 1, `один сегмент на диске (факт ${files.length})`);

  const buf = fs.readFileSync(path.join(dir, files[0]));
  assert(isCompressedFormat(buf), 'файл начинается с магических байтов JSDB');
  assert(buf.length >= 12, 'в файле есть заголовок и CRC32');

  // Сжатие реально уменьшает повторяющиеся данные
  const seg = new Segment('t', schema);
  for (let i = 0; i < 500; i++) {
    seg.append({ ts: i, val: i % 2 === 0 ? 'even' : 'odd' });
  }
  const rawSize = Buffer.byteLength(JSON.stringify(seg.serialize()), 'utf-8');
  const encSize = encodeSegment(seg.serialize()).length;
  assert(encSize < rawSize, `сжатый (${encSize} Б) меньше JSON (${rawSize} Б)`);

  // Повторное чтение: данные целы
  const j2 = new Journal(baseDir);
  j2.open('roundtrip', schema);
  const rows = j2.allRows();
  assert(rows.length === 5, `после reopen: 5 строк (факт ${rows.length})`);
  assert(
    rows[0].val === 'v0' && rows[4].ts === 4 && rows[4].val === 'v0',
    'значения совпадают с исходными'
  );

  // formatVersion в payload'е
  const data = decodeSegment(buf);
  assert(data.formatVersion === 2, `formatVersion=2 (факт ${data.formatVersion})`);
  j2.close();
}

// --------------------------------------------------
// 2. Совместимость: сегмент v1 (чистый JSON) читается
// --------------------------------------------------
{
  const s1: Schema = { ts: 'delta', val: 'raw' };
  const seg = new Segment('seg_0_0', s1, { legacy: true });
  for (let i = 0; i < 3; i++) {
    seg.append({ ts: i * 10, val: `x${i}` });
  }

  const dir = path.join(baseDir, 'journals', 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'seg_0_0.json');
  fs.writeFileSync(filePath, JSON.stringify(seg.serialize())); // без магических байтов

  const rawBuf = fs.readFileSync(filePath);
  assert(!isCompressedFormat(rawBuf), 'v1-файл не имеет магических байтов');

  const data = decodeSegment(rawBuf);
  assert(data.rowCount === 3, 'decodeSegment читает v1 напрямую');

  const j = new Journal(baseDir);
  j.open('legacy', s1);
  const rows = j.allRows();
  assert(rows.length === 3 && rows[2].val === 'x2' && rows[2].ts === 20, 'v1-сегмент читается через Journal');

  // Запись поверх v1: новые сегменты уже в формате v2
  j.append({ ts: 99, val: 'new' });
  j.close();

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert(files.length === 2, `v1 + новый v2 (факт ${files.length})`);
  const newFile = files.find(f => f !== 'seg_0_0.json')!;
  assert(isCompressedFormat(fs.readFileSync(path.join(dir, newFile))), 'новый сегмент записан в v2');

  const j2 = new Journal(baseDir);
  j2.open('legacy', s1);
  assert(j2.allRows().length === 4, 'v1 и v2 сегменты читаются вместе');
  j2.close();
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
  const file = fs.readdirSync(dir).find(f => f.endsWith('.json'))!;
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
    assert(/контрольная сумма|повреждён/i.test(String(e)), 'ошибка упоминает контрольную сумму/повреждение');
  }
  assert(threw, 'чтение повреждённого сегмента бросает ошибку');
}

console.log(`\nТесты сжатия: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
