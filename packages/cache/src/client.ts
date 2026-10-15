import { cacheErrors } from "./errors.ts";
import type { CacheStore } from "./store.ts";

export interface SetOptions {
  /** Seconds until the entry expires. Omit to keep it until evicted or deleted. */
  ttl?: number;
  /** Tags for bulk invalidation with `invalidateTag`. */
  tags?: string[];
}

/** `ctx.cache`. Values must be JSON-serializable; reads return fresh copies. */
export interface CacheClient {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, opts?: SetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Return the cached value, or compute it with `fn`, cache it for `ttlSeconds` and return it.
   * Concurrent callers for the same key share one computation. Errors are not cached.
   */
  remember<T>(key: string, ttlSeconds: number, fn: () => T | Promise<T>): Promise<T>;
  /** Delete every key that was `set` with this tag. */
  invalidateTag(tag: string): Promise<void>;
}

/** Keys starting with this prefix are reserved for tag indexes. */
export const TAG_PREFIX = "__miu:tag:";

interface Shared {
  inflight: Map<string, Promise<unknown>>;
  tagLocks: Map<string, Promise<void>>;
}

// State shared by every client over the same store (in-flight `remember` calls, tag locks).
const shared = new WeakMap<CacheStore, Shared>();

function checkName(what: "key" | "tag", v: unknown): asserts v is string {
  if (typeof v !== "string" || v === "") throw cacheErrors.key(what, v);
}

function checkTtl(ttl: unknown): void {
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) throw cacheErrors.ttl(ttl);
}

function serialize(key: string, value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw cacheErrors.value(key, err);
  }
  if (text === undefined) throw cacheErrors.value(key);
  return text;
}

function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // corrupted or foreign entry: treat as a miss
  }
}

/** A cache client over `store`. Use this outside requests (jobs, scripts); handlers get `ctx.cache`. */
export function createCache(store: CacheStore): CacheClient {
  let state = shared.get(store);
  if (!state) shared.set(store, (state = { inflight: new Map(), tagLocks: new Map() }));
  const { inflight, tagLocks } = state;

  // Serialize read-modify-write of a tag index so concurrent sets don't drop keys.
  // (Within one process. On KV, writes from other isolates can still race: see README.)
  const withTag = (tag: string, fn: () => Promise<void>): Promise<void> => {
    const prev = tagLocks.get(tag) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    tagLocks.set(tag, tail);
    tail.then(() => {
      if (tagLocks.get(tag) === tail) tagLocks.delete(tag);
    });
    return next;
  };

  const readIndex = async (tag: string): Promise<string[]> => {
    const v = parse(await store.get(TAG_PREFIX + tag));
    return Array.isArray(v) ? (v as string[]) : [];
  };

  const set = async (key: string, value: unknown, opts: SetOptions = {}): Promise<void> => {
    checkName("key", key);
    if (opts.ttl !== undefined) checkTtl(opts.ttl);
    for (const tag of opts.tags ?? []) checkName("tag", tag);
    const text = serialize(key, value);
    await store.set(key, text, opts.ttl ? { ttl: opts.ttl } : undefined);
    for (const tag of opts.tags ?? []) {
      await withTag(tag, async () => {
        const keys = await readIndex(tag);
        if (!keys.includes(key)) {
          keys.push(key);
          await store.set(TAG_PREFIX + tag, JSON.stringify(keys));
        }
      });
    }
  };

  return {
    async get<T>(key: string) {
      checkName("key", key);
      return parse(await store.get(key)) as T | undefined;
    },
    set,
    async delete(key) {
      checkName("key", key);
      await store.delete(key);
    },
    remember<T>(key: string, ttlSeconds: number, fn: () => T | Promise<T>): Promise<T> {
      try {
        checkName("key", key);
        checkTtl(ttlSeconds);
      } catch (err) {
        return Promise.reject(err);
      }
      const running = inflight.get(key);
      if (running) return running as Promise<T>;
      const p = (async () => {
        const hit = parse(await store.get(key));
        if (hit !== undefined) return hit as T;
        const value = await fn();
        if (value !== undefined) await set(key, value, { ttl: ttlSeconds });
        return value;
      })();
      inflight.set(key, p);
      const clear = () => {
        if (inflight.get(key) === p) inflight.delete(key);
      };
      p.then(clear, clear);
      return p;
    },
    invalidateTag(tag) {
      try {
        checkName("tag", tag);
      } catch (err) {
        return Promise.reject(err);
      }
      return withTag(tag, async () => {
        const keys = await readIndex(tag);
        await Promise.all(keys.map((k) => store.delete(k)));
        await store.delete(TAG_PREFIX + tag);
      });
    },
  };
}
