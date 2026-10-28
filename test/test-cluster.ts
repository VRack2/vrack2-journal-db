// ============================================================
// test-cluster.ts — Фаза B: кластеризующая компакция (ORDER BY dims)
//
//  • валидация cluster в define*Table (DEF_CLUSTER_*)
//  • compact() кластеризует сегменты (порядок dims → ts), .meta:
//    cluster + tsOrdered=false, clusterKey в шапке v4 переживает reopen
//  • clusterCompact(start,end): окно по ts — трогает только пересекающие
//    сегменты, данные идентичны мультимножеству до/после
//  • setCluster на существующей таблице: манифест + metadata журналов
//  • без cluster: JRN_NO_CLUSTER
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/Store.ts';
import { Journal } from '../src/journal/Journal.ts';
import { SegmentMeta } from '../src/journal/SegmentMeta.ts';
import { SegmentFileV3 } from '../src/format/SegmentFileV3.ts';
import { defineLogTable, defineUpsertTable } from '../src/compaction/define.ts';
import ErrorManager from '../src/errors/ErrorManager.ts';
import type { Row, Schema } from '../src/core/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', 'test-data', 'cluster');

function freshDir(name: string): string {
  const d = path.join(baseDir, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function segFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => f.endsWith('.seg')).sort();
}

const schema: Schema = { ts: 'raw', host: 'raw', metric: 'raw', value: 'raw' };

function interleavedRow(i: number): Row {
  return { ts: i, host: 'h' + (i % 3), metric: 'm' + (i % 2), value: i * 10 };
}

function canon(rows: Row[]): string {
  return rows.map(r => JSON.stringify(r)).sort().join('\n');
}

// --------------------------------------------------
// 1. Валидация cluster при объявлении таблицы
// --------------------------------------------------
{
  const base = { name: 't', columns: schema };
  const cases: Array<[unknown, string]> = [
    [[], 'DEF_CLUSTER_EMPTY'],
    [['nope'], 'DEF_CLUSTER_FIELD'],
    [['host', 'host'], 'DEF_CLUSTER_DUP'],
    [['ts'], 'DEF_CLUSTER_TS'],
  ];
  for (const [cluster, code] of cases) {
    let threw = false;
    try {
      defineLogTable({ ...base, cluster: cluster as string[] });
    } catch (e) {
      threw = ErrorManager.isCode(e, code);
    }
    assert(threw, `cluster=${JSON.stringify(cluster)} → ${code}`);
  }
  const ok = defineLogTable({ ...base, cluster: ['host', 'metric'] });
  assert(ok.cluster?.join(',') === 'host,metric', 'корректный cluster принят');
}

// --------------------------------------------------
// 2. compact() кластеризует: порядок dims→ts, .meta, шапка v4
// --------------------------------------------------
{
  const dir = freshDir('compact');
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'events', columns: schema, cluster: ['host', 'metric'],
    rowsPerSegment: 10, opts: { autoCompact: false },
  }));
  for (let i = 0; i < 30; i++) t.append(interleavedRow(i));
  const before = canon(t.allRows());
  t.compact();

  const jdir = path.join(dir, 'journals', 'events');
  const files = segFiles(jdir);
  assert(files.length === 1, `compact: 3 сегмента → 1 (факт ${files.length})`);

  const seg = SegmentFileV3.decode(fs.readFileSync(path.join(jdir, files[0])));
  assert(seg.clusterKey?.join(',') === 'host,metric', 'clusterKey в шапке сегмента');
  const rows = Array.from({ length: seg.rowCount }, (_, i) => seg.getRow(i));
  assert(rows.length === 30, 'все 30 строк на месте');
  // первый прогон сортировки: h0/m0 → h0/m1 → h1/m0 → ... ts ↑ внутри
  let ordered = true;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const key = (r: Row) => `${r.host}\u0000${r.metric}`;
    if (key(a) !== key(b)) {
      if (!(key(a) < key(b))) { ordered = false; break; }
    } else if ((a.ts as number) > (b.ts as number)) { ordered = false; break; }
  }
  assert(ordered, 'строки упорядочены по (host, metric, ts ↑)');
  assert(rows[0].host === 'h0' && rows[0].metric === 'm0' && rows[0].ts === 0, 'первая строка — h0/m0/ts0');

  const meta = JSON.parse(fs.readFileSync(path.join(jdir, `${files[0]}.meta`), 'utf-8'));
  assert(meta.cluster?.join(',') === 'host,metric', '.meta: cluster');
  assert(meta.tsOrdered === false, '.meta: tsOrdered=false у кластеризованного сегмента');

  t.close();
  // reopen: манифест/метаданные подхватываются, сегмент кластеризован
  const store2 = new Store(dir);
  const t2 = store2.open('events');
  assert(t2.def.cluster?.join(',') === 'host,metric', 'reopen: cluster из манифеста');
  const r2 = SegmentFileV3.decode(fs.readFileSync(path.join(jdir, segFiles(jdir)[0])));
  assert(r2.clusterKey?.join(',') === 'host,metric', 'reopen: clusterKey сегмента цел');
  assert(canon(t2.allRows()) === before, 'reopen: данные идентичны');
  t2.close();
}

