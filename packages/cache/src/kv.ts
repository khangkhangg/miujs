import type { Env } from "miujs";
import { cacheErrors } from "./errors.ts";
import type { CacheStore } from "./store.ts";

/** The part of Cloudflare's `KVNamespace` this store uses. */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Cloudflare KV rejects `expirationTtl` below 60 seconds. */
export const KV_MIN_TTL = 60;

export function isKVNamespace(v: unknown): v is KVNamespaceLike {
  const o = v as Record<string, unknown> | null;
  return typeof o === "object" && o !== null && typeof o.get === "function" && typeof o.put === "function" && typeof o.delete === "function";
}

function bindingStore(kv: KVNamespaceLike, binding?: string): CacheStore {
  return {
    name: "kv",
    async get(key) {
      return (await kv.get(key)) ?? undefined;
    },
    async set(key, value, opts) {
      // KV's minimum TTL is 60s: shorter TTLs are raised to 60s rather than failing.
      const ttl = opts?.ttl ? Math.max(KV_MIN_TTL, Math.ceil(opts.ttl)) : undefined;
      await kv.put(key, value, ttl ? { expirationTtl: ttl } : undefined);
    },
    async delete(key) {
      await kv.delete(key);
    },
    inspect: () => (binding ? { binding } : {}),
  };
}

/**
 * Cloudflare Workers KV store. Pass the binding itself, or its name (resolved from `ctx.env` on
 * each request). Notes:
 * - TTLs under 60 seconds are clamped to 60 (KV's minimum).
 * - KV is eventually consistent (up to ~60s across locations), so `invalidateTag` and `delete`
 *   may take that long to be seen everywhere, and tag indexes written from two locations at the
 *   same moment can lose a key.
 */
export function kvStore(binding: KVNamespaceLike | string): CacheStore {
  if (typeof binding !== "string") return bindingStore(binding);
  const name = binding;
  const byBinding = new WeakMap<object, CacheStore>();
  const unbound = (): Promise<never> => Promise.reject(cacheErrors.binding(name));
  return {
    name: "kv",
    get: unbound,
    set: unbound,
    delete: unbound,
    forEnv(env: Env) {
      const kv = env[name];
      if (!isKVNamespace(kv)) throw cacheErrors.binding(name);
      let s = byBinding.get(kv);
      if (!s) byBinding.set(kv, (s = bindingStore(kv, name)));
      return s;
    },
    inspect: () => ({ binding: name }),
  };
}
