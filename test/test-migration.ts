// ============================================================
// test-migration.ts — Фаза 5: lazy-миграция v2 → v3
//
// Старые v2-сегменты (.json, gzip+JSON) перекодируются в v3 (.seg) при
// migrateToV3() и при compact() (в т.ч. единственный старый сегмент),
// данные без потерь, уже v3 сегменты не трогаются (идемпотентность).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/Journal.ts';
import { SegmentFileV3 } from '../src/SegmentFileV3.ts';
import type { Row, Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-migration');

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

const schema: Schema = { ts: 'raw', value: 'auto', host: 'dictionary' };
const N = 200;
const base = 1_700_000_000_000;

function journalDir(name: string): string {
  return path.join(baseDir, 'journals', name);
}

// --------------------------------------------------
// 1. v2-журнал → reopen в v3 → migrateToV3(): .seg + isV3 + данные
// --------------------------------------------------
{
  // 1a. Пишем v2-сегменты (format: 'v2')
  {
    const j = new Journal(baseDir, { format: 'v2' });
    j.open('mig', schema);
    for (let i = 0; i < N; i++) {
      j.append({ ts: base + i * 1000, value: i * 1.5, host: `web-${i % 3}` });
    }
    j.close();
  }
  const dir = journalDir('mig');
  const before = fs.readdirSync(dir);
  assert(before.some(f => f.endsWith('.json')), `v2: есть .json сегменты (факт ${before.join(',')})`);
  assert(!before.some(f => f.endsWith('.seg')), 'v2: нет .seg сегментов');
  // v2 файл: magic JSDB, но НЕ v3
  const v2file = before.find(f => f.endsWith('.json'))!;
  assert(!SegmentFileV3.isV3(fs.readFileSync(path.join(dir, v2file))), 'v2-файл не является v3');

  // 1b. Reopen в v3 + migrateToV3()
  const j = new Journal(baseDir, { format: 'v3', compression: 'gzip' });
  j.open('mig', schema);
  const rep = j.migrateToV3();
  assert(rep.migrated >= 1, `migrateToV3: мигрировано ≥1 (факт ${rep.migrated})`);
  assert(rep.logicalRows === N, `migrateToV3: logicalRows=${N} (факт ${rep.logicalRows})`);

  // 1c. Файлы теперь .seg, isV3, данных не потеряно (.lock — файл блокировки)
  const after = fs.readdirSync(dir);
  const segs = after.filter(f => !f.endsWith('.meta') && f !== '.lock');
  assert(segs.every(f => f.endsWith('.seg')), `все сегменты теперь .seg (факт ${after.join(',')})`);
  const segFile = after.find(f => f.endsWith('.seg'))!;
  assert(SegmentFileV3.isV3(fs.readFileSync(path.join(dir, segFile))), 'сегмент после миграции — v3');

  const rows = j.allRows();
  assert(rows.length === N, `данные после миграции: ${N} строк (факт ${rows.length})`);
  assert(rows[0].value === 0 && rows[N - 1].value === (N - 1) * 1.5, 'значения без потерь');

  // 1d. Идемпотентность: повторный вызов не мигрирует ничего
  const rep2 = j.migrateToV3();
  assert(rep2.migrated === 0, `migrateToV3 повторно: 0 (факт ${rep2.migrated})`);
  assert(j.allRows().length === N, 'данные не задвоились');
  j.close();
}

// --------------------------------------------------
// 2. compact() с единственным v2-сегментом → миграция в v3
// --------------------------------------------------
{
  // Один v2-сегмент (compact() при 1 сегменте не сливает — нужна миграция)
  {
    const j = new Journal(baseDir, { format: 'v2' });
    j.open('single', schema);
    for (let i = 0; i < 50; i++) {
      j.append({ ts: base + i * 1000, value: i, host: 'a' });
    }
    j.close();
  }
  const dir = journalDir('single');
  assert(fs.readdirSync(dir).some(f => f.endsWith('.json')), 'single: v2 .json сегмент есть');

  const j = new Journal(baseDir, { format: 'v3', compression: 'gzip' });
  j.open('single', schema);
  j.compact(); // должен мигрировать единственный старый сегмент в v3

  const after = fs.readdirSync(dir);
  const segFile = after.find(f => f.endsWith('.seg'));
  assert(!!segFile, `compact: появился .seg (факт ${after.join(',')})`);
  if (segFile) {
    assert(SegmentFileV3.isV3(fs.readFileSync(path.join(dir, segFile))), 'compact: сегмент — v3');
  }
  assert(!after.some(f => f.endsWith('.json') && !f.endsWith('.meta')), 'compact: v2 .json сегмент ушёл');
  assert(j.allRows().length === 50, 'compact: данные сохранены (50)');
  j.close();
}

// --------------------------------------------------
// 3. v2-журнал без миграции: compact() в v2-режиме не создаёт v3
// --------------------------------------------------
{
  {
    const j = new Journal(baseDir, { format: 'v2' });
    j.open('stayv2', schema);
    for (let i = 0; i < 50; i++) j.append({ ts: base + i * 1000, value: i, host: 'a' });
    j.close();
  }
  const j = new Journal(baseDir, { format: 'v2' });
  j.open('stayv2', schema);
  const rep = j.migrateToV3();
  assert(rep.migrated === 0, 'v2-журнал: migrateToV3() ничего не делает');
  j.close();
}

console.log(`\nТесты миграции v2→v3: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
