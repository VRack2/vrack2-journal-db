// ============================================================
// retention.ts — Тир'ы retention (Фаза 4)
//
// Закрытые сегменты Journals живут в тир'ах по возрасту данных:
//   0–7d   f64 + raw        (1h блок)
//   7–30d  doubleDelta + raw (1h блок)
//   30–365d gorilla + raw   (1d блок)
//   365d+  rle + gzip + tsDelta (1d блок)
//
// Движок:
//   - status()      — сколько сегментов/байт/строк в каждом тир'е;
//   - plan()        — что перекодировать/слить (dry-run);
//   - apply()       — перекодирует сегменты в тир'ы и сливает блоки
//                     (1h → 1d) без потери данных (дедупликация на границах);
//   - compactTier() — только слияние блоков в одном тир'е.
//
// Конвертация без потери данных: данные читаются из сегмента и переписываются
// в новый файл целиком; дедупликация (segment.append) работает как при compact.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import type { Journal } from './journal.ts';
import { Segment } from './segment.ts';
import { encodeV3, type Compression } from './v3.ts';
import type {
  ApplyReport,
  CompactTierReport,
  ConversionPlan,
  RetentionTier,
  TierStatus,
} from './types.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Тир'ы по умолчанию (см. docs/metrics-engine-plan.md, Фаза 4):
 * 0–7d f64+raw; 7–30d doubleDelta+raw; 30–365d gorilla+raw; 365d+ rle+gzip+tsDelta.
 * Блоки: 1h для свежих, 1d для старых (1h → 1d).
 */
export function defaultTiers(): RetentionTier[] {
  return [
    { id: 'hot',     from: 0,         to: 7 * DAY,     codec: 'f64',         block: 1 * HOUR, compress: 'none', minInterval: 0, tsDelta: false },
    { id: 'warm',    from: 7 * DAY,   to: 30 * DAY,    codec: 'doubleDelta', block: 1 * HOUR, compress: 'none', minInterval: 0, tsDelta: false },
    { id: 'cold',    from: 30 * DAY,  to: 365 * DAY,   codec: 'gorilla',     block: 1 * DAY,  compress: 'none', minInterval: 0, tsDelta: false },
    { id: 'archive', from: 365 * DAY, to: Infinity,    codec: 'rle',         block: 1 * DAY,  compress: 'gzip', minInterval: 0, tsDelta: true },
  ];
}

// --------------------------------------------------
// Вспомогательное: поля данных и кодек'и тира
// --------------------------------------------------

/** Определяет колонку ts и колонку значений (первая числовая, не ts). */
function pickFields(segment: Segment): { tsField: string | null; valueField: string | null } {
  const fields = Object.keys(segment.schema);
  const tsField = fields.includes('ts') ? 'ts' : null;
  let valueField: string | null = null;
  for (const f of fields) {
    if (f === tsField) continue;
    if (!segment.columns[f]) continue;
    let numeric = true, seen = false;
    const n = Math.min(segment.rowCount, 64);
    for (let i = 0; i < n; i++) {
      const v = segment.get(f, i);
      if (v === null || v === undefined) continue;
      seen = true;
      if (typeof v !== 'number') { numeric = false; break; }
    }
    if (numeric && seen) { valueField = f; break; }
  }
  return { tsField, valueField };
}

/** Кодек'и для сегмента по тир'у: значение → tier.codec, ts → doubleDelta (если tsDelta). */
function buildCodecs(segment: Segment, tier: RetentionTier): Record<string, string> {
  const { tsField, valueField } = pickFields(segment);
  const codecs: Record<string, string> = {};
  if (valueField) codecs[valueField] = tier.codec;
  if (tier.tsDelta && tsField) codecs[tsField] = 'doubleDelta';
  return codecs;
}

// --------------------------------------------------
// Вспомогательное: текущее кодирование файла сегмента
// --------------------------------------------------

/** Текущее кодирование файла сегмента (из v3-заголовка). */
export interface SegmentEncoding {
  v3: boolean;
  compression: string;
  /** Числовые кодек'и: поле → имя кодека. */
  codecs: Record<string, string>;
}

type EncInfo = SegmentEncoding;

const NOT_V3: EncInfo = { v3: false, compression: '', codecs: {} };