// --------------------------------------------------
// 3. clusterCompact(start,end): окно трогает только свои сегменты
// --------------------------------------------------
{
  const dir = freshDir('window');
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'events', columns: schema, cluster: ['host'],
    rowsPerSegment: 10, opts: { autoCompact: false },
  }));
  for (let i = 0; i < 30; i++) t.append(interleavedRow(i));
  const before = canon(t.allRows());

  const jdir = path.join(dir, 'journals', 'events');
  const filesBefore = segFiles(jdir);
  assert(filesBefore.length === 3, '3 сегмента до clusterCompact');
  // сегменты: ts 0-9, 10-19, 20-29 — окно [0,15] накрывает первые два
  const r = t.clusterCompact(0, 15);
  assert(r.mergedSegments === 2 && r.windows === 1 && r.rows === 20,
    `окно: 2 сегмента, 1 окно, 20 строк (факт ${JSON.stringify(r)})`);

  const filesAfter = segFiles(jdir);
  assert(filesAfter.length === 2, `после: 2 сегмента (факт ${filesAfter.length})`);
  const outside = filesBefore[2];
  assert(filesAfter.includes(outside), 'сегмент вне окна не тронут (id цел)');

  const merged = SegmentFileV3.decode(fs.readFileSync(path.join(jdir,
    filesAfter.find(f => f !== outside)!)));
  assert(merged.rowCount === 20 && merged.clusterKey?.[0] === 'host',
    'слитый сегмент: 20 строк, cluster=host');
  assert(canon(t.allRows()) === before, 'clusterCompact: данные идентичны');

  // вторая команда докластеризует остаток (2 сегмента → 1)
  const r2 = t.clusterCompact();
  assert(r2.windows === 1 && r2.mergedSegments === 2, 'полное окно: осталось 2 сегмента → 1 окно');
  assert(canon(t.allRows()) === before, 'после полной перекомпоновки данные идентичны');
  assert(segFiles(jdir).length === 1, 'итого 1 кластеризованный сегмент');
  t.close();
}

// --------------------------------------------------
// 4. setCluster на существующей таблице + манифест
// --------------------------------------------------
{
  const dir = freshDir('setcluster');
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'events', columns: schema, rowsPerSegment: 10, opts: { autoCompact: false },
  }));
  for (let i = 0; i < 20; i++) t.append(interleavedRow(i));

  let threw = false;
  try { t.clusterCompact(); } catch (e) {
    threw = ErrorManager.isCode(e, 'JRN_NO_CLUSTER');
  }
  assert(threw, 'без cluster: clusterCompact → JRN_NO_CLUSTER');

  t.setCluster(['host']);
  assert(t.def.cluster?.join(',') === 'host', 'setCluster: def.cluster');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '_store.json'), 'utf-8'));
  assert(manifest.tables.events.cluster?.[0] === 'host', 'setCluster: манифест обновлён');

  // metadata уже в открытых журналах → обычный compact кластеризует
  t.compact();
  const jdir = path.join(dir, 'journals', 'events');
  const seg = SegmentFileV3.decode(fs.readFileSync(path.join(jdir, segFiles(jdir)[0])));
  assert(seg.clusterKey?.[0] === 'host', 'compact после setCluster: сегмент кластеризован');

  t.close();
  const t2 = new Store(dir).open('events');
  assert(t2.def.cluster?.[0] === 'host', 'reopen: cluster из манифеста');
  t2.close();
}

