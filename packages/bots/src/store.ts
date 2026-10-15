// Where responses served to bots are kept. Pluggable: a bounded in-memory LRU (default), the
// app's @miujs/cache client (`ctx.cache`: KV on Workers, Redis, ...), or the Workers Cache API.

import type { CloudflareNeeds, Context } from "miujs";
import { botsErrors } from "./errors.ts";

type MaybePromise<T> = T | Promise<T>;

/** A response as stored. Times are epoch milliseconds. */
export interface CachedResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
  storedAt: number;
  /** Fresh until. */
  expires: number;
  /** May be served stale (while one request refreshes it) until; equals `expires` without `staleWhileRevalidate`. */
  staleUntil: number;
}

export interface BotCacheStore {
  /** Shown in `miu inspect`. */
  readonly name: string;
  /** `ctx` is the current request (stores over `ctx.cache` or `ctx.env` bindings need it). */
  get(key: string, ctx?: Context): MaybePromise<CachedResponse | undefined>;
  set(key: string, entry: CachedResponse, ctx?: Context): MaybePromise<void>;
  delete?(key: string, ctx?: Context): MaybePromise<void>;
  /** Live entries, when cheap to tell. */
  size?(): number;
  inspect?(): Record<string, unknown>;
  cloudflare?(): CloudflareNeeds;
}

export interface MemoryBotStoreOptions {
  /** Default 1000. */
  maxEntries?: number;
  /** Total bytes of bodies, headers and keys. Default 32 MiB. */
  maxBytes?: number;
  now?: () => number;
}

const posInt = (v: unknown, name: string, fn: string) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw botsErrors.config(`${fn} ${name} must be a positive integer, got ${String(v)}`, `Pass ${name} >= 1, or leave it out for the default.`);
  return v;
};

function sizeOf(key: string, e: CachedResponse): number {
  let n = 64 + key.length * 2 + e.body.byteLength;
  for (const [k, v] of e.headers) n += (k.length + v.length) * 2 + 16;
  return n;
}

/**
 * In-process LRU, bounded by entries and bytes. The default. Each process (each Workers isolate)
 * has its own copy.
 */
export function memoryBotStore(opts: MemoryBotStoreOptions = {}): BotCacheStore {
  const maxEntries = posInt(opts.maxEntries ?? 1000, "maxEntries", "memoryBotStore");
  const maxBytes = posInt(opts.maxBytes ?? 32 * 1024 * 1024, "maxBytes", "memoryBotStore");
  const now = opts.now ?? Date.now;
  const map = new Map<string, { e: CachedResponse; size: number }>();
  let bytes = 0;
  const drop = (key: string) => {
    const x = map.get(key);
    if (x) {
      map.delete(key);
      bytes -= x.size;
    }
  };
  return {
    name: "memory",
    get(key) {
      const x = map.get(key);
      if (!x) return undefined;
      map.delete(key);
      if (x.e.staleUntil <= now()) {
        bytes -= x.size;
        return undefined;
      }
      map.set(key, x);
      return x.e;
    },
    set(key, e) {
      drop(key);
      const size = sizeOf(key, e);
      if (size > maxBytes) return;
      map.set(key, { e, size });
      bytes += size;
      while (map.size > maxEntries || bytes > maxBytes) drop(map.keys().next().value as string);
    },
    delete(key) {
      drop(key);
    },
    size() {
      const t = now();
      for (const [k, x] of map) if (x.e.staleUntil <= t) drop(k);
      return map.size;
    },
    inspect: () => ({ entries: map.size, bytes, maxEntries, maxBytes }),
  };
}

// ---------------------------------------------------------------- @miujs/cache (ctx.cache)

/** The part of @miujs/cache's `CacheClient` used here (structural, so no dependency). */
interface CacheClientLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Stored {
  s: number;
  h: [string, string][];
  b: string;
  t: number;
  e: number;
  st: number;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}

const PREFIX = "miu:bots:";
/** Cloudflare KV keys are at most 512 bytes; longer cache keys are hashed. */
const MAX_KEY = 400;
const storeKey = async (key: string) => PREFIX + (key.length > MAX_KEY ? `h:${await sha256Hex(key)}` : key);

/**
 * Uses the app's `ctx.cache` (list `cache()` from @miujs/cache before `bots()`): Cloudflare KV
 * on Workers when bound as `CACHE`, Redis or memory elsewhere, shared by every isolate or process
 * using the same backend. Bodies are stored base64 in JSON.
 */
