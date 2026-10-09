// ============================================================
// SqlError.ts — Исключение парсинга SQL-lite
// ============================================================

export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlError';
  }
}