// --------------------------------------------------
// 5. upsert + cluster: движок срабатывает вместе с сортировкой
// --------------------------------------------------
{
  const dir = freshDir('upsert');
  const store = new Store(dir);
  const t = store.create(defineUpsertTable({
    name: 'state', columns: schema, key: ['host', 'metric'], version: 'ts',
    cluster: ['host'], rowsPerSegment: 6, opts: { autoCompact: false },
  }));
  for (let i = 0; i < 12; i++) t.append(interleavedRow(i));
  t.compact();
  const rows = t.allRows();
  const keys = new Set(rows.map(r => `${r.host}/${r.metric}`));
  assert(rows.length === keys.size, `upsert: по одной строке на ключ (факт ${rows.length})`);
  const jdir = path.join(dir, 'journals', 'state');
  const seg = SegmentFileV3.decode(fs.readFileSync(path.join(jdir, segFiles(jdir)[0])));
  assert(seg.clusterKey?.[0] === 'host', 'upsert+cluster: сегмент помечен cluster');
  t.close();
}

// --------------------------------------------------
// 6. Кластеризованные сегменты корректно сканируются (where)
// --------------------------------------------------
{
  const dir = freshDir('scan');
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'events', columns: schema, cluster: ['host', 'metric'],
    rowsPerSegment: 10, opts: { autoCompact: false },
  }));
  for (let i = 0; i < 30; i++) t.append(interleavedRow(i));
  const expH1 = t.query(0, Number.MAX_SAFE_INTEGER).filter(r => r.host === 'h1');
  t.clusterCompact();
  const gotH1 = t.scan({ where: [{ field: 'host', op: 'eq', value: 'h1' }] });
  assert(canon(gotH1) === canon(expH1), 'scan(where host=h1) после кластеризации: те же строки');
  const tl = t.timeline('10s', 0, 30000);
  assert(Array.isArray(tl), 'timeline не ломается на кластеризованном журнале');
  t.close();
}

