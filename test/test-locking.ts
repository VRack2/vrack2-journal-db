// ============================================================
// test-locking.ts — Режим блокировки lock: 'pid' | 'off', сценарий worker_threads
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.ts';
import { Store } from '../src/store.ts';
import type { Schema } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.join(__dirname, '..', '.test-data-locking');

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
const lockPathOf = (name: string): string => path.join(baseDir, 'journals', name, '.lock');

// --------------------------------------------------
// 1. lock:'off' не создаёт .lock; данные видны обычному владельцу после close
// --------------------------------------------------
{
  const j = new Journal(baseDir, { lock: 'off' });
  j.open('nolock', schema);
  assert(!fs.existsSync(lockPathOf('nolock')), "lock:'off' не создаёт .lock");

  for (let i = 0; i < 3; i++) j.append({ ts: i, val: 'o' });
  j.close();

  const j2 = new Journal(baseDir); // обычный режим pid
  j2.open('nolock', schema);
  assert(j2.allRows().length === 3, `данные владельца с lock:'off' видны обычному владельцу (факт ${j2.allRows().length})`);
  assert(fs.existsSync(lockPathOf('nolock')), 'обычный владелец создаёт .lock');
  j2.close();
}

// --------------------------------------------------
// 2. Обход живой блокировки: второй владелец с lock:'off' работает рядом
//    (модель: воркер владеет базой, main-поток читает/пишет мимо лока)
// --------------------------------------------------
{
  const owner = new Journal(baseDir); // держит живую PID-блокировку
  owner.open('shared', schema);
  for (let i = 0; i < 3; i++) owner.append({ ts: i, val: 'owner' });
  owner.flush(); // строки на диске — видны из другого инстанса

  let threw = false;
  try {
    const blocked = new Journal(baseDir);
    blocked.open('shared', schema);
  } catch (e) {
    threw = true;
    assert(/заблокирован/.test(String(e)), 'обычный open отклоняется при живой блокировке');
  }
  assert(threw, 'обычный owner не может открыть журнал дважды');

  const guest = new Journal(baseDir, { lock: 'off' });
  guest.open('shared', schema); // обходит живую блокировку
  assert(guest.isOpen, "lock:'off' открывается поверх живой блокировки");
  assert(guest.allRows().length === 3, `гость видит сфлашенные строки владельца (факт ${guest.allRows().length})`);

  guest.append({ ts: 100, val: 'guest' });
  guest.close(); // не трогает .lock чужого владельца

  assert(fs.existsSync(lockPathOf('shared')), ".lock владельца intact после close гостя");
  owner.append({ ts: 200, val: 'owner-again' });
  assert(owner.allRows().length === 4, `владелец продолжает работать со своим видом (факт ${owner.allRows().length})`);
  owner.close();

  // Семантика: открытые инстансы не делят «живой» вид диска — новые сегменты
  // друг друга видны после reopen / в новом инстансе. Сходимость на диске полная.
  const after = new Journal(baseDir, { lock: 'off' });
  after.open('shared', schema);
  assert(after.allRows().length === 5, `после reopen видны все записи обоих владельцев (факт ${after.allRows().length})`);
  after.close();
}

// --------------------------------------------------
// 3. Состояние после смерти воркера: .lock с живым PID процесса
//    (worker_threads разделяет PID — «мёртвого» владельца не определить)
// --------------------------------------------------
{
  // Готовим журнал с данными и чистое закрытие
  const seed = new Journal(baseDir);
  seed.open('orphan', schema);
  for (let i = 0; i < 2; i++) seed.append({ ts: i, val: 'seed' });
  seed.close();

  // Эмуляция краха воркера: .lock остался, PID жив (это PID нашего процесса)
  fs.writeFileSync(lockPathOf('orphan'), JSON.stringify({ pid: process.pid, ts: Date.now() }));

  let threw = false;
  try {
    const j = new Journal(baseDir);
    j.open('orphan', schema);
  } catch (e) {
    threw = true;
    assert(/заблокирован/.test(String(e)), 'ошибка упоминает блокировку');
    assert(/lock: 'off'/.test(String(e)), 'ошибка подсказывает способ обхода (lock:\'off\')');
  }
  assert(threw, 'по умолчанию журнал с «живым» PID владельца не открывается — задокументированное ограничение');

  // Выход для приложения: взять ответственность на себя
  const j = new Journal(baseDir, { lock: 'off' });
  j.open('orphan', schema);
  assert(j.allRows().length === 2, `lock:'off' видит данные «осиротевшего» журнала (факт ${j.allRows().length})`);
  j.append({ ts: 9, val: 'recovered' });
  j.close();

  const verify = new Journal(baseDir, { lock: 'off' });
  verify.open('orphan', schema);
  assert(verify.allRows().length === 3, `запись поверх осиротевшего журнала переживает reopen (факт ${verify.allRows().length})`);
  verify.close();

  fs.rmSync(lockPathOf('orphan'), { force: true }); // убираем эмуляцию краха
}

// --------------------------------------------------
// 4. Неправильное значение lock отклоняется сразу (в Journal и в Store)
// --------------------------------------------------
{
  let threw = false;
  try {
    new Journal(baseDir, { lock: 'bogus' as never });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, "Journal: lock:'bogus' → RangeError");

  threw = false;
  try {
    new Store(baseDir, { lock: 'bogus' as never });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, "Store: lock:'bogus' → RangeError");

  // Store прокидывает режим в создаваемые журналы
  const store = new Store(baseDir, { lock: 'off' });
  store.init();
  const j = store.openJournal('via-store', schema);
  assert(!fs.existsSync(lockPathOf('via-store')), "Store({lock:'off'}) → журнал без .lock");
  store.closeAll();

  // Переопределение на уровне openJournal работает в обе стороны
  const store2 = new Store(baseDir, { lock: 'off' });
  store2.init();
  const j2 = store2.openJournal('via-store-override', schema, {}, { lock: 'pid' });
  assert(j2.lockMode === 'pid', "openJournal(..., {lock:'pid'}) переопределяет Store");
  assert(fs.existsSync(lockPathOf('via-store-override')), '.lock создан при pid-режиме из openJournal');
  store2.closeAll();
}

console.log(`\nТесты блокировок: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
