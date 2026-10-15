import { cacheErrors } from "./errors.ts";
import type { CacheStore } from "./store.ts";

export interface MemoryStoreOptions {
  /** Most entries kept before the least recently used one is evicted. Default 1000. */
  maxEntries?: number;
  /** Clock in milliseconds. Tests pass a fake one. Default `Date.now`. */
  now?: () => number;
}

interface Entry {
  value: string;
  /** Expiry time in ms, or Infinity. */
  exp: number;
}

/**
 * In-process LRU store with TTLs. The default on Bun, Deno and Node. Each process (and each
 * Workers isolate) has its own copy, so use `kvStore` when you need a shared cache.
 */
export function memoryStore(opts: MemoryStoreOptions = {}): CacheStore {
  const maxEntries = opts.maxEntries ?? 1000;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw cacheErrors.config(`memoryStore maxEntries must be a positive integer, got ${String(maxEntries)}`, "Pass `maxEntries` >= 1, e.g. memoryStore({ maxEntries: 1000 }).");
  }
  const now = opts.now ?? Date.now;
  const map = new Map<string, Entry>();

  return {
    name: "memory",
    async get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      map.delete(key);
      if (e.exp <= now()) return undefined;
      map.set(key, e); // move to most-recent position
      return e.value;
    },
    async set(key, value, o) {
      map.delete(key);
      map.set(key, { value, exp: o?.ttl ? now() + o.ttl * 1000 : Infinity });
      if (map.size > maxEntries) map.delete(map.keys().next().value as string);
    },
    async delete(key) {
      map.delete(key);
    },
    size() {
      const t = now();
      for (const [k, e] of map) if (e.exp <= t) map.delete(k);
      return map.size;
    },
    inspect: () => ({ maxEntries }),
  };
}