/** Читает v3-заголовок файла (магия + headerLen + header) без загрузки блобов. */
function inspectSegFile(filePath: string): EncInfo {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    const n = fs.readSync(fd, head, 0, 12, 0);
    if (n < 12) return NOT_V3;
    if (!head.subarray(0, 4).equals(Buffer.from('JSDB', 'ascii')) || head[4] !== 3) {
      return NOT_V3;
    }
    const headerLen = head.readUInt32LE(8);
    const hbuf = Buffer.alloc(headerLen);
    fs.readSync(fd, hbuf, 0, headerLen, 12);
    const header = JSON.parse(hbuf.toString('utf-8'));
    const codecs: Record<string, string> = {};
    if (header.columns && typeof header.columns === 'object') {
      for (const [f, spec] of Object.entries(header.columns)) {
        if (spec && typeof spec === 'object' && (spec as { kind?: string }).kind === 'numeric') {
          const c = (spec as { codec?: string }).codec;
          if (typeof c === 'string') codecs[f] = c;
        }
      }
    }
    return { v3: true, compression: header.compression ?? 'gzip', codecs };
  } catch {
    return NOT_V3;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Совпадает ли текущее кодирование с тир'ом? */
function matchesTier(ins: EncInfo, tier: RetentionTier, segment: Segment): boolean {
  if (!ins.v3) return false;
  if (ins.compression !== tier.compress) return false;
  const { tsField, valueField } = pickFields(segment);
  if (valueField && ins.codecs[valueField] !== tier.codec) return false;
  if (tier.tsDelta && tsField && ins.codecs[tsField] !== 'doubleDelta') return false;
  return true;
}

// --------------------------------------------------
// RetentionEngine
// --------------------------------------------------

/**
 * Движок retention: перекодирование закрытых сегментов в тир'ы по возрасту
 * данных и слияние блоков (1h → 1d). Не трогает активный сегмент.
 *
 *   const eng = journal.retention;          // тир'ы по умолчанию
 *   eng.status();                           // статус тир'ов
 *   eng.plan();                             // dry-run
 *   eng.apply();                            // применить
 *   eng.compactTier('archive');             // только слияние в тир'е
 */
export class RetentionEngine {
  private readonly journal: Journal;
  readonly tiers: RetentionTier[];
  private readonly nowProvider: () => number;
  private readonly encCache = new Map<string, EncInfo>();

  constructor(journal: Journal, tiers?: RetentionTier[], nowProvider?: () => number) {
    if (!journal) throw new TypeError('RetentionEngine: journal обязателен');
    this.journal = journal;
    this.tiers = (tiers ?? defaultTiers())
      .slice()
      .sort((a, b) => a.from - b.from);
    this.nowProvider = nowProvider ?? (() => Date.now());
  }

  /** Текущее время (для расчёта возраста). */
  now(): number {
    return this.nowProvider();
  }

  /** Тир для возраста (мс). */
  tierForAge(ageMs: number): RetentionTier {
    for (const t of this.tiers) {
      if (ageMs >= t.from && ageMs < t.to) return t;
    }
    return this.tiers[this.tiers.length - 1]; // самый старый
  }

  /** Тир для временной метки данных. */
  tierForTs(ts: number): RetentionTier {
    return this.tierForAge(Math.max(0, this.now() - ts));
  }

  /**
   * Текущее кодирование закрытого сегмента (из v3-заголовка): формат,
   * сжатие, числовые кодек'и. null, если сегмент/файл неизвестен.
   */
  encodingOf(segId: string): SegmentEncoding | null {
    const file = this.journal.closedSegmentFile(segId);
    if (!file) return null;
    let ins = this.encCache.get(segId);
    if (!ins) {
      ins = inspectSegFile(path.join(this.journal.journalPath(), file));
      this.encCache.set(segId, ins);
    }
    return ins;
  }

  /** Статус тир'ов: сегменты/байты/строки/диапазон ts. */
  status(now?: number): TierStatus[] {
    const t = now ?? this.now();
    const out = new Map<string, TierStatus>();
    for (const tier of this.tiers) {
      out.set(tier.id, {
        id: tier.id, from: tier.from, to: tier.to,
        segments: 0, bytes: 0, rows: 0, oldestTs: null, newestTs: null,
      });
    }
    for (const id of this.journal.closedSegmentIds()) {
      const info = this.journal.closedSegmentInfo(id);
      if (!info || info.maxTs === null) continue;
      const tier = this.tierForAge(Math.max(0, t - info.maxTs));
      const s = out.get(tier.id);
      if (!s) continue;
      s.segments++;
      s.bytes += info.bytes ?? 0;
      s.rows += info.rowCount ?? 0;
      if (info.minTs !== null && (s.oldestTs === null || info.minTs < s.oldestTs)) s.oldestTs = info.minTs;
      if (info.maxTs !== null && (s.newestTs === null || info.maxTs > s.newestTs)) s.newestTs = info.maxTs;
    }
    return [...out.values()];
  }

  /** Пункт плана для одного сегмента. */
  private planOne(id: string, t: number, tier: RetentionTier): { action: 'none' | 'reencode'; ins: EncInfo } {
    const file = this.journal.closedSegmentFile(id);
    let ins = this.encCache.get(id);
    if (!ins) {
      ins = file ? inspectSegFile(path.join(this.journal.journalPath(), file)) : NOT_V3;
      this.encCache.set(id, ins);
    }
    const seg = this.journal.getClosedSegment(id);
    const action = matchesTier(ins, tier, seg) ? 'none' : 'reencode';
    return { action, ins };
  }

  /**
   * План (dry-run): для каждой группы блоков тир'а — 'merge' (если группа ≥ 2),
   * иначе 'reencode' (если кодирование не совпадает с тир'ом), иначе 'none'.
   */
  plan(now?: number): ConversionPlan[] {
    const t = now ?? this.now();
    const groups = this.groupByTier(t);
    const plans: ConversionPlan[] = [];
    for (const g of groups) {
      const needMerge = g.ids.length >= 2;
      for (const id of g.ids) {
        const { action } = this.planOne(id, t, g.tier);
        plans.push({
          segId: id,
          tier: g.tier.id,
          action: needMerge ? 'merge' : action,
          targetCodec: g.tier.codec,
          targetCompress: g.tier.compress,
          groupSize: g.ids.length,
        });
      }
    }
    return plans;
  }

  /** Применяет retention: перекодирование в тир'ы + слияние блоков (1h → 1d). */
  apply(now?: number): ApplyReport {
    const t = now ?? this.now();
    const groups = this.groupByTier(t);
    let reencoded = 0, merged = 0, skipped = 0;
    const beforeSegments = this.journal.closedSegmentIds().length;
    const beforeBytes = this.totalBytes();

    for (const g of groups) {
      if (g.ids.length >= 2) {
        // Слияние блоков тир'а: дедупликация на границах + кодек/сжатие тир'а
        this.journal.mergeClosedSegments(g.ids, seg => this.encodeForTier(g.tier, seg));
        merged++;
      } else {
        const id = g.ids[0];
        const { action } = this.planOne(id, t, g.tier);
        if (action === 'none') {
          skipped++;
          continue;
        }
        this.journal.reencodeClosedSegment(id, seg => this.encodeForTier(g.tier, seg));
        reencoded++;
      }
    }

    this.encCache.clear();
    const afterSegments = this.journal.closedSegmentIds().length;
    const afterBytes = this.totalBytes();
    return { reencoded, merged, skipped, beforeSegments, afterSegments, beforeBytes, afterBytes };
  }

  /** Компактизация одного тир'а: только слияние блоков (без перекодирования одиночных). */
  compactTier(tierId: string, now?: number): CompactTierReport {
    const t = now ?? this.now();
    const tier = this.tiers.find(x => x.id === tierId);
    if (!tier) throw new RangeError(`Неизвестный тир: ${tierId}`);
    const groups = this.groupByTier(t).filter(g => g.tier.id === tierId);
    let mergedGroups = 0;
    const beforeSegments = this.journal.closedSegmentIds().length;
    for (const g of groups) {
      if (g.ids.length >= 2) {
        this.journal.mergeClosedSegments(g.ids, seg => this.encodeForTier(tier, seg));
        mergedGroups++;
      }
    }
    this.encCache.clear();
    const afterSegments = this.journal.closedSegmentIds().length;
    return { tier: tierId, mergedGroups, beforeSegments, afterSegments };
  }

  // --------------------------------------------------
  // Внутреннее
  // --------------------------------------------------

  /** Группирует закрытые сегменты по (тир, блок) — для слияния 1h → 1d. */
  private groupByTier(t: number): { tier: RetentionTier; blockKey: number; ids: string[] }[] {
    const groups = new Map<string, { tier: RetentionTier; blockKey: number; ids: string[] }>();
    for (const id of this.journal.closedSegmentIds()) {
      const info = this.journal.closedSegmentInfo(id);
      if (!info || info.minTs === null || info.maxTs === null) continue;
      const tier = this.tierForAge(Math.max(0, t - info.maxTs));
      const blockKey = tier.block > 0 ? Math.floor(info.minTs / tier.block) : 0;
      const key = `${tier.id}:${blockKey}`;
      let g = groups.get(key);
      if (!g) { g = { tier, blockKey, ids: [] }; groups.set(key, g); }
      g.ids.push(id);
    }
    return [...groups.values()];
  }

  /** Кодирует сегмент по тир'у: кодек значений + (опц.) дельта ts + сжатие. */
  private encodeForTier(tier: RetentionTier, segment: Segment): Buffer {
    return encodeV3(segment, {
      compression: tier.compress as Compression,
      codecs: buildCodecs(segment, tier),
    });
  }

  private totalBytes(): number {
    let b = 0;
    for (const id of this.journal.closedSegmentIds()) {
      b += this.journal.closedSegmentInfo(id)?.bytes ?? 0;
    }
    return b;
  }
}
