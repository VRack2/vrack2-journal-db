// ============================================================
// test-retention.ts — Тир'ы retention (Фаза 4):
//   10000 строк, 1000 с/строку → apply() → каждый тир в своём
//   кодеке/сжатии, блоки 1h→1d слиты, потери данных отсутствуют (brute-force),
//   v3+кодек'и компактнее JSON. Плюс проверка архивного тир'а (rle+gzip+tsDelta).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import { RetentionEngine, defaultTiers } from '../src/retention.ts';
import type { Schema, RetentionTier, Row } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-retention');

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

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** ID закрытых сегментов, попадающих в тир (по возрасту maxTs на момент now). */
function segsInTier(j: Journal, eng: RetentionEngine, tierId: string, now: number): string[] {
  return j.closedSegmentIds().filter(id => {
    const info = j.closedSegmentInfo(id);
    if (!info || info.maxTs === null) return false;
    return eng.tierForAge(now - info.maxTs).id === tierId;
  });
}

/** Суммарное число строк во всех закрытых сегментах. */
function totalClosedRows(j: Journal): number {
  let n = 0;
  for (const id of j.closedSegmentIds()) n += j.closedSegmentInfo(id)?.rowCount ?? 0;
  return n;
}

/**
 * Каноническое (отсортированное) представление строк — для проверки
 * lossless без зависимости от порядка allRows(): после слияния сегменты
 * получают новые id, и allRows() (порядок записи) больше не хронологичен.
 */
function canonical(rows: Row[]): string {
  const arr = rows.map(r => ({ ts: r.ts as number, value: r.value as number }));
  return JSON.stringify([...arr].sort((a, b) => a.ts - b.ts || a.value - b.value));
}

// --------------------------------------------------
// 0. Тир'ы по умолчанию
// --------------------------------------------------
{
  const tiers = defaultTiers();
  assert(tiers.length === 4, `defaultTiers: 4 тир'а (факт ${tiers.length})`);
  assert(tiers[0].id === 'hot' && tiers[3].id === 'archive', 'порядок: hot → archive');
  assert(tiers[0].from === 0 && tiers[3].to === Infinity, 'диапазоны: 0 → Infinity');
  const byId: Record<string, RetentionTier> = {};
  for (const t of tiers) byId[t.id] = t;
  assert(byId['hot'].codec === 'f64' && byId['hot'].compress === 'none', 'hot: f64 + raw');
  assert(byId['warm'].codec === 'doubleDelta' && byId['warm'].compress === 'none', 'warm: doubleDelta + raw');
  assert(byId['cold'].codec === 'gorilla' && byId['cold'].compress === 'none', 'cold: gorilla + raw');
  assert(
    byId['archive'].codec === 'rle' && byId['archive'].compress === 'gzip' && byId['archive'].tsDelta,
    'archive: rle + gzip + tsDelta'
  );
  assert(byId['cold'].block > byId['hot'].block, 'блоки: старые (cold) крупнее свежих (hot) — 1h → 1d');
}

