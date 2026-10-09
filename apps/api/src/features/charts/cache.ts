/** A small LRU of rendered thumbnails, bounded by entry count and total bytes. */
export class ThumbnailCache<V extends { bytes: { length: number } }> {
  private readonly entries = new Map<string, V>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 200,
    private readonly maxBytes = 48 * 1024 * 1024,
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
    if (old) this.bytes -= old.bytes.length;
    this.entries.delete(key);
    this.entries.set(key, value);
    this.bytes += value.bytes.length;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      if (oldest === key) continue;
      this.entries.delete(oldest);
      this.bytes -= entry.bytes.length;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
