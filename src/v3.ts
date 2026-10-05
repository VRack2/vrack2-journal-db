// ============================================================
// v3.ts — Бинарный формат сегмента v3 (Фаза 2)
//
//   [0..3]    "JSDB"
//   [4]       3  (версия)
//   [5..7]    0
//   [8..11]   headerLen (u32 LE)
//   [12 ..]   header JSON (UTF-8): схема, саммари, rowMap, кодек колонки,
//             порядок колонок, способ сжатия
//   далее, для каждой колонки (в порядке columnOrder):
//     [blobLen u32]
//     [сжатый блоб]   (gzip по умолчанию, zstd — опция)
//   [N-4..N-1] CRC32 всех предыдущих байтов
//
// Колонки:
//   numeric — маска null + числовой кодек (f64|doubleDelta|gorilla|rle)
//   dict    — словарь отдельных значений + индекс на строку
//
// Lossless: все значения восстанавливаются точно. v1/v2 читаются как раньше;
// запись v3 включается флагом format:'v3' (см. Journal).
// ============================================================

import zlib from 'node:zlib';
import { Segment } from './segment.ts';
import { RawColumn } from './columns.ts';
import { decodeSegment } from './codec.ts';
import { getNumCodec, autoPickNumCodec } from './numcodecs.ts';
import type { JsonValue, Metadata, Schema, ColumnSummary } from './types.ts';

const MAGIC = Buffer.from('JSDB', 'ascii');
const V3 = 3;

export type Compression = 'none' | 'gzip' | 'zstd';

export interface V3EncodeOptions {
  /** Способ сжатия блобов: 'zstd' (по умолчанию при Node ≥ 23.8) или 'gzip'. */
  compression?: Compression;
  /** Явный выбор числового кодека для колонки (field → имя кодека).
   *  Пропущенные колонки — авто-выбор по данным (autoPickNumCodec). */
  codecs?: Record<string, string>;
}

interface V3ColSpec {
  kind: 'numeric' | 'dict';
  codec?: string;
}

interface V3Header {
  v: 3;
  id: string;
  schema: Schema;
  metadata: Metadata;
  rowCount: number;
  physicalRowCount: number;
  tsCount: number;
  minTs: number | null;
  maxTs: number | null;
  rowMap: number[];
  summaries: Record<string, ColumnSummary>;
  compression: Compression;
  columnOrder: string[];
  columns: Record<string, V3ColSpec>;
}

// --------------------------------------------------
// Сжатие (zstd по умолчанию при Node >= 23.8, иначе gzip)
// --------------------------------------------------
/** Есть ли zstd в zlib (Node >= 23.8). */
export function zstdAvailable(): boolean {
  const z = zlib as unknown as { zstdCompressSync?: unknown };
  return typeof z.zstdCompressSync === 'function';
}

/**
 * Дефолт сжатия: zstd при Node >= 23.8 (где он есть в zlib), иначе gzip.
 * Явный opts.compression в Journal всегда переопределяет этот дефолт.
 */
export function defaultCompression(): 'gzip' | 'zstd' {
  if (zstdAvailable()) return 'zstd';
  return 'gzip';
}

function compress(buf: Buffer, mode: Compression): Buffer {
  if (mode === 'none') return buf;
  if (mode === 'zstd') {
    const z = zlib as unknown as { zstdCompressSync?: (b: Buffer, o?: unknown) => Buffer };
    if (typeof z.zstdCompressSync === 'function') {
      return z.zstdCompressSync(buf, { level: 3 });
    }
  }
  return zlib.gzipSync(buf, { level: 6 });
}

function decompress(buf: Buffer, mode: Compression): Buffer {
  if (mode === 'none') return buf;
  if (mode === 'zstd') {
    const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
    if (typeof z.zstdDecompressSync === 'function') {
      return z.zstdDecompressSync(buf);
    }
  }
  return zlib.gunzipSync(buf);
}

// --------------------------------------------------
// Классификация колонки и ключ словаря
// --------------------------------------------------
function pickKind(values: JsonValue[]): 'numeric' | 'dict' {
  if (values.length === 0) return 'numeric';
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'dict';
  }
  return 'numeric';
}

function dictKey(v: JsonValue): string {
  if (v === null || v === undefined) return '\0null';
  if (typeof v === 'object') return 'o' + JSON.stringify(v);
  return typeof v + ':' + String(v);
}

