/** A deterministic size- and age-bounded map for process-lifetime caches. */
export class BoundedTtlMap<K, V> {
  private readonly values = new Map<K, { value: V; touchedAt: number }>();

  constructor(
    readonly maxSize: number,
    readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxSize) || maxSize < 1) throw new Error('maxSize must be positive');
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error('ttlMs must be positive');
  }

  get size(): number {
    this.sweep();
    return this.values.size;
  }

  get(key: K): V | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (this.expired(entry.touchedAt)) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): this {
    this.sweep();
    this.values.delete(key);
    this.values.set(key, { value, touchedAt: this.now() });
    while (this.values.size > this.maxSize) {
      const oldest = this.values.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    return this;
  }

  touch(key: K): boolean {
    const value = this.get(key);
    if (value === undefined) return false;
    this.set(key, value);
    return true;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }

  entries(): Array<[K, V]> {
    this.sweep();
    return [...this.values].map(([key, entry]) => [key, entry.value]);
  }

  sweep(): number {
    let removed = 0;
    for (const [key, entry] of this.values) {
      if (!this.expired(entry.touchedAt)) continue;
      this.values.delete(key);
      removed += 1;
    }
    return removed;
  }

  private expired(touchedAt: number): boolean {
    return this.now() - touchedAt >= this.ttlMs;
  }
}
