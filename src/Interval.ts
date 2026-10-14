// Interval.ts — "interval language", VRackDB-compatible
// (https://github.com/ponikrf/VRackDB), but the base unit is ms.
// Syntax and method names match VRackDB, so existing code carries over.
// No external dependencies.
//
//   '15s' '10m' '1h' '1d' '2w' '3mon' '1y'  — interval (→ ms)
//   'now-1d' 'now+1h' 'now-1h-1m'           — relative point (→ ms)
//   'now-7d:now'                            — period [start, end] (→ ms)

import ErrorManager from './errors/ErrorManager.ts';

/** Time unit → ms (mapping matches VRackDB: mon=30d, y=365d). */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mon: 2_592_000_000, // 30d
  y: 31_536_000_000   // 365d
};

ErrorManager.registerMany('Interval', [
  { short: 'INT_UNIT_UNKNOWN', description: 'Interval: unknown unit (available: ms s m h d w mon y)', rules: { unit: 'string' } },
  { short: 'INT_PARSE', description: 'Interval: invalid interval, examples: 10s, 1m, 1h, 1d' },
  { short: 'INT_RESOLVE', description: 'Interval: resolve — number (ms) or a string like now-1d/1700000000000' },
  { short: 'INT_PERIOD_FORMAT', description: 'Interval: period in "start:end" format, e.g. now-7d:now' },
  { short: 'INT_PERIOD_ARGS', description: 'Interval: period — two bounds (start, end) or a "start:end" string' },
  { short: 'INT_RANGE_ORDER', description: 'Interval: start must be <= end' },
  { short: 'INT_TIME_NOT_INT', description: 'Interval: time must be an integer' },
  { short: 'INT_PRECISION', description: 'Interval: precision — integer > 0' },
]);

export class Interval {

  /** Multiplier from standard JS time (ms) to the base unit (ms). */
  static getFactor(): number {
    return 1;
  }

  /** Current time in ms. */
  static now(): number {
    return Date.now();
  }

  /**
   * Interval string → ms.
   *   '10s' → 10_000, '1m' → 60_000, '1h' → 3_600_000, '1d' → 86_400_000
   *   '900' → 900 (plain number — already ms)
   */
  static parseInterval(ival: string): number {
    const s = String(ival).replace(/\s/g, '');
    const m = s.match(/^(\d+)([a-zA-Z]+)$/);
    if (m) {
      const unit = UNIT_MS[m[2]];
      if (unit === undefined) throw ErrorManager.make('INT_UNIT_UNKNOWN', { unit: m[2] });
      return Math.round(parseInt(m[1], 10) * unit);
    }
    if (!/^\d+$/.test(s)) throw ErrorManager.make('INT_PARSE');
    return parseInt(s, 10);
  }

  /**
   * Relative point / span → ms.
   *   'now-10d' → now − 10d, 'now+1h' → now + 1h, 'now-1h-1m' → now − 1h − 1m
   *   '10d' → 10d, '1700000000000' → same (absolute time)
   * Supports the `+` and `-` operators.
   */
  static partOfPeriod(str: string, now: number = Date.now()): number {
    const s = String(str).replace(/\s/g, '');
    let result = 0;
    let sign = 1;
    for (const token of s.split(/([-+])/)) {
      if (token === '-') { sign = -1; continue; }
      if (token === '+') { sign = 1; continue; }
      if (token === '') continue;
      result +=  this.prepareInterval(token, now) * sign;
    }
    return result;
  }

  protected static prepareInterval(token:string, now:number){
      if (token === 'now') return now;
      if (/^\d+$/.test(token)) return parseInt(token, 10); 
      return Interval.parseInterval(token);
  }


  /** One bound: a number (ms) or an interval string ('now-1d'/'now'/'1700000000000') → ms. Numbers pass through. */
  static resolve(value: number | string, now: number = Date.now()): number {
    const v = typeof value === 'string' ? Interval.partOfPeriod(value, now) : value;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw ErrorManager.make('INT_RESOLVE', { value: String(value) });
    return v;
  }

  /** Period 'start:end' → [start, end] in ms. 'now-7d:now' → [now − 7d, now] */
  static period(period: string, now?: number): [number, number];
  /** Period by two bounds (number ms or 'now-1d'-like strings) → [start, end] in ms. Checks start <= end. */
  static period(start: number | string, end: number | string, now?: number): [number, number];
  static period(a: string | number, b?: number | string, now?: number): [number, number] {
    // Legacy form: (string 'start:end', now?) — no explicit third arg.
    if (
      typeof a === 'string' && now === undefined &&
      (b === undefined || typeof b === 'number')
    ) {
      const parts = String(a).replace(/\s/g, '').split(':');
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
        throw ErrorManager.make('INT_PERIOD_FORMAT', { period: String(a) });
      }
      return Interval._pair(parts[0], parts[1], typeof b === 'number' ? b : Date.now());
    }
    if (b === undefined) throw ErrorManager.make('INT_PERIOD_ARGS');
    return Interval._pair(a, b, now !== undefined ? now : Date.now());
  }

  /** Shared part of period(): resolves bounds and checks start <= end. */
  private static _pair(start: number | string, end: number | string, now: number): [number, number] {
    const s = Interval.resolve(start, now);
    const e = Interval.resolve(end, now);
    if (e < s) throw ErrorManager.make('INT_RANGE_ORDER', { start: s, end: e });
    return [s, e];
  }

  /** Round time down to a multiple of `precision`. */
  static roundTime(time: number, precision: number): number {
    if (!Number.isInteger(time)) throw ErrorManager.make('INT_TIME_NOT_INT', { time });
    if (!Number.isInteger(precision) || precision <= 0) throw ErrorManager.make('INT_PRECISION', { precision });
    return time - (time % precision);
  }

  /** Split points of [start, end] with step `precision` (start/end rounded down). */
  static getIntervals(start: number, end: number, precision: number): number[] {
    if (start > end) {
      throw ErrorManager.make('INT_RANGE_ORDER', { start, end });
    }
    start = Interval.roundTime(start, precision);
    end = Interval.roundTime(end, precision);
    const count = Math.max(0, Math.floor((end - start) / precision));
    const out: number[] = new Array(count + 1);
    for (let i = 0; i <= count; i++) out[i] = start + i * precision;
    return out;
  }

  /** Interval size so that [start, end] contains exactly `count` samples. */
  static getIntervalOfFixedCount(start: number, end: number, count: number): number {
    if (!Number.isFinite(count) || count <= 0) return 1;
    let c = Math.floor(Math.abs(start - end) / count);
    if (Number.isNaN(c) || c < 1) c = 1;
    return c;
  }
}
