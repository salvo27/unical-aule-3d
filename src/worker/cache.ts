// Per isolate cache of upstream bodies. Entries never outlive the TTL; oldest inserted are evicted first.
export const TTL_MS = 60_000;

export type Bytes = Uint8Array<ArrayBuffer>;

interface Entry {
  body: Bytes;
  storedAt: number;
}

export interface MemoryCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}

export class MemoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Bytes>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(options: MemoryCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? TTL_MS;
    this.maxEntries = options.maxEntries ?? 64;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  fresh(storedAt: number, now: number): boolean {
    const age = now - storedAt;
    return Number.isFinite(age) && age >= 0 && age < this.ttlMs;
  }

  get(key: string, now: number): Bytes | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.fresh(entry.storedAt, now)) return entry.body;
    this.remove(key);
    return null;
  }

  set(key: string, body: Bytes, storedAt: number): void {
    this.remove(key);
    if (body.byteLength > this.maxBytes) return;
    this.entries.set(key, { body, storedAt });
    this.bytes += body.byteLength;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.remove(oldest);
    }
  }

  // Concurrent misses on one key share a single load; failures are never kept.
  shared(key: string, load: () => Promise<Bytes>): Promise<Bytes> {
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = load().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.body.byteLength;
  }
}
