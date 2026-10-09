// Фаза 2 — Tier: журнал + разрешение + ttl.
//
// Мультитирная таблица (MergeTree) — это набор тиров от тонкого (индекс 0)
// к грубому. append идёт в самый тонкий; rollup переносит состарившееся на
// более грубые; retention чистит каждый тир старше его ttl.

import type { Journal } from '../journal.ts';
import type { ResolutionTier, Row, ScanOptions } from '../types.ts';

export class Tier {
  readonly index: number;
  readonly resMs: number;
  readonly ttlMs: number;
  readonly journal: Journal;

  constructor(index: number, cfg: ResolutionTier, journal: Journal) {
    this.index = index;
    this.resMs = cfg.resMs;
    this.ttlMs = cfg.ttlMs;
    this.journal = journal;
  }

  /** Имя журнала тира (для отладки): обычно `<name>/r<resMs>`. */
  get name(): string {
    // Tier оборачивает открытый журнал (store.openJournal) — имя задано.
    return this.journal.name as string;
  }

  get isOpen(): boolean {
    return this.journal.isOpen;
  }

  /** Запись в тир. */
  append(row: Row): void {
    this.journal.append(row);
  }

  /** Чтение [start, end] (обе границы включительно) с опциями скана. */
  scan(opts: ScanOptions = {}): Row[] {
    return this.journal.scan(opts);
  }

  /** Все строки тира (по ts ↑). */
  allRows(): Row[] {
    return this.journal.allRows();
  }

  /** Удалить строки с ts < beforeTs. */
  purge(beforeTs: number): { removedRows: number } {
    return this.journal.purge(beforeTs);
  }

  /** Слить активные сегменты на диск. */
  flush(): void {
    this.journal.flush();
  }

  /** Запустить компакцию (движок слияния тира). */
  compact(): ReturnType<Journal['compact']> {
    return this.journal.compact();
  }
}
