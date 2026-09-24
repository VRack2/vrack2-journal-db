// ============================================================
// crash-writer.ts — симуляция краха процесса:
// пишет строки в журнал БЕЗ close()/flush() и сразу выходит.
// Строки остаются только в WAL (wal.log) + мёртвый PID в .lock.
// Запуск: node --experimental-strip-types test/helpers/crash-writer.ts <baseDir> <journalName> [rows]
// ============================================================

import { Journal } from '../../src/journal.ts';

const baseDir = process.argv[2];
const name = process.argv[3];
const rows = Number(process.argv[4] ?? '5');

if (!baseDir || !name) {
  console.error('usage: crash-writer.ts <baseDir> <journalName> [rows]');
  process.exit(2);
}

const j = new Journal(baseDir, { rowsPerSegment: 10_000 }); // авто-flush отключён
j.open(name, { ts: 'delta', val: 'dictionary' });

for (let i = 0; i < rows; i++) {
  j.append({ ts: i, val: `w${i}` });
}

// «Краш»: выходим без close() — WAL не усечён, блокировка не снята
process.exit(0);
