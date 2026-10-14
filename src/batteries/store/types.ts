/**
 * Key-value store used by sessions, cache, rate limiting and auth.
 * Values are JSON-serializable. TTLs are in seconds.
 * Drivers: memory (dev/tests), SQLite (default), and later Redis / Cloudflare KV / D1 / Durable Objects.
 */
export interface Store {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  /** Atomically add `by` (default 1). `ttl` applies only when the counter is created. */
  incr(key: string, by?: number, opts?: { ttl?: number }): Promise<number>;
  /** Remaining seconds; -1 when the key never expires; undefined when missing. */
  ttl(key: string): Promise<number | undefined>;
  /** A view of this store whose keys are namespaced with `prefix`. */
  prefix(prefix: string): Store;
  close(): Promise<void>;
}

/** Wrap a store so every key is prefixed. Closing a prefixed view is a no-op. */
export function prefixed(store: Store, p: string): Store {
  return {
    get: (k) => store.get(p + k),
    set: (k, v, o) => store.set(p + k, v, o),
    delete: (k) => store.delete(p + k),
    has: (k) => store.has(p + k),
    incr: (k, by, o) => store.incr(p + k, by, o),
    ttl: (k) => store.ttl(p + k),
    prefix: (q) => prefixed(store, p + q),
    close: async () => {},
  };
}

export function remainingSeconds(expires: number | null, now: number): number {
  return expires === null ? -1 : Math.max(0, Math.ceil((expires - now) / 1000));
}
