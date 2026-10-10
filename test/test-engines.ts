// ============================================================
// test-engines.ts — Движки (Phase 1): log / upsert / summing / collapsing
//
// Проверяем, что compact() сливает строки по движку из metadata:
//  • log        — строки не меняются (совместимость)
//  • upsert     — по key остаётся строка с max(version)
//  • summing    — по key суммируются числовые колонки
//  • collapsing — по key гасятся пары +1/-1
// + store.create()/describe()/tables()/engineOf() и манифест _store.json,
//   а также валидация define*Table на месте объявления.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/Store.ts';
import {
  defineLogTable,
  defineUpsertTable,
  defineSummingTable,
  defineCollapsingTable
} from '../src/compaction/define.ts';
import type { Row } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'engines');

/** Свежий изолированный каталог под секцию теста (без перекрёстных данных). */
function freshDir(name: string): string {
  const d = path.join(baseDir, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

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

function assertThrows(fn: () => unknown, msg: string): void {
  try {
    fn();
    failed++;
    console.error(`FAIL (не бросил): ${msg}`);
  } catch {
    passed++;
  }
}

/** Множество строк → нормализованная строка (не зависит от порядка/лишних полей). */
function norm(rows: Row[], pick: string[]): string {
  return JSON.stringify(
    rows
      .map(r => pick.map(f => r[f]))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}

fs.rmSync(baseDir, { recursive: true, force: true });

// --------------------------------------------------
// 1. log — compact не меняет строки (совместимость со старыми журналами)
// --------------------------------------------------
{
  const store = new Store(freshDir('log'), { autoCompact: false });
  const def = defineLogTable({
    name: 'events',
    desc: 'Чистый журнал событий',
    columns: { ts: 'delta', msg: 'dictionary' },
    rowsPerSegment: 1
  });
  const j = store.create(def);
  j.append({ ts: 1, msg: 'a' });
  j.append({ ts: 2, msg: 'b' });
  const r = j.compact();
  assert(r.mergedSegments === 2, `log: слито 2 сегмента (факт ${r.mergedSegments})`);
  assert(r.logicalRows === 2, `log: 2 логических строки (факт ${r.logicalRows})`);
  assert(r.collapsedRows === 0, `log: движок ничего не свёл (факт ${r.collapsedRows})`);
  const after = norm(j.allRows(), ['msg']);
  assert(after === '[["a"],["b"]]', `log: строки сохранены (факт ${after})`);
  store.closeAll();
}

// --------------------------------------------------
// 2. upsert — по key остаётся строка с max(version)
// --------------------------------------------------
{
  const store = new Store(freshDir('upsert'), { autoCompact: false });
  const def = defineUpsertTable({
    name: 'cpu',
    desc: 'Состояние CPU: последняя версия по (host, metric)',
    columns: { ts: 'delta', host: 'dictionary', metric: 'dictionary', value: 'auto' },
    key: ['host', 'metric'],
    version: 'ts',
    rowsPerSegment: 1
  });
  const j = store.create(def);
  j.append({ ts: 10, host: 'web-1', metric: 'cpu', value: 42 });
  j.append({ ts: 20, host: 'web-1', metric: 'cpu', value: 55 }); // ← новее, побеждает
  j.append({ ts: 15, host: 'web-2', metric: 'cpu', value: 30 });
  const r = j.compact();
  assert(r.collapsedRows === 1, `upsert: свели 1 дубль (факт ${r.collapsedRows})`);

  const rows = j.allRows();
  assert(rows.length === 2, `upsert: 2 уникальных ключа (факт ${rows.length})`);
  const w1 = rows.find(x => x.host === 'web-1');
  const w2 = rows.find(x => x.host === 'web-2');
  assert(w1?.value === 55 && w1?.ts === 20, `upsert: web-1 — последняя версия ts=20 value=55 (факт ${JSON.stringify(w1)})`);
  assert(w2?.value === 30, `upsert: web-2 — 30 (факт ${JSON.stringify(w2)})`);

  // Переживает reopen: результат «запечён» в слитом сегменте
  store._closeJournal(def.name);
  const j2 = store._openJournal(def.name, def.columns); // настоящий reopen
  const again = j2.allRows();
  assert(
    again.length === 2 && again.some(x => x.host === 'web-1' && x.value === 55),
    `upsert: результат переживает reopen (факт ${JSON.stringify(again)})`
  );
  store.closeAll();
}

// --------------------------------------------------
// 3. summing — по key суммируются числовые колонки
// --------------------------------------------------
{
  const store = new Store(freshDir('summing'), { autoCompact: false });
  const def = defineSummingTable({
    name: 'req',
    desc: 'Суммы запросов по host',
    columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
    key: ['host'],
    sum: ['value'],
    version: 'ts',
    rowsPerSegment: 1
  });
  const j = store.create(def);
  j.append({ ts: 1, host: 'web-1', value: 100 });
  j.append({ ts: 2, host: 'web-1', value: 200 });
  j.append({ ts: 1, host: 'web-2', value: 50 });
  const r = j.compact();
  assert(r.collapsedRows === 1, `summing: свели 1 строку (факт ${r.collapsedRows})`);

  const rows = j.allRows();
  assert(rows.length === 2, `summing: 2 ключа (факт ${rows.length})`);
  const w1 = rows.find(x => x.host === 'web-1');
  const w2 = rows.find(x => x.host === 'web-2');
  assert(w1?.value === 300, `summing: web-1 = 100+200 = 300 (факт ${JSON.stringify(w1)})`);
  assert(w2?.value === 50, `summing: web-2 = 50 (факт ${JSON.stringify(w2)})`);
  assert(w1?.ts === 2, `summing: web-1 — база из последней версии ts=2 (факт ${JSON.stringify(w1)})`);
  store.closeAll();
}

// --------------------------------------------------
// 4. collapsing — по key гасятся пары +1/-1
// --------------------------------------------------
{
  const store = new Store(freshDir('collapsing'), { autoCompact: false });
  const def = defineCollapsingTable({
    name: 'outbox',
    desc: 'Outbox: insert/delete по id',
    columns: { id: 'dictionary', sign: 'raw', ts: 'delta' },
    key: ['id'],
    sign: 'sign',
    version: 'ts',
    rowsPerSegment: 1
  });
  const j = store.create(def);
  j.append({ id: 1, sign: 1, ts: 1 });   // insert id=1
  j.append({ id: 1, sign: -1, ts: 2 });  // delete id=1 → гасит insert
  j.append({ id: 2, sign: 1, ts: 3 });   // insert id=2 (выживает)
  const r = j.compact();
  assert(r.collapsedRows === 2, `collapsing: свели 2 строки (факт ${r.collapsedRows})`);

  const rows = j.allRows();
  assert(rows.length === 1, `collapsing: остался 1 ключ (факт ${rows.length})`);
  assert(rows[0]?.id === 2, `collapsing: выжил id=2 (факт ${JSON.stringify(rows)})`);
  store.closeAll();
}

// --------------------------------------------------
// 5. store.create/describe/tables/engineOf + манифест _store.json
// --------------------------------------------------
{
  const dir5 = freshDir('manifest');
  const store = new Store(dir5, { autoCompact: false });
  const cpuDef = defineUpsertTable({
    name: 'cpu',
    desc: 'Состояние CPU',
    columns: { ts: 'delta', host: 'dictionary', metric: 'dictionary', value: 'auto' },
    key: ['host', 'metric'],
    version: 'ts',
    rowsPerSegment: 1
  });
  const cpuJ = store.create(cpuDef);
  cpuJ.append({ ts: 10, host: 'web-1', metric: 'cpu', value: 42 });
  cpuJ.append({ ts: 20, host: 'web-1', metric: 'cpu', value: 55 });
  cpuJ.compact();
  store.create(defineSummingTable({
    name: 'req',
    desc: 'Суммы запросов',
    columns: { ts: 'delta', host: 'dictionary', value: 'auto' },
    key: ['host'],
    sum: ['value'],
    version: 'ts'
  }));

  // манифест на диске — самодостаточный артефакт
  const manifestPath = path.join(dir5, '_store.json');
  assert(fs.existsSync(manifestPath), 'манифест _store.json создан');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest.tables['cpu']?.kind === 'upsert', 'манифест: cpu.kind = upsert');
  assert(Array.isArray(manifest.tables['cpu']?.key), 'манифест: cpu.key — массив');
  assert(manifest.tables['req']?.kind === 'summing', 'манифест: req.kind = summing');

  // describe() — определение + рантайм
  const tables = store.tables();
  assert(tables.includes('cpu') && tables.includes('req'), `tables(): cpu+req (факт ${JSON.stringify(tables)})`);
  assert(store.engineOf('cpu') === 'upsert', `engineOf(cpu)=upsert (факт ${String(store.engineOf('cpu'))})`);
  assert(store.engineOf('nope') === undefined, 'engineOf(нет) = undefined');

  const desc = store.describe();
  const cpuDesc = desc.find(x => x.name === 'cpu');
  assert(cpuDesc?.kind === 'upsert', 'describe: cpu.kind = upsert');
  assert(cpuDesc?.desc === 'Состояние CPU', `describe: cpu.desc (факт ${String(cpuDesc?.desc)})`);
  assert((cpuDesc?.rows ?? 0) === 1, `describe: cpu.rows = 1 (upsert-результат, факт ${String(cpuDesc?.rows)})`);
  assert((cpuDesc?.segments ?? 0) >= 1, 'describe: cpu.segments >= 1');
  assert(typeof cpuDesc?.sizeBytes === 'number' && (cpuDesc!.sizeBytes ?? 0) > 0, 'describe: cpu.sizeBytes > 0');

  // describe() переживает новый Store (читает с диска)
  const store2 = new Store(dir5);
  assert(store2.tables().includes('cpu') && store2.tables().includes('req'), 'новый Store видит таблицы из манифеста');
  assert(store2.engineOf('req') === 'summing', 'новый Store: engineOf(req)=summing');
  store.closeAll();
  store2.closeAll();
}

// --------------------------------------------------
// 6. Валидация define*Table на месте объявления
// --------------------------------------------------
{
  assertThrows(
    () => defineLogTable({ name: '', columns: { ts: 'delta' } }),
    'log: пустой name → ошибка'
  );
  assertThrows(
    () => defineLogTable({ name: 'x', columns: {} }),
    'log: пустая columns → ошибка'
  );
  assertThrows(
    () => defineUpsertTable(
      { name: 'x', columns: { ts: 'delta' }, key: ['ts'] } as unknown as Parameters<typeof defineUpsertTable>[0]
    ),
    'upsert: нет version → ошибка (runtime-защита, типы уже требуют version)'
  );
  assertThrows(
    () => defineUpsertTable({ name: 'x', columns: { ts: 'delta', v: 'raw' }, key: ['nope'], version: 'v' }),
    'upsert: key-поле не в columns → ошибка'
  );
  assertThrows(
    () => defineUpsertTable({ name: 'x', columns: { ts: 'delta' }, key: ['ts'], version: 'nope' }),
    'upsert: version не в columns → ошибка'
  );
  assertThrows(
    () => defineSummingTable({ name: 'x', columns: { ts: 'delta', v: 'raw' }, key: ['ts'], sum: ['nope'] }),
    'summing: sum-колонка не в columns → ошибка'
  );
  assertThrows(
    () => defineCollapsingTable({ name: 'x', columns: { id: 'raw', s: 'raw' }, key: ['id'], sign: 'nope' }),
    'collapsing: sign не в columns → ошибка'
  );

  // валидные описания — типизированы и не бросают
  const ok = defineCollapsingTable({ name: 'x', columns: { id: 'raw', sign: 'raw', ts: 'delta' }, key: ['id'], sign: 'sign', version: 'ts' });
  assert(ok.kind === 'collapsing' && ok.sign === 'sign', 'collapsing: валидное описание ок');
}

console.log(`\nТесты движков (Phase 1): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
