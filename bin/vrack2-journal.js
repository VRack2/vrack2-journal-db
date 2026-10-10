#!/usr/bin/env node
// ============================================================
// vrack2-journal — CLI (create/append/query/stats/compact/tables)
// ============================================================
import {
  Store,
  defineLogTable,
  defineUpsertTable,
  defineSummingTable,
  defineCollapsingTable
} from '../lib/index.js';

// --------------------------------------------------
// Разбор аргументов: --flag value, --flag=value, повторяемые флаги
// --------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        (out[k] ||= []).push(v);
      } else {
        const k = a.slice(2);
        const v = argv[++i];
        if (v === undefined) die(`флаг --${k} требует значение`);
        (out[k] ||= []).push(v);
      }
    } else {
      out._.push(a);
    }
  }
  for (const k of Object.keys(out)) if (Array.isArray(out[k]) && out[k].length === 1) out[k] = out[k][0];
  return out;
}

function die(msg, code = 1) {
  console.error(`vrack2-journal: ${msg}`);
  process.exit(code);
}

function one(opts, key, cmd) {
  const v = opts[key];
  if (v === undefined) die(`${cmd}: требуется --${key}`);
  return v;
}

/** 'now-1d' | число (мс; <1e12 — секунды) → ms. */
function toTs(v, what) {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) die(`${what}: не число — ${s}`);
    return n < 1e12 ? Math.round(n * 1000) : n;
  }
  return s; // 'now', 'now-1d', … — разбирает сам Table
}

/** value → number, если похоже на число, иначе строка. */
function coerce(v) {
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s) && !/^0\d/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  return s;
}

/** 'a=1,b=2' или повторяемый --field → { a: 1, b: 2 }. */
function parseFields(list, cmd) {
  const out = {};
  const items = Array.isArray(list) ? list : [list];
  for (const item of items) {
    for (const part of String(item).split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) die(`${cmd}: --field — формат key=value (получено "${part}")`);
      out[part.slice(0, eq).trim()] = coerce(part.slice(eq + 1));
    }
  }
  return out;
}

/** 'ts=delta,host=dictionary' → { ts: 'delta', host: 'dictionary' }. */
function parseColumns(s, cmd) {
  const out = {};
  for (const part of String(s).split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) die(`${cmd}: --columns — формат field=codec (получено "${part}")`);
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (Object.keys(out).length === 0) die(`${cmd}: --columns — непустое описание`);
  return out;
}

function parseList(s) {
  return String(s).split(',').map(x => x.trim()).filter(x => x.length > 0);
}

// --------------------------------------------------
// Команды
// --------------------------------------------------
function cmdCreate(opts) {
  const data = one(opts, 'data', 'create');
  const name = one(opts, 'name', 'create');
  const columns = parseColumns(one(opts, 'columns', 'create'), 'create');
  const base = {
    name,
    desc: opts.desc,
    columns,
    retention: opts.retention,
    tiers: opts.tiers,
    agg: opts.agg ? Object.fromEntries(parseList(opts.agg).map(p => {
      const eq = p.indexOf('=');
      if (eq <= 0) die(`create: --agg — формат field=fn (получено "${p}")`);
      return [p.slice(0, eq).trim(), p.slice(eq + 1).trim()];
    })) : undefined,
    dims: opts.dims ? parseList(opts.dims) : undefined
  };
  const engine = opts.engine ? String(opts.engine).trim() : 'log';
  const key = opts.key ? parseList(opts.key) : undefined;
  let def;
  switch (engine) {
    case 'log':
      def = defineLogTable(base);
      break;
    case 'upsert':
      def = defineUpsertTable({ ...base, key, version: opts.version });
      break;
    case 'summing':
      def = defineSummingTable({ ...base, key, sum: parseList(opts.sum), version: opts.version });
      break;
    case 'collapsing':
      def = defineCollapsingTable({ ...base, key, sign: opts.sign, version: opts.version });
      break;
    default:
      die(`create: движок — log|upsert|summing|collapsing (получено "${engine}")`);
  }
  const store = new Store(data);
  const t = store.create(def);
  console.log(JSON.stringify({ created: name, engine: def.kind, tiers: t.stats().length }, null, 2));
  store.closeAll();
}

function openTable(data, name) {
  const store = new Store(data);
  const t = store.open(name);
  return { store, t };
}

