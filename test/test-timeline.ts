// ============================================================
// test-timeline.ts — timeline(interval, period): бакеты по времени
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/Journal.ts';
import type { Schema, TimelineBucket } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-timeline');

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

const DAY = 86_400_000;
const base = 1_700_000_000_000; // фиксированная эпоха, чтобы тесты были детерминированными
const TS_DELTA: Schema = { ts: 'delta', val: 'dictionary' };
const TS_RAW: Schema = { ts: 'raw', val: 'dictionary' };

// --------------------------------------------------
// 1. Базовый: данные в 3 днях, бакет = 1 день, пустой 4-й
// --------------------------------------------------
{
  // rowsPerSegment=2 → 3 закрытых сегмента (проверяем путь через .meta)
  const j = new Journal(baseDir, { rowsPerSegment: 2 });
  j.open('t1', TS_DELTA);
  const rows = [
    { ts: base + 1_000_000, val: 'a' },              // день 0
    { ts: base + 2_000_000, val: 'b' },              // день 0
    { ts: base + DAY + 1_000_000, val: 'c' },        // день 1
    { ts: base + DAY + 2_000_000, val: 'd' },        // день 1
    { ts: base + DAY + 3_000_000, val: 'e' },        // день 1
    { ts: base + 2 * DAY + 1_000_000, val: 'f' }     // день 2
  ];
  for (const r of rows) j.append(r);

  const tl = j.timeline(DAY, [base, base + 4 * DAY]);
  assert(tl.length === 4, `4 бакета по 1 дню (факт ${tl.length})`);
  assert(tl[0].count === 2 && tl[0].hasData === true, `день 0: 2 (факт ${tl[0].count})`);
  assert(tl[1].count === 3 && tl[1].hasData === true, `день 1: 3 (факт ${tl[1].count})`);
  assert(tl[2].count === 1 && tl[2].hasData === true, `день 2: 1 (факт ${tl[2].count})`);
  assert(tl[3].count === 0 && tl[3].hasData === false, `день 3: 0 (факт ${tl[3].count})`);
  assert(tl[0].start === base && tl[0].end === base + DAY, 'границы бакета 0');
  assert(tl[3].start === base + 3 * DAY && tl[3].end === base + 4 * DAY, 'границы бакета 3');
  j.close();
}

// --------------------------------------------------
// 2. Период короче интервала → 1 бакет = весь период
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('t2', TS_DELTA);
  j.append({ ts: base + 500, val: 'x' });

  const tl = j.timeline(DAY, [base, base + DAY / 2]); // период = 12 часов
  assert(tl.length === 1, `1 бакет (факт ${tl.length})`);
  assert(tl[0].start === base && tl[0].end === base + DAY / 2, 'бакет = период (12ч)');
  assert(tl[0].count === 1 && tl[0].hasData === true, `1 строка (факт ${tl[0].count})`);
  j.close();
}

// --------------------------------------------------
// 3. Строки без ts не попадают в таймлайн
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('t3', TS_RAW);
  j.append({ ts: base + 500, val: 'with-ts' });
  j.append({ val: 'no-ts' }); // без ts — в таймлайн не идёт

  const tl = j.timeline(DAY, [base, base + DAY]);
  assert(tl[0].count === 1, `только строка с ts (факт ${tl[0].count})`);
  assert(tl[0].hasData === true, 'hasData=true');
  j.close();
}

// --------------------------------------------------
// 4. Границы: строка ровно на начале периода — в бакете, на конце — вне
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('t4', TS_DELTA);
  j.append({ ts: base, val: 'at-start' });      // ts = period.start → входит
  j.append({ ts: base + 3 * DAY, val: 'at-end' }); // ts = period.end → не входит
  j.append({ ts: base + 3 * DAY - 1, val: 'just-before' });

  const tl = j.timeline(DAY, [base, base + 3 * DAY]);
  assert(tl[0].count === 1, `строка на start входит (факт ${tl[0].count})`);
  assert(tl[2].count === 1, `строка перед end входит (факт ${tl[2].count})`);
  assert(tl[0].count + tl[1].count + tl[2].count === 2, `строка на end вне периода (сумма ${tl[0].count + tl[1].count + tl[2].count})`);
  j.close();
}

