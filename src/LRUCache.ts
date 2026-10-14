// ============================================================
// LRUCache.ts — Простой LRU-кэш на основе Map
// (порядок итерации Map = порядок вставки, переinsert = touch)
// ============================================================

import ErrorManager from './errors/ErrorManager.ts';

ErrorManager.registerMany('LRUCache', [
  { short: 'LRU_MAXSIZE', description: 'LRUCache: maxSize должно быть целым числом >= 1', rules: { maxSize: 'number' } },
]);

export class LRUCache<K, V> {
  readonly maxSize: number;
  private _map = new Map<K, V>();

  constructor(maxSize = 32) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw ErrorManager.make('LRU_MAXSIZE', { maxSize });
    }
    this.maxSize = maxSize;
  }

  get size(): number {
    return this._map.size;
  }

  has(key: K): boolean {
    return this._map.has(key);
  }

  get(key: K): V | undefined {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key)!;
    // Отмечаем как недавно использованный (переносим в конец)
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    while (this._map.size > this.maxSize) {
      const oldest = this._map.keys().next();
      if (oldest.done) break; // недостижимо: size > maxSize гарантирует наличие ключа
      this._map.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
  }
}