// --------------------------------------------------
// Кодирование блоба колонки
// --------------------------------------------------
function encodeNumericBlob(
  values: JsonValue[],
  codecName: string
): { buf: Buffer; codecUsed: string } {
  const n = values.length;
  const maskBytes = Math.ceil(n / 8);
  const mask = new Uint8Array(maskBytes);
  const nonNull: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      mask[i >> 3] |= 1 << (7 - (i & 7));
    } else {
      nonNull.push(v as number);
    }
  }

  // Незнакомое имя кодека — ошибка (опечатка не должна молча уйти в f64).
  const codec = getNumCodec(codecName);
  // Запрошенный кодек не подошёл данным (например, rle на дробных — бросает) →
  // честно переходим на f64 и фиксируем ИСПОЛЬЗОВАННЫЙ кодек в схеме.
  let codecUsed = codecName;
  let codecBuf: Buffer;
  try {
    codecBuf = codec.encode(nonNull);
  } catch {
    codecUsed = 'f64';
    codecBuf = getNumCodec('f64').encode(nonNull);
  }

  const head = Buffer.alloc(4);
  head.writeUInt32LE(nonNull.length, 0);
  const buf = Buffer.concat([head, Buffer.from(mask), codecBuf]);
  return { buf, codecUsed };
}

function encodeDictBlob(values: JsonValue[]): Buffer {
  const dict: JsonValue[] = [];
  const map = new Map<string, number>();
  const indices: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] === undefined ? null : values[i];
    const key = dictKey(v);
    let idx = map.get(key);
    if (idx === undefined) {
      idx = dict.length;
      dict.push(v);
      map.set(key, idx);
    }
    indices[i] = idx;
  }

  const parts: Buffer[] = [];
  const head = Buffer.alloc(8);
  head.writeUInt32LE(values.length, 0);
  head.writeUInt32LE(dict.length, 4);
  parts.push(head);
  for (const entry of dict) {
    const enc = Buffer.from(JSON.stringify(entry), 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(enc.length, 0);
    parts.push(len, enc);
  }
  const idxBuf = Buffer.alloc(indices.length * 4);
  for (let i = 0; i < indices.length; i++) idxBuf.writeUInt32LE(indices[i], i * 4);
  parts.push(idxBuf);
  return Buffer.concat(parts);
}

// --------------------------------------------------
// Декодирование блоба колонки
// --------------------------------------------------
function decodeNumericBlob(blob: Buffer, codecName: string, physicalRowCount: number): JsonValue[] {
  let off = 0;
  const nonNullCount = blob.readUInt32LE(off); off += 4;
  const maskBytes = Math.ceil(physicalRowCount / 8);
  const mask = blob.subarray(off, off + maskBytes); off += maskBytes;
  const codecBuf = blob.subarray(off);

  const codec = getNumCodec(codecName);
  const vals = codec.decode(codecBuf, nonNullCount);

  const out: JsonValue[] = new Array(physicalRowCount);
  let vi = 0;
  for (let i = 0; i < physicalRowCount; i++) {
    const isNull = (mask[i >> 3] >> (7 - (i & 7))) & 1;
    if (isNull) out[i] = null;
    else out[i] = vals[vi++];
  }
  return out;
}

function decodeDictBlob(blob: Buffer): JsonValue[] {
  let off = 0;
  const rowCnt = blob.readUInt32LE(off); off += 4;
  const dictCnt = blob.readUInt32LE(off); off += 4;
  const dict: JsonValue[] = new Array(dictCnt);
  for (let i = 0; i < dictCnt; i++) {
    const len = blob.readUInt32LE(off); off += 4;
    dict[i] = JSON.parse(blob.subarray(off, off + len).toString('utf-8'));
    off += len;
  }
  const out: JsonValue[] = new Array(rowCnt);
  for (let i = 0; i < rowCnt; i++) {
    const idx = blob.readUInt32LE(off); off += 4;
    out[i] = dict[idx];
  }
  return out;
}

// --------------------------------------------------
// Публичные функции
// --------------------------------------------------

/** Является ли буфер сегментом v3 (по магическим байтам и версии). */
export function isV3(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 4).equals(MAGIC) && buf[4] === V3;
}

