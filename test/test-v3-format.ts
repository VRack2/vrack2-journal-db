// ============================================================
// test-v3-format.ts — Формат сегмента v3 (Фаза 2):
//   бинарные блобы колонок + числовые кодек'и (f64/doubleDelta/gorilla/rle)
//   + сжатие (gzip) + CRC32 + прозрачное чтение v1/v2/v3.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal/Journal.ts';
import { Segment } from '../src/format/Segment.ts';
import { SegmentFileV2 } from '../src/format/SegmentFileV2.ts';
import { SegmentFileV3 } from '../src/format/SegmentFileV3.ts';
import { Compression } from '../src/core/Compression.ts';
import { NumCodecs } from '../src/format/numcodecs/NumCodecs.ts';
import ErrorManager from '../src/errors/ErrorManager.ts';
import type { Schema } from '../src/core/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'v3');

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

// Читает JSON-заголовок v3 (offset 8 = len, 12 = начало)
function v3Header(buf: Buffer): any {
  const len = buf.readUInt32LE(8);
  return JSON.parse(buf.subarray(12, 12 + len).toString('utf-8'));
}

fs.rmSync(baseDir, { recursive: true, force: true });

// --------------------------------------------------
// 1. Числовые кодек'и: round-trip lossless для каждого
// --------------------------------------------------
{
  const cases: Array<[string, number[]]> = [
    ['f64', [1.5, -2.25, 0, 1e300, -1e-300, 3.141592653589793, 1e16, 0.1 + 0.2]],
    ['doubleDelta', [100, 101, 103, 106, 110, 115, 200, 5, 0, 1000]],
    ['gorilla', [0.5, 0.5, 0.5000000001, 12.75, 12.75, 12.751, 3.3, -7]],
    ['rle', [5, 5, 5, 7, 7, 0, 0, 0, 0, 42, 1]]
  ];
  for (const [name, values] of cases) {
    const codec = NumCodecs.get(name);
    const enc = codec.encode(values);
    const dec = codec.decode(enc, values.length); // Float64Array | Int32Array
    const ok = dec.length === values.length && values.every((v, i) => dec[i] === v);
    assert(ok, `кодек ${name}: точное восстановление ${values.length} значений`);
    // компактность: кодек (до сжатия) не больше 8*н
    assert(enc.length <= values.length * 8, `кодек ${name}: <= 8 байт/значение`);
  }
  // autoPick: регулярные целые → doubleDelta; низкая кардинальность с пробегами → rle;
  // осциллирующие float → gorilla (не rle — не целые).
  const reg = Array.from({ length: 200 }, (_, i) => i * 10); // ровный шаг
  assert(NumCodecs.autoPick(reg) === 'doubleDelta', 'авто-выбор: ровный ряд → doubleDelta');
  assert(NumCodecs.autoPick([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]) === 'rle', 'авто-выбор: длинные пробеги → rle');
  const osc = Array.from({ length: 200 }, (_, i) => 0.5 + (i % 2 ? 1e-9 : -1e-9));
  assert(NumCodecs.autoPick(osc) === 'gorilla', 'авто-выбор: осциллирующие float → gorilla');
}