export function cacheClientStore(opts: { now?: () => number } = {}): BotCacheStore {
  const now = opts.now ?? Date.now;
  const client = (ctx: Context | undefined): CacheClientLike => {
    const c = (ctx as { cache?: CacheClientLike } | undefined)?.cache;
    if (!c) throw botsErrors.config("bots({ store: cacheClientStore() }) needs ctx.cache, but no plugin set it", "List cache() from @miujs/cache before bots() in miu({ plugins }), or use another store.");
    return c;
  };
  return {
    name: "cache",
    async get(key, ctx) {
      const v = await client(ctx).get<Stored>(await storeKey(key));
      if (!v || typeof v !== "object" || typeof v.b !== "string" || v.st <= now()) return undefined;
      return { status: v.s, headers: v.h, body: fromBase64(v.b), storedAt: v.t, expires: v.e, staleUntil: v.st };
    },
    async set(key, e, ctx) {
      const ttl = Math.ceil((e.staleUntil - now()) / 1000);
      if (ttl <= 0) return;
      const v: Stored = { s: e.status, h: e.headers, b: toBase64(e.body), t: e.storedAt, e: e.expires, st: e.staleUntil };
      // KV keeps entries at least 60 seconds; the stored times still decide freshness.
      await client(ctx).set(await storeKey(key), v, { ttl: Math.max(ttl, 60) });
    },
    async delete(key, ctx) {
      await client(ctx).delete(await storeKey(key));
    },
    inspect: () => ({ backend: "ctx.cache (@miujs/cache)" }),
  };
}

// ---------------------------------------------------------------- Workers Cache API

/** The Cache API surface used (`caches.default` on Workers). */
export interface CacheLike {
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, res: Response): Promise<void>;
  delete?(req: Request | string): Promise<boolean>;
}

const H_STORED = "x-miu-bots-stored";
const H_EXPIRES = "x-miu-bots-expires";
const H_STALE = "x-miu-bots-stale";
const ORIGIN = "https://miujs-bots.invalid/";

/**
 * Cloudflare's Cache API (`caches.default`): free, no binding, per data center. Entries are
 * keyed by a private URL, so they never collide with your own cached pages.
 */
export function cacheApiStore(opts: { cache?: CacheLike; now?: () => number } = {}): BotCacheStore {
  const now = opts.now ?? Date.now;
  const cache = (): CacheLike => {
    const c = opts.cache ?? (globalThis as { caches?: { default?: CacheLike } }).caches?.default;
    if (!c) throw botsErrors.config("cacheApiStore() needs the Cache API (caches.default), which only Cloudflare Workers have", "Use cacheApiStore() on Workers only, or pass { cache } explicitly, or use memoryBotStore() / cacheClientStore().");
    return c;
  };
  const url = async (key: string) => ORIGIN + (await sha256Hex(key));
  return {
    name: "cache-api",
    async get(key) {
      const res = await cache().match(await url(key));
      if (!res) return undefined;
      const staleUntil = Number(res.headers.get(H_STALE));
      if (!(staleUntil > now())) {
        await res.body?.cancel();
        return undefined;
      }
      const headers: [string, string][] = [];
      res.headers.forEach((v, k) => {
        if (k !== "cache-control" && !k.startsWith("x-miu-bots-")) headers.push([k, v]);
      });
      const cc = res.headers.get("x-miu-bots-cc");
      if (cc !== null) headers.push(["cache-control", cc]);
      return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()), storedAt: Number(res.headers.get(H_STORED)), expires: Number(res.headers.get(H_EXPIRES)), staleUntil };
    },
    async set(key, e) {
      const ttl = Math.ceil((e.staleUntil - now()) / 1000);
      if (ttl <= 0) return;
      const h = new Headers();
      for (const [k, v] of e.headers) {
        if (k === "cache-control") h.set("x-miu-bots-cc", v);
        else h.append(k, v);
      }
      h.set("cache-control", `public, max-age=${ttl}`);
      h.set(H_STORED, String(e.storedAt));
      h.set(H_EXPIRES, String(e.expires));
      h.set(H_STALE, String(e.staleUntil));
      await cache().put(await url(key), new Response(e.body as BodyInit, { status: e.status, headers: h }));
    },
    async delete(key) {
      await cache().delete?.(await url(key));
    },
    inspect: () => ({ backend: "caches.default" }),
  };
}