// --------------------------------------------------
// 1. Основной: 10000 строк × 1000 с/строку
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', value: 'raw' };
  const N = 10_000;
  const STEP = 1_000_000; // 1000 секунд
  // Запись: v3, gzip, авто-кодек'и (retention перекодирует в тир'ы).
  // autoCompact: false — тест управляет числом сегментов сам (tiering 1h→1d).
  const j = new Journal(baseDir, { format: 'v3', compression: 'gzip', rowsPerSegment: 10, autoCompact: false });
  j.open('metrics', schema);
  const expected: Array<{ ts: number; value: number }> = [];
  for (let i = 0; i < N; i++) {
    const row = { ts: i * STEP, value: i };
    expected.push(row);
    j.append(row);
  }
  j.flush();

  const maxTs = (N - 1) * STEP;
  const NOW = maxTs + HOUR; // «сейчас» = последняя точка + 1 час (детерминированно)

  const eng = j.retention;
  assert(eng.tiers.length === 4, `journal.retention: 4 тир'а (факт ${eng.tiers.length})`);

  // Статус ДО: сегменты в hot/warm/cold (архив не занят — данных < 365д)
  const statusBefore = eng.status(NOW);
  const before = Object.fromEntries(statusBefore.map(s => [s.id, s.segments]));
  assert(before['hot']! > 0, `до: hot сегментов > 0 (факт ${before['hot']})`);
  assert(before['warm']! > 0, `до: warm сегментов > 0 (факт ${before['warm']})`);
  assert(before['cold']! > 0, `до: cold сегментов > 0 (факт ${before['cold']})`);
  assert((before['archive'] ?? 0) === 0, `до: archive сегментов 0 (данные < 365д; факт ${before['archive']})`);
  assert(before['hot']! + before['warm']! + before['cold']! === N / 10, `до: все сегменты учтены в тир'ах`);

  // План: есть действия (перекодирование/слияние)
  const plan = eng.plan(NOW);
  assert(plan.length > 0, 'план: непустой');
  assert(plan.some(p => p.action === 'reencode' || p.action === 'merge'), 'план: есть reencode/merge');

  // Ссылка для brute-force: данные до (канонически, без учёта порядка)
  const rowsBefore = canonical(j.allRows());

  // Применяем retention
  const report = eng.apply(NOW);
  assert(report.beforeSegments === N / 10, `apply: beforeSegments=${N / 10} (факт ${report.beforeSegments})`);
  assert(report.afterSegments < report.beforeSegments, `apply: сегментов стало меньше (слияние; ${report.afterSegments} < ${report.beforeSegments})`);
  assert(report.merged > 0, `apply: было слияние блоков (merged=${report.merged})`);
  assert(report.beforeBytes > 0 && report.afterBytes > 0, `apply: байты до/после > 0 (${report.beforeBytes} → ${report.afterBytes})`);

  // 1) Каждый тир — в своём кодеке/сжатии
  const checks: Array<[string, string, string]> = [
    ['hot', 'f64', 'none'],
    ['warm', 'doubleDelta', 'none'],
    ['cold', 'gorilla', 'none'],
  ];
  for (const [tierId, codec, compress] of checks) {
    const ids = segsInTier(j, eng, tierId, NOW);
    assert(ids.length > 0, `${tierId}: есть сегменты после apply (факт ${ids.length})`);
    let okCodec = true, okComp = true;
    for (const id of ids) {
      const enc = eng.encodingOf(id);
      if (!enc || !enc.v3) { okCodec = false; okComp = false; continue; }
      if (enc.codecs['value'] !== codec) okCodec = false;
      if (enc.compression !== compress) okComp = false;
    }
    assert(okCodec, `${tierId}: кодек value=${codec} во всех сегментах`);
    assert(okComp, `${tierId}: сжатие=${compress} во всех сегментах`);
  }

  // 2) Конвертация 1h → 1d: в cold сегменты слиты (их стало меньше)
  const coldBefore = segsInTier(j, eng, 'cold', NOW).length; // после apply — текущее число
  // «до» считаем из statusBefore
  assert(coldBefore < before['cold']!, `1h→1d: cold сегментов стало меньше (${coldBefore} < ${before['cold']})`);
  // Слитые блоки в cold крупнее: средний размах блока вырос
  const coldSegs = segsInTier(j, eng, 'cold', NOW);
  if (coldSegs.length > 0) {
    let totalSpan = 0;
    for (const id of coldSegs) {
      const info = j.closedSegmentInfo(id)!;
      totalSpan += (info.maxTs ?? 0) - (info.minTs ?? 0);
    }
    const avgSpan = totalSpan / coldSegs.length;
    assert(avgSpan >= DAY * 0.5, `1h→1d: средний блок в cold крупнее (${Math.round(avgSpan / 1000)} с >= ~0.5д)`);
  }

  // 3) Brute-force: потери данных отсутствуют (множество строк идентично до/после)
  assert(totalClosedRows(j) === N, `brute-force: строк в закрытых сегментах ${N} (факт ${totalClosedRows(j)})`);
  assert(canonical(j.allRows()) === rowsBefore, 'brute-force: данные идентичны до/после (lossless, мультимножество)');
  const all = [...j.allRows()].sort((a, b) => (a.ts as number) - (b.ts as number));
  let lossless = all.length === N;
  for (let i = 0; i < all.length && lossless; i++) {
    if ((all[i].ts as number) !== i * STEP) lossless = false;
    if ((all[i].value as number) !== i) lossless = false;
  }
  assert(lossless, 'brute-force: каждый (ts,value) восстановлен точно');

  // 4) Эффект: меньше сегментов и меньше байт на диске (сжатие/кодек'и + слияние)
  assert(report.afterBytes < report.beforeBytes, `сжатие: байт стало меньше (${report.afterBytes} < ${report.beforeBytes})`);
  const rawJson = Buffer.byteLength(JSON.stringify(expected), 'utf-8');
  console.log(`   эффект: сегментов ${report.beforeSegments} → ${report.afterSegments}; байт ${report.beforeBytes} → ${report.afterBytes} (JSON-эквивалент ${rawJson} Б, v3 в ${(rawJson / report.afterBytes).toFixed(1)}x от JSON)`);

  // 5. Идемпотентность: повторный apply ничего не меняет (данные и число сегментов)
  const segsAfter1 = j.closedSegmentIds().length;
  const rowsAfter1 = canonical(j.allRows());
  const report2 = eng.apply(NOW);
  assert(report2.reencoded === 0 && report2.merged === 0, `идемпотентность: повторный apply — 0 действий (re=${report2.reencoded}, m=${report2.merged})`);
  assert(j.closedSegmentIds().length === segsAfter1, 'идемпотентность: число сегментов не изменилось');
  assert(rowsAfter1 === canonical(j.allRows()), 'идемпотентность: данные не изменились');

  j.close();

  // 6. Переживает reopen: тир'ы и данные читаются
  const j2 = new Journal(baseDir);
  j2.open('metrics', schema);
  const all2 = j2.allRows();
  assert(all2.length === N, `reopen: ${N} строк (факт ${all2.length})`);
  assert(canonical(all2) === rowsAfter1, 'reopen: данные совпадают');
  const eng2 = j2.retention;
  const status2 = eng2.status(NOW);
  const sum = status2.reduce((a, s) => a + s.segments, 0);
  assert(sum === j2.closedSegmentIds().length, 'reopen: статус учитывает все сегменты');
  j2.close();
}