// --------------------------------------------------
// 5. Пустой журнал / нулевой период
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('t5', TS_DELTA);
  const tl = j.timeline(DAY, [base, base + 7 * DAY]);
  assert(tl.length === 7, `7 пустых бакетов (факт ${tl.length})`);
  assert(tl.every(b => b.count === 0 && b.hasData === false), 'все пустые');
  assert(j.timeline(DAY, [base, base]).length === 0, 'нулевой период → []');
  j.close();
}

// --------------------------------------------------
// 6. Переживает reopen: таймлайн по тем же данным
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 2 });
  j.open('t6', TS_DELTA);
  j.append({ ts: base + 10, val: 'a' });
  j.append({ ts: base + 20, val: 'b' });
  j.append({ ts: base + DAY + 30, val: 'c' });
  j.append({ ts: base + DAY + 40, val: 'd' });
  const before = JSON.stringify(j.timeline(DAY, [base, base + 2 * DAY]));
  j.close();

  const j2 = new Journal(baseDir, { rowsPerSegment: 2 });
  j2.open('t6', TS_DELTA);
  const after = JSON.stringify(j2.timeline(DAY, [base, base + 2 * DAY]));
  assert(before === after, `таймлайн стабилен после reopen (${before})`);
  j2.close();
}

// --------------------------------------------------
// 7. Ошибки: закрытый журнал, некорректные аргументы
// --------------------------------------------------
{
  const j = new Journal(baseDir);
  let threw = false;
  try { j.timeline(DAY, [base, base + DAY]); } catch { threw = true; }
  assert(threw, 'timeline() до open() → ошибка');

  j.open('t7', TS_DELTA);
  threw = false;
  try { j.timeline(0, [base, base + DAY]); } catch { threw = true; }
  assert(threw, 'timeline(0, …) → RangeError');

  threw = false;
  try { j.timeline(-1, [base, base + DAY]); } catch { threw = true; }
  assert(threw, 'timeline(-1, …) → RangeError');

  threw = false;
  try { j.timeline(DAY, [base + DAY, base]); } catch { threw = true; }
  assert(threw, 'period start>end → RangeError');

  threw = false;
  try { j.timeline(DAY, ['nope' as never, base + DAY]); } catch { threw = true; }
  assert(threw, 'period не [число, число] → RangeError');
  j.close();
}

// --------------------------------------------------
// 8. Строковые интервалы и период (VRackDB-совместимо)
// --------------------------------------------------
{
  const j = new Journal(baseDir, { rowsPerSegment: 100 });
  j.open('t8', TS_DELTA);
  j.append({ ts: base + 1000, val: 'a' });   // день 0
  j.append({ ts: base + 2000, val: 'b' });   // день 0

  // interval как строка '1d'
  const tl = j.timeline('1d', [base, base + 2 * DAY]);
  assert(tl.length === 2, `interval '1d': 2 бакета (факт ${tl.length})`);
  assert(tl[0].count === 2 && tl[1].count === 0, `day0=2, day1=0 (факт ${tl[0].count}/${tl[1].count})`);
  assert(tl[0].start === base && tl[0].end === base + DAY, "границы бакета для '1d'");

  // period как строка (абсолютное время → детерминированно)
  const tlStr = j.timeline('1d', `${base}:${base + 2 * DAY}`);
  assert(tlStr.length === 2 && tlStr[0].count === 2, `period строкой: day0=2 (факт ${tlStr[0]?.count})`);

  // interval '30m' = 1_800_000 мс → за день 48 бакетов
  const tl30 = j.timeline('30m', [base, base + DAY]);
  assert(tl30.length === 48, `'30m' за день → 48 бакетов (факт ${tl30.length})`);
  assert(tl30[0].count === 2, "первый бакет '30m' содержит обе строки");

  // string interval '0' → ошибка (<= 0)
  let threw = false;
  try { j.timeline('0', [base, base + DAY]); } catch { threw = true; }
  assert(threw, "interval '0' → RangeError");
  j.close();
}

console.log(`\nТесты timeline: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