/** Сериализует сегмент в буфер v3 (бинарные блобы + сжатие + CRC32). */
export function encodeV3(segment: Segment, opts: V3EncodeOptions = {}): Buffer {
  const compression: Compression = opts.compression ?? defaultCompression();
  const columnOrder = Object.keys(segment.schema);

  const specs: Record<string, V3ColSpec> = {};
  const blobs: Buffer[] = new Array(columnOrder.length);

  for (let ci = 0; ci < columnOrder.length; ci++) {
    const field = columnOrder[ci];
    const col = segment.columns[field];
    const values: JsonValue[] = new Array(segment.physicalRowCount);
    for (let i = 0; i < segment.physicalRowCount; i++) values[i] = col.get(i);

    const kind = pickKind(values);
    if (kind === 'numeric') {
      const numeric = values.filter((v): v is number => typeof v === 'number');
      const requested = opts.codecs?.[field] ?? autoPickNumCodec(numeric);
      const { buf, codecUsed } = encodeNumericBlob(values, requested);
      specs[field] = { kind: 'numeric', codec: codecUsed };
      blobs[ci] = compress(buf, compression);
    } else {
      specs[field] = { kind: 'dict' };
      blobs[ci] = compress(encodeDictBlob(values), compression);
    }
  }

  const header: V3Header = {
    v: 3,
    id: segment.id,
    schema: segment.schema,
    metadata: segment.metadata,
    rowCount: segment.rowCount,
    physicalRowCount: segment.physicalRowCount,
    tsCount: segment.tsCount,
    minTs: segment.minTs,
    maxTs: segment.maxTs,
    rowMap: segment.rowMap,
    summaries: segment.summaries,
    compression,
    columnOrder,
    columns: specs
  };

  const headerBuf = Buffer.from(JSON.stringify(header), 'utf-8');
  const headLen = Buffer.alloc(4);
  headLen.writeUInt32LE(headerBuf.length, 0);

  const parts: Buffer[] = [];
  const magic = Buffer.alloc(8);
  MAGIC.copy(magic, 0);
  magic[4] = V3;
  parts.push(magic, headLen, headerBuf);

  for (let ci = 0; ci < columnOrder.length; ci++) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(blobs[ci].length, 0);
    parts.push(len, blobs[ci]);
  }

  const body = Buffer.concat(parts);
  const crc = zlib.crc32(body) >>> 0;
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(crc, 0);
  return Buffer.concat([body, tail]);
}

/** Буфер v3 → в-памяти сегмент. */
export function decodeV3(buf: Buffer): Segment {
  if (!isV3(buf)) {
    throw new Error('decodeV3: буфер не является сегментом v3');
  }
  if (buf.length < 12) {
    throw new Error('Повреждённый сегмент v3: файл слишком мал');
  }

  // CRC32 до разжатия — битые файлы не читаем
  const body = buf.subarray(0, buf.length - 4);
  const storedCrc = buf.readUInt32LE(buf.length - 4);
  const actualCrc = zlib.crc32(body) >>> 0;
  if (storedCrc !== actualCrc) {
    throw new Error('Повреждённый сегмент v3: контрольная сумма не совпадает');
  }

  const headerLen = buf.readUInt32LE(8);
  const headerBuf = buf.subarray(12, 12 + headerLen);
  const header = JSON.parse(headerBuf.toString('utf-8')) as V3Header;
  let off = 12 + headerLen;

  const compression = header.compression ?? 'gzip';
  const blobMap = new Map<string, Buffer>();
  for (const field of header.columnOrder) {
    const blobLen = buf.readUInt32LE(off); off += 4;
    const blobBuf = buf.subarray(off, off + blobLen); off += blobLen;
    blobMap.set(field, decompress(blobBuf, compression));
  }

  const seg = new Segment(header.id, header.schema, header.metadata);
  seg.rowCount = header.rowCount;
  seg.physicalRowCount = header.physicalRowCount;
  seg.minTs = header.minTs;
  seg.maxTs = header.maxTs;
  // v3-запись всегда хранит tsCount и summaries (см. encodeV3) — fallback не нужен
  seg.tsCount = typeof header.tsCount === 'number' ? header.tsCount : 0;
  seg.rowMap = header.rowMap;
  seg.summaries = header.summaries && typeof header.summaries === 'object'
    ? header.summaries
    : {};

  for (const field of header.columnOrder) {
    const spec = header.columns[field];
    const blob = blobMap.get(field)!;
    const values = spec.kind === 'numeric'
      ? decodeNumericBlob(blob, spec.codec ?? 'f64', header.physicalRowCount)
      : decodeDictBlob(blob);

    const col = new RawColumn();
    for (const v of values) col.append(v);
    seg.columns[field] = col;
  }

  return seg;
}

/**
 * Мульти-версионный reader: v1 (чистый JSON) / v2 (gzip+JSON) / v3 (бинарный)
 * → единый в-памяти сегмент.
 */
export function readSegment(buf: Buffer): Segment {
  if (isV3(buf)) return decodeV3(buf);
  const data = decodeSegment(buf);
  return Segment.deserialize(data);
}