// --------------------------------------------------
// 7. Фаза C: dims в .meta + skipsWhere по измерениям
// --------------------------------------------------
{
  const dir = freshDir('dims');
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'events', columns: schema, cluster: ['host', 'metric'],
    rowsPerSegment: 10, opts: { autoCompact: false },
  }));
  for (let i = 0; i < 30; i++) t.append(interleavedRow(i));
  t.clusterCompact();
  const jdir = path.join(dir, 'journals', 'events');
  const meta = JSON.parse(fs.readFileSync(path.join(jdir, `${segFiles(jdir)[0]}.meta`), 'utf-8'));
  const hostSet: (string | null)[] = meta.dims?.host?.v ?? [];
  assert(meta.dims?.host?.t === 'set' && hostSet.filter((v) => v === 'h0' || v === 'h1' || v === 'h2').length === 3,
    '.meta: dims.host — точный набор {h0,h1,h2}');
  assert(meta.dims?.metric?.t === 'set', '.meta: dims.metric — набор');
  assert(meta.dims?.ts === undefined, '.meta: dims только по cluster-измерениям (ts вне)');

  // скан с where по отсутствующему значению — пусто и корректно
  const got = t.scan({ where: [{ field: 'host', op: 'eq', value: 'nope' }] });
  assert(got.length === 0, 'scan(where host=nope) → пусто');
  const eqH1 = t.scan({ where: [{ field: 'host', op: 'eq', value: 'h1' }] });
  assert(eqH1.length > 0 && eqH1.every(r => r.host === 'h1'), 'scan(where host=h1) — только h1');
  t.close();

  // unit: skipsWhere по dims без ts-фильтра
  const mSet = SegmentMeta.parse(JSON.parse(JSON.stringify({
    rowCount: 10, dims: { host: { t: 'set', v: ['a', 'b', null] } },
  })));
  assert(mSet !== null, 'parse: dims валидируются');
  assert(SegmentMeta.skipsWhere(mSet, [{ field: 'host', op: 'eq', value: 'c' }], false), 'dims set: eq вне набора → skip (без ts-фильтра)');
  assert(!SegmentMeta.skipsWhere(mSet, [{ field: 'host', op: 'eq', value: 'a' }], false), 'dims set: eq в наборе → не skip');
  assert(SegmentMeta.skipsWhere(mSet, [{ field: 'host', op: 'in', value: ['x', 'y'] }], false), 'dims set: in без пересечения → skip');
  assert(!SegmentMeta.skipsWhere(mSet, [{ field: 'host', op: 'in', value: ['x', 'b'] }], false), 'dims set: in с пересечением → не skip');
  assert(!SegmentMeta.skipsWhere(mSet, [{ field: 'host', op: 'isNull', value: null }], false), 'dims set: null в наборе → isNull не skip');
  assert(!SegmentMeta.skipsWhere(mSet, [{ field: 'host', op: 'ne', value: 'zz' }], false), 'dims set: ne → никогда не skip');
  const mRange = SegmentMeta.parse(JSON.parse(JSON.stringify({
    rowCount: 5, dims: { lvl: { t: 'range', min: 0, max: 10 } },
  })));
  assert(SegmentMeta.skipsWhere(mRange, [{ field: 'lvl', op: 'eq', value: 11 }], false), 'dims range: eq вне [min,max] → skip без ts-фильтра');
  assert(!SegmentMeta.skipsWhere(mRange, [{ field: 'lvl', op: 'eq', value: 'str' }], false), 'dims range: нечисловой eq → не skip');
  assert(!SegmentMeta.skipsWhere(mRange, [{ field: 'lvl', op: 'lt', value: 5 }], false), 'dims range: lt → не skip (консервативно)');
  const mBad = SegmentMeta.parse(JSON.parse(JSON.stringify({
    rowCount: 5, dims: { x: { t: 'bogus' }, y: { t: 'set', v: [{ o: 1 }] } },
  })));
  assert(mBad?.dims === null, 'parse: мусорные dims отбрасываются');

  // range-подложка: >64 числовых значений в dim → range, не set
  const dir2 = freshDir('dims-range');
  const store2 = new Store(dir2);
  const t2 = store2.create(defineLogTable({
    name: 'wide', columns: schema, cluster: ['metric'],
    rowsPerSegment: 40, opts: { autoCompact: false },
  }));
  for (let i = 0; i < 100; i++) t2.append({ ts: i, host: 'h' + (i % 3), metric: i, value: i });
  t2.clusterCompact();
  const jdir2 = path.join(dir2, 'journals', 'wide');
  const meta2 = JSON.parse(fs.readFileSync(path.join(jdir2, `${segFiles(jdir2)[0]}.meta`), 'utf-8'));
  assert(meta2.dims?.metric?.t === 'range' && meta2.dims.metric.min === 0 && meta2.dims.metric.max === 79,
    '.meta: >DIM_SET_LIMIT значений → range {0..79} (слитые закрытые сегменты)');
  const r100 = t2.scan({ where: [{ field: 'metric', op: 'eq', value: 100 }] });
  assert(r100.length === 0, 'scan(where metric=100) → пусто (range-skip)');
  t2.close();
}