// --------------------------------------------------
// 2. v3 round-trip через Journal: запись → .seg → чтение
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', count: 'raw', value: 'raw', source: 'raw' };
  const j = new Journal(baseDir, { format: 'v3', compression: 'gzip', codecs: { value: 'gorilla' } });
  j.open('roundtrip', schema);
  const N = 500;
  for (let i = 0; i < N; i++) {
    j.append({ ts: i * 1000, count: Math.floor(i % 7), value: Math.sin(i / 10) * 100, source: i % 3 === 0 ? 'a' : 'b' });
  }
  j.close();

  const dir = path.join(baseDir, 'journals', 'roundtrip');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.seg'));
  assert(files.length === 1, `один v3-сегмент на диске (факт ${files.length})`);

  const buf = fs.readFileSync(path.join(dir, files[0]));
  assert(SegmentFileV3.isV3(buf), 'файл — сегмент v3-семейства (магические байты + версия)');
  assert(buf[4] === 4, 'записан контейнер версии 4 (бинарный rowMap-хвост)');

  // codec value зафиксирован в схеме как gorilla (явный выбор)
  const h = v3Header(buf);
  assert(h.columns.value.kind === 'numeric', 'колонка value → numeric');
  assert(h.columns.value.codec === 'gorilla', 'колонка value → кодек gorilla (явный)');
  assert(h.columns.source.kind === 'dict', 'колонка source → dict');
  assert(h.rowCount === N, `rowCount=${N} (факт ${h.rowCount})`);

  // reopen: данные целы
  const j2 = new Journal(baseDir);
  j2.open('roundtrip', schema);
  const rows = j2.allRows();
  assert(rows.length === N, `после reopen: ${N} строк (факт ${rows.length})`);
  let exact = true;
  for (let i = 0; i < N; i++) {
    if (rows[i].ts !== i * 1000) exact = false;
    if (rows[i].count !== Math.floor(i % 7)) exact = false;
    if (rows[i].value !== Math.sin(i / 10) * 100) exact = false;
    if (rows[i].source !== (i % 3 === 0 ? 'a' : 'b')) exact = false;
  }
  assert(exact, 'все значения совпадают точно (lossless)');
  j2.close();
}

// --------------------------------------------------
// 3. v3 реально компактнее JSON (повторяющиеся/регулярные данные)
// --------------------------------------------------
{
  // Реалистичная строка метрики: регулярный ts (doubleDelta) + осциллирующий
  // float (gorilla) + низкокардинальная строка (dict). Именно на таких данных
  // бинарные кодек'и v3 выигрывают у JSON.
  const schema: Schema = { ts: 'raw', cpu: 'raw', host: 'raw' };
  const seg = new Segment('t', schema);
  const N = 10000;
  for (let i = 0; i < N; i++) {
    seg.append({
      ts: i * 1000,
      cpu: 40 + 20 * Math.sin(i / 7) + 5 * Math.cos(i / 3),
      host: 'h' + (i % 2)
    });
  }
  const rawJson = Buffer.byteLength(JSON.stringify(seg.serialize()), 'utf-8');
  const v3Size = SegmentFileV3.encode(seg).length;
  const v2Size = SegmentFileV2.encode(seg.serialize()).length;
  assert(v3Size < rawJson, `v3 (${v3Size} Б) < JSON (${rawJson} Б)`);
  assert(v3Size < v2Size, `v3 (${v3Size} Б) < v2 JSON+gzip (${v2Size} Б)`);
  console.log(`   v3=${v3Size} Б, v2=${v2Size} Б, JSON=${rawJson} Б (v3 в ${(rawJson / v3Size).toFixed(1)}x меньше JSON)`);
}

// --------------------------------------------------
// 3b. zstd-сжатие (нативное, Node >= 23; иначе прозрачный фолбэк на gzip)
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', cpu: 'raw' };
  const j = new Journal(baseDir, { format: 'v3', compression: 'zstd' });
  j.open('zstd-rt', schema);
  const N = 2000;
  for (let i = 0; i < N; i++) j.append({ ts: i * 1000, cpu: 30 + 10 * Math.cos(i / 4) });
  j.close();

  const j2 = new Journal(baseDir);
  j2.open('zstd-rt', schema);
  const rows = j2.allRows();
  let ok = rows.length === N;
  for (let i = 0; i < N && ok; i++) {
    if (rows[i].ts !== i * 1000 || rows[i].cpu !== 30 + 10 * Math.cos(i / 4)) ok = false;
  }
  assert(ok, 'zstd: точный round-trip через Journal');
  j2.close();
}