function cmdAppend(opts) {
  const data = one(opts, 'data', 'append');
  const name = one(opts, 'name', 'append');
  const fields = parseFields(one(opts, 'field', 'append'), 'append');
  fields.ts = toTs(one(opts, 'ts', 'append'), 'append --ts');
  const { store, t } = openTable(data, name);
  try {
    t.append(fields);
    console.log(JSON.stringify({ table: name, appended: 1, row: fields }, null, 2));
  } finally {
    store.closeAll();
  }
}

function cmdQuery(opts) {
  const data = one(opts, 'data', 'query');
  const name = one(opts, 'name', 'query');
  const from = opts.from !== undefined ? toTs(opts.from, 'query --from') : 0;
  const to = opts.to !== undefined ? toTs(opts.to, 'query --to') : Number.MAX_SAFE_INTEGER;
  const { store, t } = openTable(data, name);
  let rows;
  try {
    rows = t.query(from, to);
  } finally {
    store.closeAll();
  }
  const limit = opts.limit !== undefined ? Number(opts.limit) : undefined;
  console.log(JSON.stringify(limit !== undefined && Number.isFinite(limit) ? rows.slice(0, limit) : rows, null, 2));
}

function cmdStats(opts) {
  const data = one(opts, 'data', 'stats');
  const store = new Store(data);
  try {
    if (opts.name !== undefined) {
      const t = store.open(one(opts, 'name', 'stats'));
      console.log(JSON.stringify({ table: t.name, engine: store.engineOf(t.name), tiers: t.stats() }, null, 2));
    } else {
      console.log(JSON.stringify({ store: store.stats(), tables: store.describe() }, null, 2));
    }
  } finally {
    store.closeAll();
  }
}

function cmdCompact(opts) {
  const data = one(opts, 'data', 'compact');
  const name = one(opts, 'name', 'compact');
  const { store, t } = openTable(data, name);
  let report;
  try {
    report = t.compact();
  } finally {
    store.closeAll();
  }
  console.log(JSON.stringify({ table: name, compact: report }, null, 2));
}

function cmdTables(opts) {
  const data = one(opts, 'data', 'tables');
  const store = new Store(data);
  try {
    const descs = store.describe();
    const out = descs.map(d => ({
      name: d.name,
      engine: d.kind,
      rows: d.rows,
      segments: d.segments,
      sizeBytes: d.sizeBytes
    }));
    console.log(JSON.stringify({ count: out.length, tables: out }, null, 2));
  } finally {
    store.closeAll();
  }
}

// --------------------------------------------------
// main
// --------------------------------------------------
const USAGE = `vrack2-journal — CLI к журналу (таблицы, движки, тиры)

Команды:
  create   --data DIR --name NAME --columns ts=delta,host=dictionary,value=auto
           [--desc TEXT] [--engine log|upsert|summing|collapsing]
           [--key host] [--version ts] [--sum value] [--sign s]
           [--retention '5s:1d,15s:1w'] [--agg value=avg] [--dims host]
  append   --data DIR --name NAME --ts 1700000000 [--field k=v,k2=v2]
  query    --data DIR --name NAME [--from now-1d] [--to now] [--limit N]
  stats    --data DIR [--name NAME]
  compact  --data DIR --name NAME
  tables   --data DIR

Примеры:
  vrack2-journal create --data ./data --name cpu --columns ts=delta,host=dictionary,value=auto
  vrack2-journal append --data ./data --name cpu --ts 1700000000 --field host=web-1,value=42
  vrack2-journal query  --data ./data --name cpu --from now-1d
  vrack2-journal stats  --data ./data
  vrack2-journal compact --data ./data --name cpu
  vrack2-journal tables --data ./data
`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(USAGE);
    return;
  }
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const handlers = {
    create: cmdCreate,
    append: cmdAppend,
    query: cmdQuery,
    stats: cmdStats,
    compact: cmdCompact,
    tables: cmdTables
  };
  const fn = handlers[cmd];
  if (!fn) {
    console.error(`vrack2-journal: неизвестная команда "${cmd}"\n`);
    console.log(USAGE);
    process.exit(1);
  }
  try {
    fn(opts);
  } catch (e) {
    die(String(e?.message ?? e));
  }
}

main();
