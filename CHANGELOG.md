# CHANGELOG

## 2.2.0

### Публичный API — одно лицо (ClickHouse-модель)

- `index.ts` экспортирует только **Store**, **Table**, `define*Table` и
  публичные типы. Внутренняя механика (Journal, Segment, кодексы, SQL-парсер)
  больше не является публичным API (RULES.md §5).
- **Store** — каталог таблиц: `create(def)`, `open(name)`, `describe()`,
  `tables()`, `engineOf(name)`, `stats()`, `closeAll()`; общий кэш сегментов;
  манифест `_store.json` (самодостаточный артефакт: движок + схема + тиры).
- **Описания таблиц** — `defineLogTable`, `defineUpsertTable`,
  `defineSummingTable`, `defineCollapsingTable`: валидация при объявлении,
  не при первом compact().

### Движки слияния

- `log` — строки не меняются, дубли схлопываются;
- `upsert` — по `key` остаётся строка с max(`version`);
- `summing` — по `key` суммируются колонки из `sum`;
- `collapsing` — по `key` гаснут пары +1/−1 в колонке `sign`.

### CLI `vrack2-journal`

`create`, `append`, `query`, `stats`, `compact`, `tables` — записывать/смотреть
метрики из shell. `--ts` в мс (значения < 1e12 — секунды), `--from/--to` —
число или `'now-1d'`.

### Надёжность

- Отклонённый append (нарушение схемы) больше не портит WAL: запись WAL
  откатывается (буфер или уже на диске), следующая `open()` не падает.
  Регресс-тест в `test-durability.ts` (сценарий 6).

### Тесты

- 19 сценариев, 1094 проверки; `npm test`, `npm run typecheck`, `npm run build`.