// --------------------------------------------------
// 4. Null в числовой колонке (маска валидности) + смешанные колонки
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', metric: 'raw', tag: 'raw' };
  const seg = new Segment('t', schema);
  for (let i = 0; i < 64; i++) {
    seg.append({ ts: i, metric: i % 5 === 0 ? null : i * 1.5, tag: i % 2 === 0 ? 'x' : 'y' });
  }
  const buf = SegmentFileV3.encode(seg);
  const seg2 = SegmentFileV3.decode(buf);
  let ok = true;
  for (let i = 0; i < 64; i++) {
    const expect = i % 5 === 0 ? null : i * 1.5;
    const got = (seg2 as any).columns.metric.get(i);
    if (got !== expect) ok = false;
    if ((seg2 as any).columns.tag.get(i) !== (i % 2 === 0 ? 'x' : 'y')) ok = false;
  }
  assert(ok, 'null в числовой колонке (маска) + dict-колонка: точный round-trip');
}

// --------------------------------------------------
// 5. Fallback кодека: rle на дробных → f64, данные целы, схема честная
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', f: 'raw' };
  const seg = new Segment('t', schema);
  for (let i = 0; i < 50; i++) seg.append({ ts: i, f: Math.random() * 100 });
  // Явный rle на дробных → должен уйти в f64 (RleCodec бросает на не-целых)
  const buf = SegmentFileV3.encode(seg, { codecs: { f: 'rle' } });
  const h = v3Header(buf);
  assert(h.columns.f.codec === 'f64', 'rle на дробных → schema фиксирует фактический кодек f64');
  const seg2 = SegmentFileV3.decode(buf);
  assert(seg2.rowCount === 50, 'fallback f64: rowCount сохранён');
  const colF = (seg2 as any).columns.f;
  let allFinite = true;
  for (let i = 0; i < 50; i++) {
    const v = colF.get(i);
    if (v !== null && typeof v !== 'number') allFinite = false;
  }
  assert(allFinite, 'fallback f64: все значения числовые');
}

// --------------------------------------------------
// 6. Прозрачная совместимость: v1 (JSON) + v3 читаются вместе
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', val: 'raw' };
  // v3-сегмент через Journal
  const j = new Journal(baseDir, { format: 'v3' });
  j.open('mixed', schema);
  for (let i = 0; i < 3; i++) j.append({ ts: i, val: `v3-${i}` });
  j.close();

  // v1-сегмент (чистый JSON) вручную в тот же журнал
  const seg1 = new Segment('seg_999999_0_legacy', schema, { legacy: true });
  for (let i = 0; i < 3; i++) seg1.append({ ts: 1000 + i, val: `v1-${i}` });
  const dir = path.join(baseDir, 'journals', 'mixed');
  fs.writeFileSync(path.join(dir, 'seg_999999_0_legacy.json'), JSON.stringify(seg1.serialize()));

  const j2 = new Journal(baseDir);
  j2.open('mixed', schema);
  const rows = j2.allRows();
  assert(rows.length === 6, `v1 + v3 читаются вместе (факт ${rows.length})`);
  const vals = rows.map(r => r.val as string).sort();
  assert(
    vals.includes('v1-0') && vals.includes('v3-2'),
    'значения из обоих форматов присутствуют'
  );
  j2.close();
}

// --------------------------------------------------
// 7. Повреждённый v3 → ошибка по контрольной сумме
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', val: 'raw' };
  const j = new Journal(baseDir, { format: 'v3' });
  j.open('corrupt', schema);
  for (let i = 0; i < 10; i++) j.append({ ts: i, val: 'a' });
  j.close();

  const dir = path.join(baseDir, 'journals', 'corrupt');
  const file = fs.readdirSync(dir).find(f => f.endsWith('.seg'))!;
  const filePath = path.join(dir, file);
  const buf = Buffer.from(fs.readFileSync(filePath));
  buf[10] ^= 0xff; // ломаем байт в области payload
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
  assert(threw, 'чтение повреждённого v3-сегмента бросает ошибку');
}

