// ============================================================
// test-querying.ts — Запросы по временному диапазону, метки,
// время жизни сегментов
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import { decodeSegment } from '../src/codec.ts';
import type { Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-query');

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

// 10 строк с ts = 0, 10, ..., 90; rowsPerSegment=3 → несколько сегментов
{
  const j = new Journal(baseDir, { rowsPerSegment: 3 });
  j.open('events', schema);
  for (let i = 0; i < 10; i++) {
    j.append({ ts: i * 10, val: `v${i}` });
  }
  j.close();

  const q = new Journal(baseDir);
  q.open('events', schema);

  // --------------------------------------------------
  // 1. query() с включением границ диапазона
  // --------------------------------------------------
  {
    const res = q.query(20, 60);
    assert(res.length === 5, `query(20..60): 5 строк (факт ${res.length})`);
    for (let i = 0; i < res.length; i++) {
      const expectedTs = [20, 30, 40, 50, 60][i];
      assert(res[i].ts === expectedTs && res[i].val === `v${expectedTs / 10}`, `query(20..60)[${i}] = ts ${expectedTs}`);
    }
  }

  // --------------------------------------------------
  // 2. Границы включены (>= start, <= end)
  // --------------------------------------------------
  {
    const res = q.query(0, 10);
    assert(res.length === 2, `query(0..10): 2 строки на границах (факт ${res.length})`);
    assert(res[0].ts === 0 && res[1].ts === 10, 'Границы диапазона включены');
  }

  // --------------------------------------------------
  // 3. Пустой результат вне данных
  // --------------------------------------------------
  {
    const res = q.query(95, 100);
    assert(res.length === 0, `query(95..100): пусто (факт ${res.length})`);

    const res2 = q.query(-10, -1);
    assert(res2.length === 0, 'Диапазон до начала данных: пусто');
  }

  // --------------------------------------------------
  // 4. getMarks() — все метки времени, отсортированные
  // --------------------------------------------------
  {
    const marks = q.getMarks();
    assert(marks.length === 10, `getMarks: 10 меток (факт ${marks.length})`);
    for (let i = 0; i < marks.length; i++) {
      assert(marks[i] === i * 10, `getMarks[${i}] = ${i * 10}`);
    }
  }

  // --------------------------------------------------
  // 5. getTimeRange() — [min, max] по всем сегментам
  // --------------------------------------------------
  {
    const range = q.getTimeRange();
    assert(Array.isArray(range) && range[0] === 0 && range[1] === 90, `getTimeRange: [0..90] (факт ${JSON.stringify(range)})`);
  }

  // --------------------------------------------------
  // 6. allRows() — порядок записи сохранён
  // --------------------------------------------------
  {
    const rows = q.allRows();
    assert(rows.length === 10, `allRows: 10 строк (факт ${rows.length})`);
    for (let i = 0; i < rows.length; i++) {
      assert(rows[i].ts === i * 10 && rows[i].val === `v${i}`, `allRows[${i}] в порядке записи`);
    }
  }

  // --------------------------------------------------
  // 7. Сегменты на диске: 10 строк по 3 → 4 файла после close
  // --------------------------------------------------
  {
    const dir = path.join(baseDir, 'journals', 'events');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert(files.length === 4, `Сегментов на диске: 4 (факт ${files.length})`);

    // Каждый сегмент имеет minTs/maxTs для пропуска вне диапазона
    for (const f of files) {
      const data = decodeSegment(fs.readFileSync(path.join(dir, f)));
      assert(data.minTs !== null && data.maxTs !== null, `${f}: minTs/maxTs записаны`);
    }
  }

  // --------------------------------------------------
  // 8. tail() — последние N строк без чтения всего журнала
  //    (все данные на диске, активный сегмент пуст)
  // --------------------------------------------------
  {
    const res = q.tail(5);
    assert(res.length === 5, `tail(5): 5 строк (факт ${res.length})`);
    for (let i = 0; i < 5; i++) {
      const expectedTs = [50, 60, 70, 80, 90][i];
      assert(
        res[i].ts === expectedTs && res[i].val === `v${expectedTs / 10}`,
        `tail(5)[${i}] — ожидаю ts ${expectedTs} / val v${expectedTs / 10}, получено ts ${res[i]?.ts} / val ${res[i]?.val}`
      );
    }

    const all = q.tail(20);
    assert(all.length === 10, `tail(20): все 10 строк (факт ${all.length})`);
    assert(q.tail(0).length === 0, 'tail(0): пустой массив');

    // Активный сегмент участвует: свежие строки новее всего, что на диске
    q.append({ ts: 100, val: 'v10' });
    const mixed = q.tail(3);
    assert(
      mixed.length === 3 && mixed[0].ts === 80 && mixed[2].ts === 100,
      `tail() смешивает активный и закрытые сегменты: получил [${mixed.map(r => r.ts).join(', ')}]`
    );
  }

  // --------------------------------------------------
  // 9. page(limit, offset?, order?) — «limit/offset» по журналу
  //    Состояние: ts = 0..90 на диске (4 сегмента) + ts=100 в активном
  // --------------------------------------------------
  {
    const ascAll = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    let r = q.page(3);
    assert(r.map(x => x.ts).join(',') === '0,10,20', `page(3): первые три (факт ${r.map(x => x.ts).join(',')})`);

    r = q.page(3, 4);
    assert(r.map(x => x.ts).join(',') === '40,50,60', `page(3,4): окно внутри сегмента (факт ${r.map(x => x.ts).join(',')})`);

    r = q.page(4, 5);
    assert(r.map(x => x.ts).join(',') === '50,60,70,80', `page(4,5): окно пересекает границу сегментов (факт ${r.map(x => x.ts).join(',')})`);

    r = q.page(3, 9);
    assert(r.map(x => x.ts).join(',') === '90,100', `page(3,9): закрытые → активный, короче limit (факт ${r.map(x => x.ts).join(',')})`);

    r = q.page(50);
    assert(r.length === 11 && r[0].ts === 0 && r[10].ts === 100, 'page(50): все строки, старые → новые');
    const allRowsAsc = q.allRows().map(x => x.ts).join(',');
    assert(r.map(x => x.ts).join(',') === allRowsAsc, 'page() совпадает с allRows() по порядку');

    // desc: свежие → старые, offset от самого свежего
    r = q.page(3, 0, 'desc');
    assert(r.map(x => x.ts).join(',') === '100,90,80', `page(3,0,'desc'): последние три (факт ${r.map(x => x.ts).join(',')})`);

    r = q.page(4, 3, 'desc');
    assert(r.map(x => x.ts).join(',') === '70,60,50,40', `page(4,3,'desc'): окно назад через активный и сегменты (факт ${r.map(x => x.ts).join(',')})`);

    r = q.page(11, 0, 'desc');
    assert(r.map(x => x.ts).join(',') === ascAll.slice().reverse().join(','), "page(all,'desc') — зеркало page(all,'asc')");

    // Вырожденные случаи
    assert(q.page(5, 50).length === 0, 'page: offset за концом → пусто');
    assert(q.page(5, 50, 'desc').length === 0, "page desc: offset за концом → пусто");
    assert(q.page(0).length === 0 && q.page(-5).length === 0, 'page: limit <= 0 → пусто');

    // Совпадение с tail(): последние k строк в хронологическом порядке
    const total = q.allRows().length;
    const viaPage = q.page(3, total - 3, 'asc').map(x => `${x.ts}:${x.val}`);
    const viaTail = q.tail(3).map(x => `${x.ts}:${x.val}`);
    assert(viaPage.join(',') === viaTail.join(','), `page(3, ${total - 3}) идентично tail(3)`);
  }

  q.close();
}

// --------------------------------------------------
// 10. page() после reopen — только файлы на диске (ленивая загрузка)
// --------------------------------------------------
{
  const q = new Journal(baseDir);
  q.open('events', schema); // ts = 0..100, всё на диске

  let r = q.page(3);
  assert(r.map(x => x.ts).join(',') === '0,10,20', `reopen: page(3) с диска (факт ${r.map(x => x.ts).join(',')})`);

  r = q.page(4, 5);
  assert(r.map(x => x.ts).join(',') === '50,60,70,80', `reopen: page(4,5) через границы сегментов (факт ${r.map(x => x.ts).join(',')})`);

  r = q.page(3, 0, 'desc');
  assert(r.map(x => x.ts).join(',') === '100,90,80', `reopen: page(3,'desc') (факт ${r.map(x => x.ts).join(',')})`);

  const tailMatch = q.page(3, q.allRows().length - 3, 'asc').map(x => x.ts)
    .join(',') === q.tail(3).map(x => x.ts).join(',');
  assert(tailMatch, 'reopen: page() и tail() дают одинаковый срез');

  q.close();
}

console.log(`\nТесты запросов: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
