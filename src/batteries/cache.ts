import type { Context } from "../core/context.ts";
import type { Middleware } from "../core/app.ts";
import type { Store } from "./store/types.ts";

export interface CacheOptions {
  store: Store;
  /** Seconds to keep a response. */
  ttl: number;
  key?: (c: Context<any, any>) => string | Promise<string>;
  methods?: string[];
  /** Request headers whose values become part of the default key. */
  vary?: string[];
  /** Cache requests that carry an `Authorization` header. Default false. */
  allowAuthorized?: boolean;
}

interface Entry {
  status: number;
  headers: [string, string][];
  body: string;
  base64?: boolean;
}

const TEXT = /^text\/|[/+](json|xml|javascript|ecmascript)|x-www-form-urlencoded|svg/i;

/**
 * Response cache. Stores 200 responses without `Set-Cookie` and without `Cache-Control: no-store|private`,
 * and marks responses with `x-miu-cache: HIT|MISS`. Bodies are buffered, so don't put it in front of streams.
 */
export function cache(opts: CacheOptions): Middleware {
  const methods = (opts.methods ?? ["GET"]).map((m) => m.toUpperCase());
  const vary = (opts.vary ?? []).map((h) => h.toLowerCase());
  const keyOf =
    opts.key ?? ((c: Context<any, any>) => [c.method, c.req.url, ...vary.map((h) => `${h}=${c.req.headers.get(h) ?? ""}`)].join(" "));

  return async (c, next) => {
    if (!methods.includes(c.method)) return next();
    if (!opts.allowAuthorized && c.req.headers.has("authorization")) return next();
    const key = await keyOf(c);

    const hit = await opts.store.get<Entry>(key);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set("x-miu-cache", "HIT");
      const body = hit.base64 ? fromBase64(hit.body) : hit.body;
      return new Response(hit.status === 204 || hit.status === 304 ? null : body, { status: hit.status, headers: h });
    }

    await next();
    const res = c.res;
    const cc = res.headers.get("cache-control") ?? "";
    const storable =
      res.status === 200 &&
      !res.headers.has("set-cookie") &&
      !/\b(no-store|private)\b/i.test(cc) &&
      !(res.headers.get("content-type") ?? "").includes("text/event-stream");

    const headers = new Headers(res.headers);
    headers.set("x-miu-cache", "MISS");
    if (!storable) {
      c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      return;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    c.res = new Response(buf, { status: res.status, statusText: res.statusText, headers });
    const text = TEXT.test(res.headers.get("content-type") ?? "");
    const stored: [string, string][] = [];
    res.headers.forEach((v, k) => stored.push([k, v]));
    const entry: Entry = {
      status: res.status,
      headers: stored,
      body: text ? new TextDecoder().decode(buf) : toBase64(buf),
      ...(text ? {} : { base64: true }),
    };
    await opts.store.set(key, entry, { ttl: opts.ttl });
  };
}

const inflight = new WeakMap<Store, Map<string, Promise<unknown>>>();

/**
 * Return the cached value for `key`, or compute it with `fn`, store it for `ttl` seconds and return it.
 * Concurrent calls for the same store and key share one computation within this process.
 * `undefined` results are not cached.
 */
export function remember<T>(store: Store, key: string, ttl: number, fn: () => T | Promise<T>): Promise<T> {
  let pending = inflight.get(store);
  if (!pending) inflight.set(store, (pending = new Map()));
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const map = pending;
  const p = (async () => {
    try {
      const cached = await store.get<T>(key);
      if (cached !== undefined) return cached;
      const value = await fn();
      if (value !== undefined) await store.set(key, value, { ttl });
      return value;
    } finally {
      map.delete(key);
    }
  })();
  map.set(key, p);
  return p;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