// --------------------------------------------------
// 7. zstd по умолчанию (Фаза 5): Node ≥ 23.8 → zstd, иначе gzip; round-trip
// --------------------------------------------------
{
  // Дефолт согласован с наличием zstd в runtime.
  const def = Compression.default();
  if (Compression.zstdAvailable()) {
    assert(def === 'zstd', 'Compression.default() = zstd при Node ≥ 23.8');
  } else {
    assert(def === 'gzip', 'Compression.default() = gzip без zstd');
  }

  // Журнал без явного compression → сегмент v3 сжимается по умолчанию (zstd/gzip),
  // и данные читаются обратно без потерь.
  const schema: Schema = { ts: 'raw', val: 'raw' };
  const j = new Journal(baseDir, { format: 'v3' });
  j.open('zstdDefault', schema);
  const N = 400;
  for (let i = 0; i < N; i++) j.append({ ts: i * 1000, val: Math.cos(i / 5) * 1000 });
  j.close();

  const dir = path.join(baseDir, 'journals', 'zstdDefault');
  const file = fs.readdirSync(dir).find(f => f.endsWith('.seg'))!;
  const h = v3Header(fs.readFileSync(path.join(dir, file)));
  assert(h.compression === def, `v3-сегмент по умолчанию: compression=${def} (факт ${h.compression})`);

  const j2 = new Journal(baseDir);
  j2.open('zstdDefault', schema);
  const rows = j2.allRows();
  assert(rows.length === N, `zstd/gzip по умолчанию: ${N} строк (факт ${rows.length})`);
  assert(
    rows[0].val === 1000 && Math.abs((rows[1].val as number) - Math.cos(0.2) * 1000) < 1e-9,
    'значения совпадают'
  );
  j2.close();
}

// --------------------------------------------------
// 8. Версия контейнера: записи — v4; легаси v3 (JSON rowMap в шапке)
//    читается прозрачно; v4-файл с потерянным rowMap-хвостом → явная ошибка.
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', value: 'raw' };

  // 8a. Легаси v3: JSON rowMap в шапке, версия 3 — декодируется как раньше.
  {
    const seg = new Segment('legacy', schema);
    for (let i = 0; i < 20; i++) seg.append({ ts: i * 100, value: i });
    const rowMap = Array.from(seg.rowMap);
    // Собираем контейнер «по-старому»: header c rowMap JSON (без rowMapLen), без бинарного хвоста.
    const spec: Record<string, { kind: string; codec?: string; type?: string }> = {};
    const blobs: Buffer[] = [];
    const order = Object.keys(schema);
    for (const f of order) {
      const b = seg.columns[f].encodeBlob({});
      spec[f] = { kind: b.kind, codec: b.codecUsed, type: schema[f] };
      blobs.push(Compression.compress(b.buf, 'gzip'));
    }
    const header = {
      v: 3, id: seg.id, schema, metadata: seg.metadata,
      rowCount: seg.rowCount, physicalRowCount: seg.physicalRowCount, tsCount: seg.tsCount,
      minTs: seg.minTs, maxTs: seg.maxTs, rowMap, summaries: seg.summaries,
      compression: 'gzip', columnOrder: order, columns: spec,
    };
    const hbuf = Buffer.from(JSON.stringify(header), 'utf-8');
    const headLen = Buffer.alloc(4); headLen.writeUInt32LE(hbuf.length, 0);
    const magic = Buffer.alloc(8); magic.write('JSDB', 0, 'ascii'); magic[4] = 3;
    const parts: Buffer[] = [magic, headLen, hbuf];
    for (const bl of blobs) { const l = Buffer.alloc(4); l.writeUInt32LE(bl.length, 0); parts.push(l, bl); }
    const body = Buffer.concat(parts);
    const crc = Buffer.alloc(4); crc.writeUInt32LE(zlib.crc32(body) >>> 0, 0);
    const buf = Buffer.concat([body, crc]);

    assert(SegmentFileV3.isV3(buf), 'легаси v3 (версия 3) распознаётся');
    const dec = SegmentFileV3.decode(buf);
    let ok = dec.rowCount === 20;
    for (let i = 0; i < 20 && ok; i++) {
      const r = dec.getRow(i);
      if (r.ts !== i * 100 || r.value !== i) ok = false;
    }
    assert(ok, 'легаси v3 с JSON rowMap — lossless-декод (20 строк)');
  }

  // 8b. v4-шапка без rowMapLen (урезан хвост) → явная ошибка, а не тихий пустой rowMap.
  {
    const seg = new Segment('v4cut', schema);
    for (let i = 0; i < 10; i++) seg.append({ ts: i, value: i });
    const buf = SegmentFileV3.encode(seg, { compression: 'gzip' });
    const h = v3Header(buf);
    assert(h.v === 4 && typeof h.rowMapLen === 'number', 'записан v4 с rowMapLen');
    delete h.rowMapLen;
    const hbuf = Buffer.from(JSON.stringify(h), 'utf-8');
    const headLen = Buffer.alloc(4); headLen.writeUInt32LE(hbuf.length, 0);
    const magic = Buffer.alloc(8); magic.write('JSDB', 0, 'ascii'); magic[4] = 4;
    // только шапка + блобы (без хвоста), затем честный CRC этого урезанного тела
    const oldHeadLen = buf.readUInt32LE(8);
    const body = Buffer.concat([magic, headLen, hbuf, buf.subarray(12 + oldHeadLen, buf.length - 4)]);
    const crc = Buffer.alloc(4); crc.writeUInt32LE(zlib.crc32(body) >>> 0, 0);
    const cutBuf = Buffer.concat([body, crc]);
    let threw = false;
    try { SegmentFileV3.decode(cutBuf); } catch (e) {
      threw = ErrorManager.isCode(e, 'SFW3_NO_ROWMAP');
    }
    assert(threw, 'v4 без rowMap-хвоста → SFW3_NO_ROWMAP (не тихая потеря)');
  }
}

