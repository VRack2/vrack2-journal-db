// ============================================================
// test-optimization.ts — Оптимизации хранения: дедупликация,
// словарь, дельты, RLE, авто-выбор стратегии, сериализация
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import { DictionaryColumn, DeltaColumn, RLEColumn } from '../src/columns.ts';
import type { Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-opt');

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
// 1. Дедупликация строк: A,A,B,B → 2 физические строки
// --------------------------------------------------
{
  const schema: Schema = { ts: 'delta', val: 'dictionary' };
  const j = new Journal(baseDir);
  j.open('dedup', schema);

  j.append({ ts: 1, val: 'A' });
  j.append({ ts: 1, val: 'A' }); // дубль предыдущей строки
  j.append({ ts: 2, val: 'B' });
  j.append({ ts: 2, val: 'B' }); // дубль

  const seg = j.activeSegment!;
  assert(seg.rowCount === 4, `Логических строк = 4 (факт ${seg.rowCount})`);
  assert(seg.physicalRowCount === 2, `Физических строк = 2 (факт ${seg.physicalRowCount})`);

  const st = j.stats();
  assert(st.totalRows === 4 && st.totalPhysicalRows === 2, 'stats: дедупликация видна');

  // Все логические строки читаются корректно
  for (let i = 0; i < 4; i++) {
    const row = seg.getRow(i);
    assert(
      (i < 2 && row.ts === 1 && row.val === 'A') || (row.ts === 2 && row.val === 'B'),
      `Логическая строка[${i}] читается правильно`
    );
  }

  j.close();

  // После reopen дедупликация сохраняется на диске
  const j2 = new Journal(baseDir);
  j2.open('dedup', schema);
  assert(j2.allRows().length === 4, `После reopen: 4 логические строки (факт ${j2.allRows().length})`);
  for (let i = 0; i < 4; i++) {
    const row = j2.allRows()[i];
    assert(
      (i < 2 && row.ts === 1 && row.val === 'A') || (row.ts === 2 && row.val === 'B'),
      `После reopen строка[${i}] корректна`
    );
  }
  j2.close();
}

// --------------------------------------------------
// 2. DictionaryColumn: уникальные значения — один раз
// --------------------------------------------------
{
  const values = ['a', 'b', 'a', 'c', 'b', 'a'];
  const col = new DictionaryColumn();
  for (const v of values) col.append(v);

  assert(col.dictionary.length === 3, `Словарь: 3 уникальных значения (факт ${col.dictionary.length})`);
  for (let i = 0; i < values.length; i++) {
    assert(col.get(i) === values[i], `Dictionary.get(${i}) = ${values[i]}`);
  }

  // Round-trip сериализации
  const c2 = new DictionaryColumn();
  c2.deserialize(col.serialize());
  for (let i = 0; i < values.length; i++) {
    assert(c2.get(i) === values[i], `Dictionary round-trip get(${i})`);
  }
}

// --------------------------------------------------
// 3. DeltaColumn: декодирование, защита типов, round-trip
// --------------------------------------------------
{
  const values = [10, 15, 14, 20];
  const col = new DeltaColumn();
  for (const v of values) col.append(v);

  const ser = col.serialize();
  if (ser.type === 'delta') {
    assert(ser.baseValue === 10, `Delta: baseValue=10 (факт ${String(ser.baseValue)})`);
    assert(JSON.stringify(ser.deltas) === JSON.stringify([5, -1, 6]), `Delta: deltas=[5,-1,6] (факт ${JSON.stringify(ser.deltas)})`);

    // Декодирование циклом — как при чтении с диска
    let v = ser.baseValue!;
    const decoded: number[] = [v];
    for (const d of ser.deltas) {
      v += d;
      decoded.push(v);
    }
    assert(JSON.stringify(decoded) === JSON.stringify(values), 'Delta: цикл декодирования восстанавливает значения');
  } else {
    assert(false, `Delta serialize: тип ${ser.type}`);
  }

  // Защита типов: строка не должна приниматься
  let threw = false;
  try {
    new DeltaColumn().append('не число');
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assert(threw, 'DeltaColumn.append(string) → TypeError');

  // Round-trip
  const c2 = new DeltaColumn();
  c2.deserialize(col.serialize());
  for (let i = 0; i < values.length; i++) {
    assert(c2.get(i) === values[i], `Delta round-trip get(${i})`);
  }
}

// --------------------------------------------------
// 4. RLEColumn: runs, худший случай, бинарный поиск, round-trip
// --------------------------------------------------
{
  const values = ['x', 'x', 'x', 'y', 'z', 'z'];
  const col = new RLEColumn();
  for (const v of values) col.append(v);

  assert(col.runs.length === 3, `RLE: runs=3 (факт ${col.runs.length})`);
  assert(
    JSON.stringify(col.runs) === JSON.stringify([
      { value: 'x', count: 3 },
      { value: 'y', count: 1 },
      { value: 'z', count: 2 }
    ]),
    `RLE: содержимое runs (факт ${JSON.stringify(col.runs)})`
  );

  for (let i = 0; i < values.length; i++) {
    assert(col.get(i) === values[i], `RLE.get(${i}) через бинарный поиск`);
  }

  // Худший случай: чередование → runs = n
  const alt = new RLEColumn();
  for (let i = 0; i < 10; i++) {
    alt.append(i % 2 === 0 ? 'a' : 'b');
  }
  assert(alt.runs.length === 10, `RLE худший случай: runs=n=10 (факт ${alt.runs.length})`);
  for (let i = 0; i < 10; i++) {
    assert(alt.get(i) === (i % 2 === 0 ? 'a' : 'b'), `RLE чередование get(${i})`);
  }

  // Round-trip
  const c2 = new RLEColumn();
  c2.deserialize(col.serialize());
  assert(c2.length === values.length, 'RLE round-trip: длина');
  for (let i = 0; i < values.length; i++) {
    assert(c2.get(i) === values[i], `RLE round-trip get(${i})`);
  }
}

// --------------------------------------------------
// 5. AutoColumn: эвристики выбора стратегии (> SAMPLE_SIZE=50 строк)
// --------------------------------------------------
{
  const N = 60;

  // 5a. Константа → RLE (ts различает строки, чтобы дедупликация не схлопнула их)
  {
    const j = new Journal(baseDir);
    j.open('auto_const', { ts: 'delta', val: 'auto' });
    for (let i = 0; i < N; i++) j.append({ ts: i, val: 'const' });

    const ser = j.activeSegment!.columns['val'].serialize();
    assert(ser.type === 'auto' && ser.decided, 'Auto: решение принято');
    if (ser.type === 'auto' && ser.decided) {
      assert(ser.delegate.type === 'rle', `Константа → rle (факт ${ser.delegate.type})`);
    }
    for (let i = 0; i < N; i++) {
      assert(j.activeSegment!.get('val', i) === 'const', `Auto(rle).get(${i})`);
    }
    j.close();
  }

  // 5b. Неубывающие числа → Delta
  {
    const j = new Journal(baseDir);
    j.open('auto_delta', { ts: 'delta', val: 'auto' });
    for (let i = 0; i < N; i++) j.append({ ts: i, val: 100 + i * 3 });

    const ser = j.activeSegment!.columns['val'].serialize();
    if (ser.type === 'auto' && ser.decided) {
      assert(ser.delegate.type === 'delta', `Неубывающие числа → delta (факт ${ser.delegate.type})`);
    } else {
      assert(false, 'Auto: решение принято');
    }
    for (let i = 0; i < N; i++) {
      assert(j.activeSegment!.get('val', i) === 100 + i * 3, `Auto(delta).get(${i})`);
    }
    j.close();
  }

  // 5c. Мало уникальных (<50%) → Dictionary
  {
    const j = new Journal(baseDir);
    j.open('auto_dict', { ts: 'delta', val: 'auto' });
    for (let i = 0; i < N; i++) j.append({ ts: i, val: ['a', 'b'][i % 2] });

    const ser = j.activeSegment!.columns['val'].serialize();
    if (ser.type === 'auto' && ser.decided) {
      assert(ser.delegate.type === 'dictionary', `Мало уникальных → dictionary (факт ${ser.delegate.type})`);
    } else {
      assert(false, 'Auto: решение принято');
    }
    for (let i = 0; i < N; i++) {
      assert(j.activeSegment!.get('val', i) === ['a', 'b'][i % 2], `Auto(dictionary).get(${i})`);
    }
    j.close();
  }

  // 5d. Разнообразные значения → Raw
  {
    const j = new Journal(baseDir);
    j.open('auto_raw', { ts: 'delta', val: 'auto' });
    for (let i = 0; i < N; i++) j.append({ ts: i, val: `v${i}` });

    const ser = j.activeSegment!.columns['val'].serialize();
    if (ser.type === 'auto' && ser.decided) {
      assert(ser.delegate.type === 'raw', `Разнообразные → raw (факт ${ser.delegate.type})`);
    } else {
      assert(false, 'Auto: решение принято');
    }
    for (let i = 0; i < N; i++) {
      assert(j.activeSegment!.get('val', i) === `v${i}`, `Auto(raw).get(${i})`);
    }
    j.close();
  }
}

// --------------------------------------------------
// 6. Полный round-trip: все типы колонок через журнал на диске
// --------------------------------------------------
{
  const schema: Schema = { ts: 'delta', cat: 'dictionary', flag: 'rle', note: 'raw' };
  const j = new Journal(baseDir);
  j.open('roundtrip', schema);

  for (let i = 0; i < 12; i++) {
    j.append({ ts: i, cat: ['x', 'y'][i % 2], flag: i % 3 === 0, note: `n${i}` });
  }
  const before = JSON.stringify(j.allRows());
  j.close();

  const j2 = new Journal(baseDir);
  j2.open('roundtrip', schema);
  const after = JSON.stringify(j2.allRows());
  assert(before === after, 'Полный round-trip: данные идентичны после записи на диск и чтения');
  j2.close();
}

console.log(`\nТесты оптимизаций: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
