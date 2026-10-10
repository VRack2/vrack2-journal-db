// ============================================================
// Interval.ts — «язык интервалов», совместимый с VRackDB Interval
// (https://github.com/ponikrf/VRackDB), но базовая единица — миллисекунды.
//
//   VRackDB Interval:   MTU = секунда,  nowFactor = 0.001 (мс → сек)
//   здесь (Interval):   MTU = миллисекунда, nowFactor = 1 (мс → мс)
//
// Синтаксис и имена методов совпадают с VRackDB, поэтому привычный код
// (Interval.parseInterval('1h'), Interval.period('now-1d:now')) переносится
// почти как есть. Без внешних зависимостей.
//
//   '15s' '10m' '1h' '1d' '2w' '3mon' '1y'  — интервал (→ мс)
//   'now-1d' 'now+1h' 'now-1h-1m'           — относительный момент (→ мс)
//   'now-7d:now'                            — период [start, end] (→ мс)
// ============================================================

/** Единица времени → миллисекунды (маппинг совпадает с VRackDB: mon=30д, y=365д). */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mon: 2_592_000_000, // 30 дней
  y: 31_536_000_000   // 365 дней
};

export class Interval {
  /** Множитель из стандартного JS-времени (мс) в нашу базовую единицу (МС). */
  static getFactor(): number {
    return 1;
  }

  /** Текущее время в нашей базовой единице (мс). */
  static now(): number {
    return Date.now();
  }

  /**
   * Интервал строкой → миллисекунды.
   *   '10s' → 10_000, '1m' → 60_000, '1h' → 3_600_000, '1d' → 86_400_000
   *   '900' → 900 (просто число — уже мс)
   */
  static parseInterval(ival: string): number {
    const s = String(ival).replace(/\s/g, '');
    const m = s.match(/^(\d+)([a-zA-Z]+)$/);
    if (m) {
      const unit = UNIT_MS[m[2]];
      if (unit === undefined) {
        throw new RangeError(
          `Interval: неизвестная единица «${m[2]}» (доступно: ms s m h d w mon y)`
        );
      }
      return Math.round(parseInt(m[1], 10) * unit);
    }
    if (!/^\d+$/.test(s)) {
      throw new RangeError('Interval: некорректный интервал, примеры: 10s, 1m, 1h, 1d');
    }
    return parseInt(s, 10);
  }

  /**
   * Относительный момент / отрезок → миллисекунды.
   *   'now-10d' → now − 10д, 'now+1h' → now + 1ч, 'now-1h-1m' → now − 1ч − 1м
   *   '10d'     → 10д,       '1700000000000' → это же (абсолютное время)
   * Поддерживает операторы `+` и `-`.
   */
  static partOfPeriod(str: string, now: number = Date.now()): number {
    const s = String(str).replace(/\s/g, '');
    let result = 0;
    let sign = 1;
    for (const token of s.split(/([-+])/)) {
      if (token === '-') { sign = -1; continue; }
      if (token === '+') { sign = 1; continue; }
      if (token === '') continue;
      let value: number;
      if (token === 'now') {
        value = now;
      } else if (/^\d+$/.test(token)) {
        value = parseInt(token, 10);
      } else {
        value = Interval.parseInterval(token);
      }
      result += value * sign;
    }
    return result;
  }

  /**
   * Одна граница: число (мс) или строка «языка интервалов»
   * ('now-1d'/'now'/'1700000000000') → миллисекунды. Числа проходят как есть.
   */
  static resolve(value: number | string, now: number = Date.now()): number {
    const v = typeof value === 'string' ? Interval.partOfPeriod(value, now) : value;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RangeError('Interval: resolve — число (мс) или строка вида now-1d/1700000000000');
    }
    return v;
  }

  /**
   * Период вида 'start:end' → [start, end] в мс.
   *   'now-7d:now' → [now − 7д, now]
   */
  static period(period: string, now?: number): [number, number];
  /**
   * Период по двум границам — число (мс) или строка вида 'now-1d' на каждом
   * конце → [start, end] в мс. Проверяет start <= end.
   *   ('now-7d', 'now') → [now − 7д, now]
   */
  static period(start: number | string, end: number | string, now?: number): [number, number];
  static period(a: string | number, b?: number | string, now?: number): [number, number] {
    // Старая форма: (строка 'start:end', now?) — без явного третьего аргумента.
    if (
      typeof a === 'string' && now === undefined &&
      (b === undefined || typeof b === 'number')
    ) {
      const parts = String(a).replace(/\s/g, '').split(':');
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
        throw new RangeError('Interval: период в формате «start:end», например now-7d:now');
      }
      return Interval._pair(parts[0], parts[1], typeof b === 'number' ? b : Date.now());
    }
    if (b === undefined) {
      throw new RangeError('Interval: period — две границы (start, end) или строка "start:end"');
    }
    return Interval._pair(a, b, now !== undefined ? now : Date.now());
  }

  /** Общая часть period(): резолвит границы и проверяет start <= end. */
  private static _pair(start: number | string, end: number | string, now: number): [number, number] {
    const s = Interval.resolve(start, now);
    const e = Interval.resolve(end, now);
    if (e < s) {
      throw new RangeError('Interval: start должен быть <= end');
    }
    return [s, e];
  }

  /** Округляет время вниз до кратности `precision`. */
  static roundTime(time: number, precision: number): number {
    if (!Number.isInteger(time)) {
      throw new RangeError('Interval: time должен быть целым числом');
    }
    if (!Number.isInteger(precision) || precision <= 0) {
      throw new RangeError('Interval: precision — целое число > 0');
    }
    return time - (time % precision);
  }

  /** Точки разбиения [start, end] с шагом `precision` (start/end округляются вниз). */
  static getIntervals(start: number, end: number, precision: number): number[] {
    if (start > end) {
      throw new RangeError('Interval: start должен быть <= end');
    }
    start = Interval.roundTime(start, precision);
    end = Interval.roundTime(end, precision);
    const count = Math.max(0, Math.floor((end - start) / precision));
    const out: number[] = new Array(count + 1);
    for (let i = 0; i <= count; i++) out[i] = start + i * precision;
    return out;
  }

  /** Размер интервала, чтобы в [start, end] попало ровно `count` отсчётов. */
  static getIntervalOfFixedCount(start: number, end: number, count: number): number {
    if (!Number.isFinite(count) || count <= 0) return 1;
    let c = Math.floor(Math.abs(start - end) / count);
    if (Number.isNaN(c) || c < 1) c = 1;
    return c;
  }
}
