import { prefixed, remainingSeconds, type Store } from "../../batteries/store/types.ts";
import { resolveBinding, type BindingRef, type KVNamespace, type KVNamespacePutOptions } from "./types.ts";

export interface KvStoreOptions {
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

/** Cloudflare KV refuses `expirationTtl` below this many seconds. */
export const KV_MIN_TTL = 60;

interface Meta {
  /** Absolute expiry in ms, or null for none. */
  expires: number | null;
}

/**
 * Store over Workers KV. Good for read-heavy data such as caches and sessions.
 *
 * - Values are stored as JSON text.
 * - KV's own `expirationTtl` must be at least 60s, so shorter TTLs are rounded up for
 *   KV's garbage collection; the exact expiry is kept in the key's metadata and
 *   enforced on every read, so `get`/`has`/`ttl` still honor TTLs below a minute.
 * - KV is eventually consistent (writes can take ~60s to reach other locations), and
 *   `incr` is a non-atomic read-modify-write: concurrent increments can be lost.
 *   **Do not use KV for rate limiting** — use `d1Store` or `doStore` instead.
 *
 * `kv` may be a getter such as `() => env.CACHE` so the store can be created at module scope.
 */
export function kvStore(kv: BindingRef<KVNamespace>, opts: KvStoreOptions = {}): Store {
  const now = opts.now ?? Date.now;

  const read = async (key: string) => {
    const { value, metadata } = await resolveBinding(kv).getWithMetadata<Meta>(key, "text");
    if (value === null) return undefined;
    const expires = metadata?.expires ?? null;
    if (expires !== null && expires <= now()) return undefined;
    return { value, expires };
  };

  const write = (key: string, value: unknown, expires: number | null) => {
    const options: KVNamespacePutOptions = { metadata: { expires } satisfies Meta };
    if (expires !== null) {
      options.expirationTtl = Math.max(KV_MIN_TTL, Math.ceil((expires - now()) / 1000));
    }
    return resolveBinding(kv).put(key, JSON.stringify(value), options);
  };

  const store: Store = {
    async get<T>(key: string) {
      const e = await read(key);
      return e ? (JSON.parse(e.value) as T) : undefined;
    },
    async set(key, value, o) {
      await write(key, value, o?.ttl ? now() + o.ttl * 1000 : null);
    },
    async delete(key) {
      const existed = (await read(key)) !== undefined;
      await resolveBinding(kv).delete(key);
      return existed;
    },
    async has(key) {
      return (await read(key)) !== undefined;
    },
    /** Not atomic on KV: see the note on {@link kvStore}. */
    async incr(key, by = 1, o) {
      const e = await read(key);
      if (e) {
        const next = Number(JSON.parse(e.value)) + by;
        await write(key, next, e.expires);
        return next;
      }
      await write(key, by, o?.ttl ? now() + o.ttl * 1000 : null);
      return by;
    },
    async ttl(key) {
      const e = await read(key);
      return e ? remainingSeconds(e.expires, now()) : undefined;
    },
    prefix: (p) => prefixed(store, p),
    async close() {},
  };
  return store;
}