// --------------------------------------------------
// 2. Архивный тир: данные старше 365 дней → rle + gzip + tsDelta
// --------------------------------------------------
{
  const schema: Schema = { ts: 'raw', value: 'raw' };
  const N = 400; // 400 дней данных
  const STEP = DAY; // 1 день на строку
  // autoCompact: false — тест управляет числом сегментов сам (архивация).
  const j = new Journal(baseDir, { format: 'v3', compression: 'gzip', rowsPerSegment: 10, autoCompact: false });
  j.open('archive', schema);
  const expected: Array<{ ts: number; value: number }> = [];
  for (let i = 0; i < N; i++) {
    const row = { ts: i * STEP, value: i };
    expected.push(row);
    j.append(row);
  }
  j.flush();

  const NOW = (N - 1) * STEP + HOUR; // последняя точка + 1 час
  const eng = j.retention;

  // Возраст самой старой точки > 365 дней → часть данных в archive
  const oldestAge = NOW; // ts=0 → age = NOW = (N-1)*DAY + HOUR ≈ 399 дней
  assert(oldestAge > 365 * DAY, `архив: старейшие данные > 365д (${Math.round(oldestAge / DAY)}д)`);

  const before = eng.status(NOW).find(s => s.id === 'archive')!;
  assert(before.segments > 0, `архив до: сегментов > 0 (факт ${before.segments})`);

  const rowsBefore = canonical(j.allRows());
  eng.apply(NOW);

  const afterIds = segsInTier(j, eng, 'archive', NOW);
  assert(afterIds.length > 0, `архив после: сегментов > 0 (факт ${afterIds.length})`);
  let okRle = true, okGzip = true, okTsDelta = true;
  for (const id of afterIds) {
    const enc = eng.encodingOf(id);
    if (!enc || !enc.v3) { okRle = okGzip = okTsDelta = false; continue; }
    if (enc.codecs['value'] !== 'rle') okRle = false;
    if (enc.compression !== 'gzip') okGzip = false;
    if (enc.codecs['ts'] !== 'doubleDelta') okTsDelta = false;
  }
  assert(okRle, 'архив: кодек value=rle');
  assert(okGzip, 'архив: сжатие=gzip');
  assert(okTsDelta, 'архив: ts дельта-кодирован (doubleDelta)');

  // Lossless (без зависимости от порядка allRows после слияния)
  const all = [...j.allRows()].sort((a, b) => (a.ts as number) - (b.ts as number));
  let lossless = all.length === N;
  for (let i = 0; i < all.length && lossless; i++) {
    if ((all[i].ts as number) !== i * STEP) lossless = false;
    if ((all[i].value as number) !== i) lossless = false;
  }
  assert(lossless, 'архив: данные восстановлены точно (lossless)');
  assert(canonical(j.allRows()) === rowsBefore, 'архив: данные идентичны до/после');

  j.close();
}

console.log(`\nТесты retention: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