// --------------------------------------------------
// 8. Фаза D: сублинейность скана после кластеризации
//    (счётчик загрузок сегментов, не wall-time) + ts-correctness на clustered
// --------------------------------------------------
{
  const MONTH = 30 * 86400_000;
  const dir = freshDir('bench');
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'telemetry', columns: schema, cluster: ['host'],
    rowsPerSegment: 30, opts: { autoCompact: false },
  }));
  // 12 «месяцев» × 10 девайсов × ... ; девайсы уникальны по месяцам
  for (let m = 0; m < 12; m++) {
    for (let day = 0; day < 10; day++) {
      const ts = m * MONTH + day * 86400_000 + 1000;
      for (let d = 0; d < 5; d++) t.append({ ts, host: `h${m * 10 + d}`, metric: 'cpu', value: day });
    }
  }
  t.flush();
  const j = t.journal(0) as unknown as { store: { loadClosed(id: string): unknown } };
  const segStore = j.store;
  const totalSegs = segFiles(path.join(dir, 'journals', 'telemetry')).length;
  assert(totalSegs >= 15, `bench: десятки сегментов (факт ${totalSegs})`);

  const scanWin = () => t.scan({
    start: 0, end: Number.MAX_SAFE_INTEGER,
    where: [{ field: 'host', op: 'eq', value: 'h52' }],
  });

  let loads = 0;
  const origLoad = segStore.loadClosed.bind(segStore);
  segStore.loadClosed = (id: string) => { loads++; return origLoad(id); };

  const before = scanWin();
  const loadsBefore = loads;
  assert(loadsBefore === totalSegs, `до кластеризации: where без dims грузит все сегменты (факт ${loadsBefore}/${totalSegs})`);
  assert(before.length === 10 && before.every(r => r.host === 'h52'), 'до: 10 строк h52 в месяце 5');
  const beforeCanon = canon(before);

  loads = 0;
  t.clusterCompact();
  loads = 0; // компакция сама грузит сегменты-входы — не считаем её
  const after = scanWin();
  const loadsAfter = loads;
  segStore.loadClosed = origLoad;

  assert(canon(after) === beforeCanon, 'bench: результат скана идентичен до/после кластеризации');
  assert(loadsAfter > 0, 'bench: хоть один сегмент загружен');
  assert(loadsAfter * 4 <= loadsBefore, `bench: загрузок — доля от прежних (${loadsAfter} ≤ ${loadsBefore}/4)`);

  // ts-order корректность: limit+asc по кластеризованному журналу (в окне ts
  // повторяются — 5 девайсов на сутки, поэтому не-decreasing, не strict)
  const asc5 = t.scan({ start: 5 * MONTH, end: 6 * MONTH - 1, order: 'asc', limit: 5 });
  assert(asc5.length === 5 && asc5.every((r, i) => i === 0 || (r.ts as number) >= (asc5[i - 1].ts as number))
    && asc5[0].ts === 5 * MONTH + 1000,
    'clustered-журнал: scan(limit 5, asc) — минимальные ts окна по порядку');
  const desc1 = t.scan({ start: 5 * MONTH, end: 6 * MONTH - 1, order: 'desc', limit: 1 });
  assert(desc1.length === 1 && desc1[0].ts === 5 * MONTH + 9 * 86400_000 + 1000, 'clustered-журнал: desc limit 1 — максимальный ts окна');
  t.close();
}


