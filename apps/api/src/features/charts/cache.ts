/** A small LRU of rendered thumbnails, bounded by entry count and total size (as `sizeOf` counts it). */
export class ThumbnailCache<V> {
  private readonly entries = new Map<string, V>();
  private total = 0;

  constructor(
    private readonly sizeOf: (value: V) => number,
    private readonly maxEntries = 200,
    private readonly maxSize = 48 * 1024 * 1024,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: V): void {
    const old = this.entries.get(key);
    if (old) this.total -= this.sizeOf(old);
    this.entries.delete(key);
    this.entries.set(key, value);
    this.total += this.sizeOf(value);
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxSize) break;
      if (oldest === key) continue;
      this.entries.delete(oldest);
      this.total -= this.sizeOf(entry);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** The summed size of what is held. */
  get bytes(): number {
    return this.total;
  }
}
