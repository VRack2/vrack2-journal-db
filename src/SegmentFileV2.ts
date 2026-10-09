// ============================================================
// SegmentFileV2.ts — Формат файла сегмента v2: сжатие и целостность
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
import { Compression } from './Compression.ts';
import type { SerializedSegment } from './types.ts';

export class SegmentFileV2 {
  /** Магические байты формата ("JSDB"). */
  static readonly MAGIC = Buffer.from('JSDB', 'ascii');

  private static readonly FORMAT_GZIP_JSON = 1;
  private static readonly HEADER_SIZE = 8;
  private static readonly CRC_SIZE = 4;

  /** Сериализованный сегмент → буфер файла v2 (gzip + CRC32) */
  static encode(data: SerializedSegment): Buffer {
    const json = Buffer.from(JSON.stringify(data), 'utf-8');
    const payload = Compression.compress(json, 'gzip');

    const header = Buffer.alloc(this.HEADER_SIZE);
    this.MAGIC.copy(header, 0);
    header[4] = this.FORMAT_GZIP_JSON;

    const body = Buffer.concat([header, payload]);
    const crc = zlib.crc32(body) >>> 0;
    const tail = Buffer.alloc(this.CRC_SIZE);
    tail.writeUInt32LE(crc, 0);

    return Buffer.concat([body, tail]);
  }

  /** Буфер файла → сериализованный сегмент. Поддерживает v1 (чистый JSON) и v2 */
  static decode(buf: Buffer): SerializedSegment {
    if (buf.length >= this.MAGIC.length && buf.subarray(0, this.MAGIC.length).equals(this.MAGIC)) {
      return this.decodeV2(buf);
    }

    // Legacy v1: файл — чистый JSON
    try {
      return JSON.parse(buf.toString('utf-8')) as SerializedSegment;
    } catch (e) {
      throw new Error(`Не удалось прочитать сегмент: ${this.msg(e)}`);
    }
  }

  private static decodeV2(buf: Buffer): SerializedSegment {
    if (buf.length < this.HEADER_SIZE + this.CRC_SIZE) {
      throw new Error('Повреждённый сегмент: файл слишком мал');
    }

    const format = buf[4];
    if (format !== this.FORMAT_GZIP_JSON) {
      throw new Error(`Неподдерживаемый формат файла сегмента: ${format}`);
    }

    // Проверка контрольной суммы до разжатия — битые файлы не читаем
    const body = buf.subarray(0, buf.length - this.CRC_SIZE);
    const storedCrc = buf.readUInt32LE(buf.length - this.CRC_SIZE);
    const actualCrc = zlib.crc32(body) >>> 0;
    if (storedCrc !== actualCrc) {
      throw new Error('Повреждённый сегмент: контрольная сумма не совпадает');
    }

    let json: Buffer;
    try {
      json = Compression.decompress(buf.subarray(this.HEADER_SIZE, buf.length - this.CRC_SIZE), 'gzip');
    } catch (e) {
      throw new Error(`Повреждённый сегмент: ${this.msg(e)}`);
    }

    return JSON.parse(json.toString('utf-8')) as SerializedSegment;
  }

  private static msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
