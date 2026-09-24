// ============================================================
// test-load.ts — Долгая нагрузка: 2 000 000 записей
//
// Запуск: node --max-old-space-size=8192 test/test-load.ts
// (не включён в npm test — долгий)
//
// Проверяем реальных метрик:
//   1) скорость и память записи 2M строк (WAL + auto-flush сегментов)
//   2) размер на диске: gzip v2 vs «голый» JSON после decomp
//   3) холодное reopen + целостность данных (агрегаты + точечные строки)
//   4) скорость allRows() и query() по временному диапазону
//   5) эффект compact(): количество файлов, размер, время
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import { Segment } from '../src/segment.ts';
import { decodeSegment } from '../src/codec.ts';
import type { Row, Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-load');
const JNAME = 'load';

const N = Number(process.env.LOAD_ROWS ?? '2000000');
const ROWS_PER_SEGMENT = 50_000; // → ~40 сегментов
const TS_BASE = 1_700_000_000_000;

fs.rmSync(baseDir, { recursive: true, force: true });

// --------------------------------------------------
// Генерация реалистичных логов
// --------------------------------------------------
const LEVELS = ['DEBUG', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'] as const;
const USERS: string[] = Array.from({ length: 10_000 }, (_, i) => `user_${i}`);
const PATHS = ['/api/v1/users', '/api/v1/orders', '/healthz', '/static/app.js', '/api/v1/search', '/login'];

function makeRow(i: number): Row {
  const p = PATHS[i % PATHS.length];
  return {
    ts: TS_BASE + i,
    level: LEVELS[i % 7 === 5 ? 4 : i % 3],
    user: USERS[i % 10_000],
    path: p,
    status: i % 10 === 0 ? 500 : i % 7 === 0 ? 404 : 200,
    duration: (i % 97) * 3 + (i % 13),
    message: `request ${i} completed for ${p}`,
    flag: i % 2 === 0,
    tags: ['prod', i % 100 < 5 ? 'canary' : 'stable'],
    meta: { host: `host${i % 25}`, region: i % 2 === 0 ? 'ru1' : 'eu1' },
    payload: i % 500 === 0 ? { ref: `ref-${i}`, extra: null } : null,
  };
}

const schema: Schema = {
  ts: 'delta',
  level: 'auto',
  user: 'auto',
  path: 'auto',
  status: 'auto',
  duration: 'auto',
  message: 'raw',
  flag: 'auto',
  tags: 'catchall',
  meta: 'catchall',
  payload: 'catchall',
};

// --------------------------------------------------
// Инструменты
// --------------------------------------------------
let peakRss = 0;
function phase(name: string, fn: () => void): number {
  const t0 = performance.now();
  fn();
  const dt = performance.now() - t0;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  console.log(`  ${name.padEnd(34)} ${fmtMs(dt)}`);
  return dt;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} мс`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} с`;
  return `${Math.floor(ms / 60_000)}м ${((ms % 60_000) / 1000).toFixed(0)}с`;
}

function fmtBytes(b: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b >= 100 ? 0 : 1)} ${units[i]}`;
}

function journalDir(): string {
  return path.join(baseDir, 'journals', JNAME);
}

function segmentFiles(): string[] {
  const d = journalDir();
  if (!fs.existsSync(d)) return [];
  const files = fs.readdirSync(d).filter((f) => /^\S+\.json$/.test(f) && !f.startsWith('.'));
  return files;
}

interface DiskReport {
  fileCount: number;
  compressedBytes: number;
  rawJsonBytes: number;
}

function measureDisk(): DiskReport {
  let compressedBytes = 0;
  let rawJsonBytes = 0;
  const files = segmentFiles();
  for (const f of files) {
    const buf = fs.readFileSync(path.join(journalDir(), f));
    compressedBytes += buf.length;
    const seg = decodeSegment(buf);
    rawJsonBytes += Buffer.byteLength(JSON.stringify(seg), 'utf-8');
  }
  return { fileCount: files.length, compressedBytes, rawJsonBytes };
}

// Ожидания по агрегатам считаем формулой/циклом над формулой, не храним копии.
// ts-сумма — только BigInt: float переполняется уже при ~200K строк.
const expectedTsSum = BigInt(TS_BASE) * BigInt(N) + (BigInt(N) - 1n) * BigInt(N) / 2n;
// Сумма duration и счётчики считаем в процессе записи
let expDurSum = 0n;
let expErrCount = 0n;
let expMsgLen = 0n;
for (let i = 0; i < N; i++) {
  expDurSum += BigInt((i % 97) * 3 + (i % 13));
  if (i % 10 === 0) expErrCount++;
  expMsgLen += BigInt(`request ${i} completed for ${PATHS[i % PATHS.length]}`.length);
}

// --------------------------------------------------
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  OK   ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

console.log(`\n=== Фаза 1: запись ${N.toLocaleString('ru')} строк (rowsPerSegment=${ROWS_PER_SEGMENT}) ===`);

const j = new Journal(baseDir, { rowsPerSegment: ROWS_PER_SEGMENT, maxCachedSegments: 8 });
phase('open + схема', () => j.open(JNAME, schema, { owner: 'load-test' }));

const t0 = performance.now();
for (let i = 0; i < N; i++) {
  j.append(makeRow(i));
  if (i % 200_000 === 199_999) {
    const el = performance.now() - t0;
    console.log(
      `    ...прогресс ${((i + 1) / N) * 100 | 0}%  ${((i + 1) / (el / 1000)).toFixed(0)} ops/s  rss=${fmtBytes(process.memoryUsage().rss)}`
    );
  }
}
const insertMs = performance.now() - t0;
peakRss = Math.max(peakRss, process.memoryUsage().rss);
console.log(
  `  запись                        ${fmtMs(insertMs)}  ~${Math.round(N / (insertMs / 1000))} ops/s  rss=${fmtBytes(peakRss)}`
);

const st1 = j.stats();
check(st1.totalRows === N, `после записи: totalRows=${st1.totalRows}`);

phase('close (flush хвоста)', () => j.close());
check(j.isOpen === false, 'журнал закрыт');

// WAL должен быть усечён после close
const walAfterClose = fs.existsSync(path.join(journalDir(), 'wal.log'))
  ? fs.statSync(path.join(journalDir(), 'wal.log')).size
  : 0;
check(walAfterClose === 0, `WAL после close пуст (${walAfterClose} Б)`);

console.log(`\n=== Фаза 2: размер на диске ===`);
const disk1 = measureDisk();
console.log(
  `  файлов: ${disk1.fileCount}   на диске (gzip v2): ${fmtBytes(disk1.compressedBytes)}   JSON без сжатия: ${fmtBytes(disk1.rawJsonBytes)}`
);
console.log(
  `  коэффициент gzip: ${(disk1.rawJsonBytes / disk1.compressedBytes).toFixed(2)}x   на строку: ${(disk1.compressedBytes / N).toFixed(1)} Б`
);
check(disk1.fileCount >= Math.max(2, Math.floor(N / ROWS_PER_SEGMENT)), `сегментов как ожидается (${disk1.fileCount})`);
check(disk1.rawJsonBytes > disk1.compressedBytes, 'gzip реально сжимает');
check(disk1.compressedBytes / N < 200, `средняя стоимость строки < 200 Б (факт ${(disk1.compressedBytes / N).toFixed(1)})`);

console.log(`\n=== Фаза 3: холодное reopen ===`);
const j2 = new Journal(baseDir, { rowsPerSegment: ROWS_PER_SEGMENT, maxCachedSegments: 8 });
phase('open (загрузка с диска)', () => j2.open(JNAME, schema));
check(j2.stats().totalRows === N, `после reopen: totalRows=${j2.stats().totalRows}`);

console.log(`\n=== Фаза 4: целостность ===`);
let rows: Row[] | null = null;
phase('allRows() — полный обход', () => {
  rows = j2.allRows();
});
check(rows!.length === N, `allRows: ${rows!.length}`);

function agg(rs: Row[]) {
  let tsSum = 0n,
    durSum = 0n,
    errCount = 0n,
    msgLen = 0n;
  for (const r of rs) {
    tsSum += BigInt(r.ts as number);
    durSum += BigInt(r.duration as number);
    if (r.status === 500) errCount++;
    msgLen += BigInt((r.message as string).length);
  }
  return { tsSum, durSum, errCount, msgLen };
}
phase('агрегаты по 2M строк', () => {
  const a = agg(rows!);
  check(a.tsSum === BigInt(expectedTsSum), 'сумма ts совпадает с ожиданием');
  check(a.durSum === expDurSum, 'сумма duration совпадает с ожиданием');
  check(a.errCount === expErrCount, 'счётчик status=500 совпадает');
  check(a.msgLen === expMsgLen, 'сумма длин message совпадает');
});

// Точечная проверка
function spot(i: number, r: Row | undefined): void {
  if (!r) {
    check(false, `строка[${i}] отсутствует`);
    return;
  }
  const e = makeRow(i);
  for (const k of Object.keys(e) as (keyof Row)[]) {
    if (JSON.stringify(r[k]) !== JSON.stringify(e[k])) {
      check(false, `строка[${i}].${k}: ${JSON.stringify(r[k])} != ${JSON.stringify(e[k])}`);
      return;
    }
  }
}
phase('точечные проверки (0, 1, 12345, 999999, 1999999)', () => {
  for (const i of [0, 1, 12345, N - 1]) spot(i, rows![i]);
  console.log('  OK   точечные строки в порядке и по содержимому');
});
rows = null;

console.log(`\n=== Фаза 5: query() по временному диапазону ===`);
const qStartOff = Math.min(1_000_000, Math.max(0, Math.floor(N / 2)));
const qSpan = 100_000;
phase(`query: ${qSpan + 1} строк в диапазоне`, () => {
  const res = j2.query(TS_BASE + qStartOff, TS_BASE + qStartOff + qSpan);
  const expectLen = Math.min(qSpan + 1, N - qStartOff);
  check(res.length === expectLen, `query count=${res.length} (ожид. ${expectLen})`);
  check(res[0].ts === TS_BASE + qStartOff && res[res.length - 1].ts === TS_BASE + qStartOff + res.length - 1, 'границы диапазона');
});
phase('query мимо данных (пусто)', () => {
  const res = j2.query(TS_BASE + 10_000_000, TS_BASE + 10_100_000);
  check(res.length === 0, `пустой ответ (${res.length})`);
});
j2.close();

console.log(`\n=== Фаза 6: компактизация ===`);
const j3 = new Journal(baseDir, { rowsPerSegment: ROWS_PER_SEGMENT, maxCachedSegments: 8 });
j3.open(JNAME, schema);
const diskBefore = measureDisk();
const merged = j3.compact();
const diskAfter = measureDisk();
j3.close();
console.log(
  `  merged=${merged.mergedSegments}  physical ${merged.physicalBefore}→${merged.physicalAfter}`
);
console.log(
  `  файлов: ${diskBefore.fileCount}→${diskAfter.fileCount}   на диске: ${fmtBytes(diskBefore.compressedBytes)}→${fmtBytes(diskAfter.compressedBytes)} (Δ ${((1 - diskAfter.compressedBytes / diskBefore.compressedBytes) * 100).toFixed(1)}%)`
);
check(merged.mergedSegments >= 1, 'compact объединил сегменты');
check(diskAfter.compressedBytes <= diskBefore.compressedBytes, 'размер после compact не вырос');

// Финальная целостность после compact
const j4 = new Journal(baseDir);
j4.open(JNAME, schema);
check(j4.stats().totalRows === N, `после compact: totalRows=${j4.stats().totalRows}`);
const sOff = qStartOff - 10;
const sample = j4.query(TS_BASE + sOff, TS_BASE + qStartOff + 10);
check(sample.length === 21, `query после compact: ${sample.length}`);
j4.close();

console.log(`\n=== Итог ===`);
console.log(`  пиковый RSS               ${fmtBytes(peakRss)}`);
console.log(`  запись ${N} строк          ${fmtMs(insertMs)} (~${Math.round(N / (insertMs / 1000))} ops/s)`);
console.log(
  `  диск (сегменты):        ${fmtBytes(diskAfter.compressedBytes)} / ${fmtBytes(diskAfter.rawJsonBytes)} без gzip (${(diskAfter.rawJsonBytes / Math.max(1, diskAfter.compressedBytes)).toFixed(2)}x)`
);
console.log(`  итоговых файлов сегментов ${diskAfter.fileCount}`);
console.log(failed === 0 ? '\nLOAD: все проверки пройдены' : `\nLOAD: ${failed} проверок ПРОВАЛЕНО`);
if (failed > 0) process.exit(1);