// --------------------------------------------------
// 9. Codec-probe на выборке: >512 значений → ранжируется по равномерной
//    выборке, победитель кодирует весь столбец; lossless.
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', cpu: 'raw', host: 'raw' };
  const seg = new Segment('probe', schema);
  const N = 5000;
  for (let i = 0; i < N; i++) {
    seg.append({ ts: i * 1000, cpu: Math.sin(i / 15) * 50, host: (i % 2 === 0 ? 'a' : 'b') });
  }
  const buf = SegmentFileV3.encode(seg, { compression: 'gzip' }); // без явных кодеков → probe
  const h = v3Header(buf);
  // Свойство: ранжирование по равномерной выборке даёт того же победителя,
  // что и полный прогон кодеков по всему столбцу.
  const fullWinner = (values: number[]): string => {
    let best = 'f64';
    let bestLen = Infinity;
    for (const name of Object.keys(NumCodecs.registry)) {
      try {
        const l = NumCodecs.get(name).encode(values).length;
        if (l < bestLen) { bestLen = l; best = name; }
      } catch { /* reject */ }
    }
    return best;
  }
  const tsVals: number[] = [];
  const cpuVals: number[] = [];
  for (let i = 0; i < N; i++) { tsVals.push(i * 1000); cpuVals.push(Math.sin(i / 15) * 50); }
  assert(h.columns.ts.codec === fullWinner(tsVals),
    `probe (>512): победитель ts по выборке = победитель полного прогона (${h.columns.ts.codec})`);
  assert(h.columns.cpu.codec === fullWinner(cpuVals),
    `probe (>512): победитель cpu по выборке = победитель полного прогона (${h.columns.cpu.codec})`);
  const dec = SegmentFileV3.decode(buf);
  let ok = dec.rowCount === N;
  for (let i = 0; i < N && ok; i++) {
    const r = dec.getRow(i);
    if (r.ts !== i * 1000 || r.cpu !== Math.sin(i / 15) * 50 || r.host !== (i % 2 === 0 ? 'a' : 'b')) ok = false;
  }
  assert(ok, `probe на выборке: ${N} строк lossless`);
}

console.log(`\nТесты формата v3: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