// --------------------------------------------------
// 9. Фаза F: смешанные сегменты (skip только к кластеризованным),
//    восстановление .meta из сегмента, смена cluster-spec
// --------------------------------------------------
{
  const dir = freshDir('mixed');
  const store = new Store(dir);
  const t = store.create(defineLogTable({
    name: 'events', columns: schema, cluster: ['host'],
    rowsPerSegment: 10, opts: { autoCompact: false },
  }));
  for (let i = 0; i < 30; i++) t.append(interleavedRow(i));

  // перекомпоновано окно [0,19] → 1 кластеризованный + 1 некластеризованный
  const r = t.clusterCompact(0, 19);
  assert(r.windows === 1 && r.rows === 20, `mixed: окно [0,19] перекомпоновано (${JSON.stringify(r)})`);

  const jdir = path.join(dir, 'journals', 'events');
  const clustered = segFiles(jdir).find(f => {
    const s = SegmentFileV3.decode(fs.readFileSync(path.join(jdir, f)));
    return (s.clusterKey?.length ?? 0) > 0;
  })!;
  const total = segFiles(jdir).length;
  assert(total === 2, `mixed: сегментов 2 (факт ${total})`);

  // счётчик загрузок: dims-skip (host=nope отсутствует в наборе кластеризованного
  // сегмента) не трогает некластеризованные — грузятся ровно они
  const j = t.journal(0) as unknown as { store: { loadClosed(id: string): unknown; metaOf(id: string): unknown } };
  const segStore = j.store;
  let loads = 0;
  const origLoad = segStore.loadClosed.bind(segStore);
  segStore.loadClosed = (id: string) => { loads++; return origLoad(id); };
  const got = t.scan({ where: [{ field: 'host', op: 'eq', value: 'nope' }] });
  const loadsAfter = loads;
  segStore.loadClosed = origLoad;
  assert(loadsAfter === total - 1, `mixed: skip только кластеризованного (загрузок ${loadsAfter} из ${total})`);
  assert(got.length === 0, 'mixed: where host=nope → пусто');

  // результат скана полон: h1 есть во всех трёх сегментах, skip не съел данных
  const expH1 = t.query(0, Number.MAX_SAFE_INTEGER).filter(row => row.host === 'h1');
  const gotH1 = t.scan({ where: [{ field: 'host', op: 'eq', value: 'h1' }] });
  assert(gotH1.length === expH1.length && expH1.length === 10,
    `mixed: where host=h1 полон (${gotH1.length}/${expH1.length})`);

  // сайдкар: удалить .meta — при загрузке сегмента meta (включая dims)
  // восстанавливается из сегмента идентично
  const clusteredId = clustered.replace(/\.seg$/, '');
  const dimsBefore = JSON.stringify((segStore.metaOf(clusteredId) as { dims?: unknown } | undefined)?.dims ?? null);
  assert(dimsBefore !== 'null' && dimsBefore.includes('h0'), 'mixed: dims в памяти до удаления сайдкара');
  for (const f of fs.readdirSync(jdir)) if (f.endsWith('.meta')) fs.rmSync(path.join(jdir, f));
  t.close();
  const store3 = new Store(dir);
  const t3 = store3.open('events');
  const j3 = t3.journal(0) as unknown as { store: { loadClosed(id: string): unknown; metaOf(id: string): { dims?: unknown } | undefined } };
  j3.store.loadClosed(clusteredId);
  const dimsAfter = JSON.stringify(j3.store.metaOf(clusteredId)?.dims ?? null);
  assert(dimsAfter === dimsBefore, 'mixed: .meta восстановлен из сегмента идентично (dims)');
  const gotH1b = t3.scan({ where: [{ field: 'host', op: 'eq', value: 'h1' }] });
  assert(gotH1b.length === expH1.length, 'mixed после reopen: скан полон');

  // смена spec: старый clusterKey ≠ нового — компакция переписывает по новому
  t3.setCluster(['metric']);
  t3.clusterCompact();
  const segs = segFiles(path.join(dir, 'journals', 'events')).map(f =>
    SegmentFileV3.decode(fs.readFileSync(path.join(dir, 'journals', 'events', f))));
  assert(segs.every(s => s.clusterKey?.join(',') === 'metric'),
    'смена spec: все сегменты переписаны под cluster=metric');
  assert(canon(t3.allRows()) === canon(t3.query(0, Number.MAX_SAFE_INTEGER)) && t3.allRows().length === 30,
    'смена spec: данные целы (30 строк)');
  const mH1 = t3.scan({ where: [{ field: 'host', op: 'eq', value: 'h1' }] });
  assert(mH1.length === expH1.length, 'смена spec: скан по не-cluster полю корректен');
  t3.close();
}

console.log(`\nТесты кластеризации: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
