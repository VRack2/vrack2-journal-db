// ============================================================
// codec.ts — Формат файла сегмента v2: сжатие и целостность
//
//   [0..3]    магические байты "JSDB"
//   [4]       версия формата файла (1 = gzip + JSON)
//   [5..7]    зарезервировано (нули)
//   [8..N-5]  gzip(JSON(сегмент))
//   [N-4..N-1] CRC32 всех предыдущих байтов, little-endian u32
//
// Файлы v1 (чистый JSON из JS-реализации) читаются как есть —
// по отсутствию магических байтов. Запись всегда в формате v2.
// ============================================================

import zlib from 'node:zlib';
import type { SerializedSegment } from './types.ts';

const MAGIC = Buffer.from('JSDB', 'ascii');
const FORMAT_GZIP_JSON = 1;
const HEADER_SIZE = 8;
const CRC_SIZE = 4;

/** Сериализованный сегмент → буфер файла v2 (gzip + CRC32) */
export function encodeSegment(data: SerializedSegment): Buffer {
  const json = Buffer.from(JSON.stringify(data), 'utf-8');
  const payload = zlib.gzipSync(json, { level: 6 });

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header[4] = FORMAT_GZIP_JSON;

  const body = Buffer.concat([header, payload]);
  const crc = zlib.crc32(body) >>> 0;
  const tail = Buffer.alloc(CRC_SIZE);
  tail.writeUInt32LE(crc, 0);

  return Buffer.concat([body, tail]);
}

/** Буфер файла → сериализованный сегмент. Поддерживает v1 (чистый JSON) и v2 */
export function decodeSegment(buf: Buffer): SerializedSegment {
  if (buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    return _decodeV2(buf);
  }

  // Legacy v1: файл — чистый JSON
  try {
    return JSON.parse(buf.toString('utf-8')) as SerializedSegment;
  } catch (e) {
    throw new Error(`Не удалось прочитать сегмент: ${_msg(e)}`);
  }
}

function _decodeV2(buf: Buffer): SerializedSegment {
  if (buf.length < HEADER_SIZE + CRC_SIZE) {
    throw new Error('Повреждённый сегмент: файл слишком мал');
  }

  const format = buf[4];
  if (format !== FORMAT_GZIP_JSON) {
    throw new Error(`Неподдерживаемый формат файла сегмента: ${format}`);
  }

  // Проверка контрольной суммы до разжатия — битые файлы не читаем
  const body = buf.subarray(0, buf.length - CRC_SIZE);
  const storedCrc = buf.readUInt32LE(buf.length - CRC_SIZE);
  const actualCrc = zlib.crc32(body) >>> 0;
  if (storedCrc !== actualCrc) {
    throw new Error('Повреждённый сегмент: контрольная сумма не совпадает');
  }

  let json: Buffer;
  try {
    json = zlib.gunzipSync(buf.subarray(HEADER_SIZE, buf.length - CRC_SIZE));
  } catch (e) {
    throw new Error(`Повреждённый сегмент: ${_msg(e)}`);
  }

  return JSON.parse(json.toString('utf-8')) as SerializedSegment;
}

/** Является ли буфер файлом v2 (по магическим байтам) */
export function isCompressedFormat(buf: Buffer): boolean {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function _msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
