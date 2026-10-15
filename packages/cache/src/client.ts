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

/** A stored tag index: keys, latest expiry (epoch ms, null = some key never expires), size after the last prune. */
interface TagIndex {
  k: string[];
  e: number | null;
  p: number;
}

/** Indexes smaller than this are never pruned. */
const PRUNE_MIN = 32;
/** Seconds a tag index outlives the last expiry it knows of (absorbs clock differences). */
const TAG_INDEX_GRACE = 60;

interface Shared {
  inflight: Map<string, Promise<unknown>>;
  tagLocks: Map<string, Promise<void>>;
  stats: CacheStats;
}

/** Reads through `get`/`remember` in this process, for the admin's status. */
export interface CacheStats {
  hits: number;
  misses: number;
}

// State shared by every client over the same store (in-flight `remember` calls, tag locks, stats).
const shared = new WeakMap<CacheStore, Shared>();

/** Hits and misses counted by clients over `store` in this process (zero before any client exists). */
export function cacheStats(store: CacheStore): CacheStats {
  return { ...(shared.get(store)?.stats ?? { hits: 0, misses: 0 }) };
}

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
  if (!state) shared.set(store, (state = { inflight: new Map(), tagLocks: new Map(), stats: { hits: 0, misses: 0 } }));
  const { inflight, tagLocks, stats } = state;
  const count = <T>(v: T): T => {
    if (v === undefined) stats.misses++;
    else stats.hits++;
    return v;
  };

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

  const readIndex = async (tag: string): Promise<TagIndex> => {
    const v = parse(await store.get(TAG_PREFIX + tag));
    // Older versions stored a plain array of keys (no expiry known: keep it permanent).
    if (Array.isArray(v)) return { k: v.filter((x): x is string => typeof x === "string"), e: null, p: 0 };
    const o = v as Partial<TagIndex> | undefined;
    if (o && typeof o === "object" && Array.isArray(o.k)) {
      return { k: o.k.filter((x): x is string => typeof x === "string"), e: typeof o.e === "number" ? o.e : null, p: typeof o.p === "number" ? o.p : 0 };
    }
    return { k: [], e: 0, p: 0 };
  };

  // Drops keys that no longer exist (expired, deleted, evicted). Run when the index has doubled
  // since the last prune, so it costs O(1) store reads per tagged set, amortized, and an index
  // holds at most about twice the live keys of its tag.
  const prune = async (index: TagIndex): Promise<void> => {
    const alive = await Promise.all(index.k.map(async (k) => (await store.get(k)) !== undefined));
    index.k = index.k.filter((_, i) => alive[i]);
    index.p = index.k.length;
  };

  const set = async (key: string, value: unknown, opts: SetOptions = {}): Promise<void> => {
    checkName("key", key);
    if (opts.ttl !== undefined) checkTtl(opts.ttl);
    for (const tag of opts.tags ?? []) checkName("tag", tag);
    const text = serialize(key, value);
    await store.set(key, text, opts.ttl ? { ttl: opts.ttl } : undefined);
    for (const tag of opts.tags ?? []) {
      await withTag(tag, async () => {
        const index = await readIndex(tag);
        const now = Date.now();
        // An empty index (new, or every key gone) takes this key's expiry; otherwise the latest wins.
        const exp = opts.ttl ? now + opts.ttl * 1000 : null;
        const known = index.k.includes(key);
        if (!known) index.k.push(key);
        if (index.k.length === 1) index.e = exp;
        else if (index.e !== null) index.e = exp === null ? null : Math.max(index.e, exp);
        if (known && index.e === null) return; // nothing changed
        if (!known && index.k.length >= PRUNE_MIN && index.k.length >= 2 * index.p) {
          await prune(index);
          if (!index.k.includes(key)) index.k.push(key);
        }
        // An index whose keys all expire expires (a little) after the last of them, so tags that
        // are never invalidated do not stay in Redis/KV forever.
        const ttl = index.e === null ? undefined : Math.ceil((index.e - now) / 1000) + TAG_INDEX_GRACE;
        await store.set(TAG_PREFIX + tag, JSON.stringify(index), ttl ? { ttl } : undefined);
      });
    }
  };

  return {
    async get<T>(key: string) {
      checkName("key", key);
      return count(parse(await store.get(key))) as T | undefined;
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
        const hit = count(parse(await store.get(key)));
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
        const { k: keys } = await readIndex(tag);
        await Promise.all(keys.map((k) => store.delete(k)));
        await store.delete(TAG_PREFIX + tag);
      });
    },
  };
}
