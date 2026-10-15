import { definePlugin, type CloudflareNeeds, type Context, type Env } from "miujs";
import { createCache, type CacheClient } from "./client.ts";
import { isKVNamespace, kvStore } from "./kv.ts";
import { cacheManage } from "./manage.ts";
import { memoryStore } from "./memory.ts";
import type { CacheStore } from "./store.ts";

declare module "miujs" {
  interface Context {
    /** Key/value cache from `@miujs/cache`. */
    cache: CacheClient;
  }
}

export interface CacheOptions {
  /**
   * Where entries live. Default: an in-memory LRU (1000 entries); on Cloudflare Workers, the
   * KV namespace bound as `CACHE` when it exists.
   */
  store?: CacheStore;
}

/** The KV binding name used automatically on Workers when no store is configured. */
export const DEFAULT_KV_BINDING = "CACHE";

const clients = new WeakMap<CacheStore, CacheClient>();
function clientFor(store: CacheStore): CacheClient {
  let c = clients.get(store);
  if (!c) clients.set(store, (c = createCache(store)));
  return c;
}

/** A client that resolves its store on first use, so a missing binding only fails cache users. */
function lazyClient(resolve: () => CacheStore): CacheClient {
  let c: CacheClient | undefined;
  const get = () => (c ??= clientFor(resolve()));
  return {
    get: (key) => Promise.resolve().then(() => get().get(key)),
    set: (key, value, opts) => Promise.resolve().then(() => get().set(key, value, opts)),
    delete: (key) => Promise.resolve().then(() => get().delete(key)),
    remember: (key, ttl, fn) => Promise.resolve().then(() => get().remember(key, ttl, fn)),
    invalidateTag: (tag) => Promise.resolve().then(() => get().invalidateTag(tag)),
  };
}

/**
 * Adds `ctx.cache`.
 *
 * ```ts
 * miu({ plugins: [cache()] })                          // memory locally, KV `CACHE` on Workers
 * miu({ plugins: [cache({ store: kvStore("MY_KV") })] })
 * ```
 */
export function cache(opts: CacheOptions = {}) {
  const configured = opts.store;
  const fallback = configured ?? memoryStore();
  const kvByBinding = new WeakMap<object, CacheStore>();

  const storeFor = (env: Env, runtime: string): CacheStore => {
    if (configured) return configured;
    const kv = runtime === "workerd" ? env[DEFAULT_KV_BINDING] : undefined;
    if (!isKVNamespace(kv)) return fallback;
    let s = kvByBinding.get(kv);
    if (!s) kvByBinding.set(kv, (s = kvStore(kv)));
    return s;
  };

  return definePlugin({
    name: "cache",
    onRequest(ctx: Context) {
      const store = storeFor(ctx.env, ctx.runtime);
      ctx.cache = store.forEnv ? lazyClient(() => store.forEnv!(ctx.env)) : clientFor(store);
    },
    inspect() {
      const info: Record<string, unknown> = { adapter: fallback.name };
      if (fallback.size) info.size = fallback.size();
      Object.assign(info, fallback.inspect?.());
      if (!configured) info.workers = `uses the KV binding env.${DEFAULT_KV_BINDING} when present`;
      return info;
    },
    manage() {
      return cacheManage((ctx) => {
        const store = storeFor(ctx.env, ctx.runtime);
        return store.forEnv ? store.forEnv(ctx.env) : store;
      });
    },
    cloudflare(): CloudflareNeeds {
      // The default store on Workers is the KV namespace CACHE: declare it, or every isolate would
      // silently cache in its own memory.
      if (!configured) return { kv: [DEFAULT_KV_BINDING] };
      const binding = configured.forEnv ? configured.inspect?.().binding : undefined;
      return typeof binding === "string" ? { kv: [binding] } : {};
    },
  });
}
