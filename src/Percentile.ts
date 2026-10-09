// ============================================================
// Percentile.ts — Квантили: точный расчёт по отсортированным значениям
// ============================================================

export class Percentile {
  /** Ключ результата квантили: 0.95 → 'p95', 0.875 → 'p87.5'. */
  static key(q: number): string {
    return 'p' + Math.round(q * 1000) / 10;
  }

  /** Квантиль (linear interpolation, метод numpy 'linear') по отсортированному массиву. */
  static of(sortedVals: number[], q: number): number {
    const n = sortedVals.length;
    if (n === 1) return sortedVals[0];
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sortedVals[lo];
    return sortedVals[lo] + (sortedVals[hi] - sortedVals[lo]) * (pos - lo);
  }
}
