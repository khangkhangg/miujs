import { cacheErrors } from "./errors.ts";
import type { CacheKeyInfo, CacheStore } from "./store.ts";

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
  let chars = 0; // total length of stored values, kept in step with `map`

  const drop = (key: string): void => {
    const e = map.get(key);
    if (!e) return;
    chars -= e.value.length;
    map.delete(key);
  };
  const prune = (): void => {
    const t = now();
    for (const [k, e] of map) if (e.exp <= t) drop(k);
  };

  return {
    name: "memory",
    async get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      map.delete(key);
      if (e.exp <= now()) {
        chars -= e.value.length;
        return undefined;
      }
      map.set(key, e); // move to most-recent position
      return e.value;
    },
    async set(key, value, o) {
      drop(key);
      map.set(key, { value, exp: o?.ttl ? now() + o.ttl * 1000 : Infinity });
      chars += value.length;
      if (map.size > maxEntries) drop(map.keys().next().value as string);
    },
    async delete(key) {
      drop(key);
    },
    size() {
      prune();
      return map.size;
    },
    bytes() {
      prune();
      return chars;
    },
    // Keys in sorted order so a cursor (the last key of the page) stays stable while reads
    // reorder the LRU. Costs O(n log n) over at most `maxEntries` keys.
    async scan(q) {
      prune();
      const prefix = q.prefix ?? "";
      const after = q.cursor;
      const keys: string[] = [];
      for (const k of map.keys()) if (k.startsWith(prefix) && (after === undefined || k > after)) keys.push(k);
      keys.sort();
      const page = keys.slice(0, q.limit);
      const out: CacheKeyInfo[] = page.map((key) => {
        const e = map.get(key)!;
        return { key, bytes: e.value.length, expiresAt: e.exp === Infinity ? null : e.exp };
      });
      return keys.length > q.limit ? { keys: out, next: page[page.length - 1] } : { keys: out };
    },
    async clear() {
      prune();
      const n = map.size;
      map.clear();
      chars = 0;
      return n;
    },
    inspect: () => ({ maxEntries }),
  };
}
